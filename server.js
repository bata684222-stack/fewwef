// WorkshopAG v5 — тот же API, но с постоянным хранилищем (файл / Postgres / Key Value)
// npm i express cors bcryptjs jsonwebtoken multer helmet express-rate-limit compression pg redis
'use strict';
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { store, DB_FILE, UP_DIR, DATA_DIR, MOUNT, mimeOf } = require('./store');

// ───────────────────────── конфиг ─────────────────────────
const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || false; // false = только тот же origin
const BCRYPT_COST = 10;
const IMG_MAX = 5 * 1024 * 1024;
const JSON_MAX = 2 * 1024 * 1024;
const NAME_RE = /^[\p{L}\p{N}_\-. ]{2,20}$/u;

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (PROD) { console.error('JWT_SECRET обязателен в production'); process.exit(1); }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[dev] временный JWT_SECRET — токены сбросятся после перезапуска');
}

const PUBLIC_DIR = path.join(__dirname, 'public');

// ───────────────────────── ошибки ─────────────────────────
class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new HttpError(status, code); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ───────────────────────── база ─────────────────────────
// Формат: { users:[], posts:[], comments:[], votes:{ "postId:userId": 1|-1 },
//   threads:[], treplies:[], dms:[] }
function emptyDB() { return { users: [], posts: [], comments: [], votes: {}, threads: [], treplies: [], dms: [] }; }

function parseDB(raw) {
  const db = typeof raw === 'string' ? JSON.parse(raw) : raw;
  db.users = db.users || []; db.posts = db.posts || []; db.comments = db.comments || [];
  db.threads = db.threads || []; db.treplies = db.treplies || []; db.dms = db.dms || [];
  if (Array.isArray(db.votes)) { // миграция со старого формата (массив)
    const m = {};
    for (const v of db.votes) m[v.postId + ':' + v.userId] = v.value;
    db.votes = m;
  } else db.votes = db.votes || {};
  return db;
}

// читаем из постоянного хранилища; если там пусто — пробуем забрать локальный db.json
async function loadDB() {
  let loaded = null;
  try { loaded = await store.load(); }
  catch (e) { console.error('[store] не смог прочитать:', e.message); }
  if (loaded) {
    try { return parseDB(loaded); }
    catch (e) { console.error('[store] данные повреждены:', e.message); }
  }
  try { // миграция с диска (первый запуск с DATABASE_URL)
    const raw = await fsp.readFile(DB_FILE, 'utf8');
    const db = parseDB(raw);
    const moved = await store.migrateFilesFromDisk();
    await store.save(db);
    console.log('[store] перенёс с диска: юзеров ' + db.users.length + ', постов ' + db.posts.length + ', файлов ' + moved);
    return db;
  } catch (_) { return emptyDB(); }
}

let db = emptyDB(); // заполняется в boot()

// индексы в памяти: поиск O(1) вместо filter/find по массивам на каждый запрос
const usersById = new Map();
const usersByName = new Map(); // lower-case имя -> user
const postsById = new Map();
const threadsById = new Map();
const stats = new Map();       // postId -> { l, d, c }

const st = id => { let s = stats.get(id); if (!s) { s = { l: 0, d: 0, c: 0 }; stats.set(id, s); } return s; };
function rebuildIndexes() {
  usersById.clear(); usersByName.clear(); postsById.clear(); stats.clear();
  for (const u of db.users) { usersById.set(u.id, u); usersByName.set(u.name.toLowerCase(), u); }
  for (const p of db.posts) postsById.set(p.id, p);
  for (const t of db.threads) threadsById.set(t.id, t);
  for (const [k, v] of Object.entries(db.votes)) {
    const s = st(k.split(':')[0]);
    if (v === 1) s.l++; else if (v === -1) s.d++;
  }
  for (const c of db.comments) st(c.postId).c++;
}

// сохранение: дебаунс + очередь, ошибки не теряем (повторяем)
let saveTimer = null, saving = false;
function saveDB() { if (!saveTimer) saveTimer = setTimeout(flushDB, 250); }
async function flushDB() {
  saveTimer = null;
  if (saving) { saveTimer = setTimeout(flushDB, 250); return; }
  saving = true;
  try { await store.save(db); }
  catch (e) {
    console.error('Ошибка сохранения БД:', e.message);
    saveTimer = setTimeout(flushDB, 3000); // повторить
  } finally { saving = false; }
}
function flushDBSync() { // на выходе: синхронно нельзя (async-хранилище), просто помечаем
  if (store.kind === 'file') {
    try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }
    catch (e) { console.error('Не удалось сохранить при выходе:', e.message); }
  }
}

const uid = () => crypto.randomUUID();
const DUMMY_HASH = bcrypt.hashSync('dummy-password', BCRYPT_COST); // против тайминг-атаки на логин

// ───────────────────────── файлы ─────────────────────────
// При DATABASE_URL/REDIS_URL файлы живут в базе (диск обнуляется при деплое),
// при их отсутствии — на диске. multer работает в памяти, дальше кладём в store.
const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter(_r, f, cb) {
    if (f.fieldname === 'photo' || f.fieldname === 'avatar') {
      return MIME_EXT[f.mimetype] ? cb(null, true) : cb(new HttpError(400, 'only_images'));
    }
    if (f.fieldname === 'jsonfile') {
      return (f.mimetype === 'application/json' || /\.json$/i.test(f.originalname || ''))
        ? cb(null, true) : cb(new HttpError(400, 'only_json'));
    }
    cb(null, false);
  },
  limits: { fileSize: IMG_MAX, files: 2, fields: 10 }
});

function sniffImage(b) { // проверка по сигнатуре, а не по заявленному mimetype
  if (b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return '.jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return '.png';
  const h6 = b.toString('ascii', 0, 6);
  if (h6 === 'GIF87a' || h6 === 'GIF89a') return '.gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}
async function readHead(buf) { return buf; }

const collectFiles = req => [
  ...(req.file ? [req.file] : []),
  ...Object.values(req.files || {}).flat()
];
// rel вида 'uploads/<name>' → достаём имя и удаляем из хранилища
function fileName(rel) {
  if (!rel || typeof rel !== 'string') return null;
  const base = path.basename(rel);
  return base && base !== '.' && base !== '..' ? base : null;
}
function safeUnlink(rel) {
  const n = fileName(rel);
  if (n) store.delFile(n).catch(() => {});
}
// кладём файл в хранилище (storedName — это уже проверенное расширение '.png'/'.jpg'/'.json')
async function persistUpload(f) {
  const ext = /^\.(png|jpg|jpeg|webp|gif|json)$/i.test(f.storedName || '') ? f.storedName.toLowerCase() : '.bin';
  const name = await store.putFile(ext, f.buffer);
  f.storedName = name;
  return name;
}
async function validateUploads(req) {
  for (const f of collectFiles(req)) {
    if (f.fieldname === 'jsonfile') {
      if (f.size > JSON_MAX) fail(400, 'file_too_big');
      try { JSON.parse(f.buffer.toString('utf8')); } catch (_) { fail(400, 'bad_json'); }
      f.storedName = '.json';
    } else {
      const ext = sniffImage(f.buffer);          // по сигнатуре, не по заявленному mimetype
      if (!ext) fail(400, 'only_images');
      f.storedName = ext;
    }
  }
}
// middleware: загрузка + валидация; при любой ошибке дальше файлы чистит error-handler
const withUploads = mw => [mw, wrap(async (req, _res, next) => { await validateUploads(req); next(); })];

// ───────────────────────── app ─────────────────────────
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'same-origin' }
}));
app.use(compression());
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '50kb' }));

// лимиты запросов
const limiter = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests' } });
app.use('/api/', limiter(60e3, 300));
const authLimiter = limiter(15 * 60e3, 30);
const writeLimiter = limiter(60e3, 60);

// загрузки: из хранилища (или с диска в режиме 'file'), имена неизменяемы → можно кэшировать вечно
app.get('/uploads/:name', wrap(async (req, res) => {
  const name = fileName(req.params.name);
  if (!name) return res.status(404).end();
  const buf = await store.getFile(name);
  if (!buf) return res.status(404).end();
  res.set('Content-Type', mimeOf(name));
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('Content-Disposition', mimeOf(name) === 'application/json' ? 'inline' : 'inline');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(buf);
}));
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html', dotfiles: 'deny' }));

// ───────────────────────── auth ─────────────────────────
const signToken = u => jwt.sign({ id: u.id, tv: u.tv || 0 }, JWT_SECRET, { expiresIn: '30d' });

function authOpt(req, _res, next) {
  req.user = null;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(h.slice(7), JWT_SECRET);
      const u = usersById.get(p.id);
      // токен недействителен, если юзер удалён или сменил пароль
      if (u && (p.tv || 0) === (u.tv || 0)) req.user = u;
    } catch (_) {}
  }
  next();
}
function authNeed(req, res, next) {
  authOpt(req, res, () => req.user ? next() : res.status(401).json({ error: 'need_auth' }));
}

const pubUser = u => ({ id: u.id, name: u.name, avatar: u.avatar || null, createdAt: u.createdAt });
function postDTO(p, viewerId) {
  const s = stats.get(p.id) || { l: 0, d: 0, c: 0 };
  const a = usersById.get(p.authorId);
  return {
    ...p,
    author: a ? a.name : p.author,           // всегда актуальные ник/аватар
    avatar: a ? a.avatar || null : null,
    likes: s.l, dislikes: s.d, comments: s.c,
    myVote: viewerId ? (db.votes[p.id + ':' + viewerId] || 0) : 0
  };
}
const commentDTO = c => ({ ...c, author: usersById.get(c.authorId)?.name || c.author });
const clampInt = (v, def, min, max) => { v = parseInt(v, 10); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def; };

// ───────────────────────── регистрация / вход ─────────────────────────
app.post('/api/register', authLimiter, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  if (name.length < 2) fail(400, 'short_name');
  if (!NAME_RE.test(name)) fail(400, 'bad_name');
  if (password.length < 4) fail(400, 'short_pass');
  if (password.length > 72) fail(400, 'long_pass'); // лимит bcrypt
  if (usersByName.has(name.toLowerCase())) fail(409, 'name_taken');
  const pass = await bcrypt.hash(password, BCRYPT_COST);
  if (usersByName.has(name.toLowerCase())) fail(409, 'name_taken'); // гонка во время await
  const u = { id: uid(), name, pass, avatar: null, tv: 0, createdAt: Date.now() };
  db.users.push(u); usersById.set(u.id, u); usersByName.set(name.toLowerCase(), u);
  saveDB();
  res.json({ token: signToken(u), user: pubUser(u) });
}));

app.post('/api/login', authLimiter, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().toLowerCase();
  const password = String(req.body?.password || '').slice(0, 72);
  const u = usersByName.get(name);
  const ok = await bcrypt.compare(password, u ? u.pass : DUMMY_HASH); // время одинаково с/без юзера
  if (!u || !ok) fail(401, 'bad_login');
  res.json({ token: signToken(u), user: pubUser(u) });
}));

app.get('/api/me', authOpt, (req, res) => {
  const u = req.user;
  if (!u) return res.json({ user: null });
  let mine = 0; for (const p of db.posts) if (p.authorId === u.id) mine++;
  res.json({ user: { ...pubUser(u), posts: mine } });
});

app.patch('/api/me', authNeed, writeLimiter, ...withUploads(upload.single('avatar')), wrap(async (req, res) => {
  const u = req.user;
  const oldKey = u.name.toLowerCase();
  let name = u.name;
  if (req.body?.name !== undefined) {
    name = String(req.body.name).trim();
    if (name.length < 2) fail(400, 'short_name');
    if (name.toLowerCase() !== oldKey) {
      if (!NAME_RE.test(name)) fail(400, 'bad_name');
      if (usersByName.has(name.toLowerCase())) fail(409, 'name_taken');
    }
  }
  let newPass = null;
  if (req.body?.password) {
    const pw = String(req.body.password);
    if (pw.length < 4) fail(400, 'short_pass');
    if (pw.length > 72) fail(400, 'long_pass');
    newPass = await bcrypt.hash(pw, BCRYPT_COST);
  }
  if (name.toLowerCase() !== oldKey) {
    usersByName.delete(oldKey); usersByName.set(name.toLowerCase(), u);
  }
  u.name = name;
  if (newPass) { u.pass = newPass; u.tv = (u.tv || 0) + 1; } // старые токены умирают
  if (req.file) {
    const nm = await persistUpload(req.file);
    safeUnlink(u.avatar); // старый аватар
    u.avatar = 'uploads/' + nm;
  }
  saveDB();
  res.json({ token: signToken(u), user: pubUser(u) });
}));

app.delete('/api/me', authNeed, writeLimiter, (req, res) => {
  const u = req.user;
  const myPosts = db.posts.filter(p => p.authorId === u.id);
  const ids = new Set(myPosts.map(p => p.id));
  for (const p of myPosts) { safeUnlink(p.photo); safeUnlink(p.jsonUrl); postsById.delete(p.id); }
  safeUnlink(u.avatar);
  db.posts = db.posts.filter(p => p.authorId !== u.id);
  db.comments = db.comments.filter(c => c.authorId !== u.id && !ids.has(c.postId));
  for (const k of Object.keys(db.votes)) {
    const [pid, vu] = k.split(':');
    if (vu === u.id || ids.has(pid)) delete db.votes[k];
  }
  // форумы и личка уходящего тоже стираются
  const myThreads = new Set(db.threads.filter(t => t.authorId === u.id).map(t => t.id));
  db.threads = db.threads.filter(t => t.authorId !== u.id);
  db.treplies = db.treplies.filter(r => r.authorId !== u.id && !myThreads.has(r.threadId));
  db.dms = db.dms.filter(m => m.fromId !== u.id && m.toId !== u.id);
  for (const id of myThreads) threadsById.delete(id);
  db.users = db.users.filter(x => x.id !== u.id);
  usersById.delete(u.id); usersByName.delete(u.name.toLowerCase());
  rebuildIndexes(); saveDB();
  res.json({ ok: true });
});

app.get('/api/me/posts', authNeed, (req, res) => {
  res.json(db.posts.filter(p => p.authorId === req.user.id).map(p => postDTO(p, req.user.id)));
});

// ───────────────────────── посты ─────────────────────────
// ?limit=1..50 (по умолч. 50) &offset=N ; общее число — в заголовке X-Total-Count
app.get('/api/posts', authOpt, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  const kind = String(req.query.kind || 'all');
  const sort = String(req.query.sort || 'new');
  const limit = clampInt(req.query.limit, 50, 1, 50);
  const offset = clampInt(req.query.offset, 0, 0, 1e6);

  let list = db.posts;
  if (kind === 'proj' || kind === 'build') list = list.filter(p => p.kind === kind);
  if (q) list = list.filter(p => (p.title + ' ' + (p.body || '')).toLowerCase().includes(q));
  else if (list === db.posts) list = list.slice();

  if (sort === 'top') {
    const score = p => { const s = stats.get(p.id); return s ? s.l - s.d : 0; };
    list.sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt);
  } else list.sort((a, b) => b.createdAt - a.createdAt);

  res.set('X-Total-Count', String(list.length));
  res.json(list.slice(offset, offset + limit).map(p => postDTO(p, req.user?.id))); // DTO только для нужной страницы
});

app.post('/api/posts', authNeed, writeLimiter,
  ...withUploads(upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'jsonfile', maxCount: 1 }])),
  wrap(async (req, res) => {
    const title = String(req.body?.title || '').trim().slice(0, 80);
    const body = String(req.body?.body || '').trim().slice(0, 2000);
    const kind = req.body?.kind === 'build' ? 'build' : 'proj';
    if (title.length < 2) fail(400, 'short_title');
    const ph = req.files?.photo?.[0], js = req.files?.jsonfile?.[0];
    const u = req.user;
    const photoName = ph ? await persistUpload(ph) : null;
    const jsonName = js ? await persistUpload(js) : null;
    const p = {
      id: uid(), title, body, kind,
      photo: photoName ? 'uploads/' + photoName : null,
      jsonUrl: jsonName ? 'uploads/' + jsonName : null,
      jsonName: js ? String(js.originalname || 'file.json').slice(0, 80) : null,
      author: u.name, authorId: u.id, avatar: u.avatar || null, createdAt: Date.now()
    };
    db.posts.unshift(p); postsById.set(p.id, p); saveDB();
    res.json(postDTO(p, u.id));
  }));

app.delete('/api/posts/:id', authNeed, writeLimiter, (req, res) => {
  const p = postsById.get(req.params.id);
  if (!p) fail(404, 'not_found');
  if (p.authorId !== req.user.id) fail(403, 'not_yours');
  safeUnlink(p.photo); safeUnlink(p.jsonUrl);
  db.posts = db.posts.filter(x => x.id !== p.id);
  db.comments = db.comments.filter(c => c.postId !== p.id);
  for (const k of Object.keys(db.votes)) if (k.startsWith(p.id + ':')) delete db.votes[k];
  postsById.delete(p.id); stats.delete(p.id);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/posts/:id/vote', authNeed, writeLimiter, (req, res) => {
  const p = postsById.get(req.params.id);
  if (!p) fail(404, 'not_found');
  let v = Number(req.body?.value);
  v = v >= 1 ? 1 : v <= -1 ? -1 : 0;
  const key = p.id + ':' + req.user.id;
  const prev = db.votes[key] || 0;
  if (prev !== v) { // счётчики обновляются инкрементально, без пересчёта всех голосов
    const s = st(p.id);
    if (prev === 1) s.l--; else if (prev === -1) s.d--;
    if (v === 1) s.l++; else if (v === -1) s.d++;
    if (v === 0) delete db.votes[key]; else db.votes[key] = v;
    saveDB();
  }
  res.json(postDTO(p, req.user.id));
});

// ───────────────────────── комментарии ─────────────────────────
app.get('/api/posts/:id/comments', (req, res) => {
  if (!postsById.has(req.params.id)) fail(404, 'not_found');
  const list = db.comments.filter(c => c.postId === req.params.id).sort((a, b) => a.createdAt - b.createdAt);
  res.json(list.slice(-300).map(commentDTO));
});

app.post('/api/posts/:id/comments', authNeed, writeLimiter, (req, res) => {
  const p = postsById.get(req.params.id);
  if (!p) fail(404, 'not_found');
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!text) fail(400, 'empty');
  const c = { id: uid(), postId: p.id, author: req.user.name, authorId: req.user.id, text, createdAt: Date.now() };
  db.comments.push(c); st(p.id).c++; saveDB();
  res.json(c);
});

app.delete('/api/comments/:id', authNeed, writeLimiter, (req, res) => {
  const c = db.comments.find(x => x.id === req.params.id);
  if (!c) fail(404, 'not_found');
  if (c.authorId !== req.user.id) fail(403, 'not_yours');
  db.comments = db.comments.filter(x => x.id !== c.id);
  const s = stats.get(c.postId); if (s && s.c > 0) s.c--;
  saveDB();
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({
  ok: true, posts: db.posts.length, users: db.users.length,
  uptime: Math.round(process.uptime()),
  storage: { kind: store.kind, source: store.source, mount: MOUNT || null, dataDir: DATA_DIR }
}));

// ───────────────────────── форумы ─────────────────────────
const FORUM_CATS = [
  { id: 'general', name: 'Общее' },
  { id: 'proj', name: 'Снаряды' },
  { id: 'build', name: 'Постройки' },
  { id: 'help', name: 'Помощь' }
];
const catName = id => FORUM_CATS.find(c => c.id === id)?.name || 'Общее';
function threadDTO(t, viewerId) {
  const a = usersById.get(t.authorId);
  let replies = 0;
  for (const r of db.treplies) if (r.threadId === t.id) replies++;
  return {
    id: t.id, cat: t.cat, catName: catName(t.cat), title: t.title, body: t.body,
    author: a ? a.name : t.author, avatar: a ? a.avatar || null : null,
    authorId: t.authorId, createdAt: t.createdAt, lastAt: t.lastAt || t.createdAt,
    replies, my: !!viewerId && t.authorId === viewerId
  };
}
app.get('/api/forums', (_req, res) => {
  res.json(FORUM_CATS.map(c => {
    let threads = 0, replies = 0, lastAt = 0;
    for (const t of db.threads) if (t.cat === c.id) { threads++; lastAt = Math.max(lastAt, t.lastAt || t.createdAt); }
    for (const r of db.treplies) { const t = threadsById.get(r.threadId); if (t && t.cat === c.id) replies++; }
    return { ...c, threads, replies, lastAt };
  }));
});
app.get('/api/threads', authOpt, (req, res) => {
  const cat = String(req.query.cat || 'all');
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  const sort = String(req.query.sort || 'active');
  const limit = clampInt(req.query.limit, 50, 1, 50);
  const offset = clampInt(req.query.offset, 0, 0, 1e6);
  let list = db.threads.slice();
  if (cat !== 'all') list = list.filter(t => t.cat === cat);
  if (q) list = list.filter(t => (t.title + ' ' + (t.body || '')).toLowerCase().includes(q));
  if (sort === 'new') list.sort((a, b) => b.createdAt - a.createdAt);
  else list.sort((a, b) => (b.lastAt || b.createdAt) - (a.lastAt || a.createdAt));
  res.set('X-Total-Count', String(list.length));
  res.json(list.slice(offset, offset + limit).map(t => threadDTO(t, req.user?.id)));
});
app.post('/api/threads', authNeed, writeLimiter, (req, res) => {
  const cat = FORUM_CATS.find(c => c.id === req.body?.cat) ? req.body.cat : 'general';
  const title = String(req.body?.title || '').trim().slice(0, 80);
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (title.length < 2) fail(400, 'short_title');
  const t = { id: uid(), cat, title, body, author: req.user.name, authorId: req.user.id, createdAt: Date.now(), lastAt: Date.now() };
  db.threads.unshift(t); threadsById.set(t.id, t); saveDB();
  res.json(threadDTO(t, req.user.id));
});
app.get('/api/threads/:id', authOpt, (req, res) => {
  const t = threadsById.get(req.params.id);
  if (!t) fail(404, 'not_found');
  const replies = db.treplies.filter(r => r.threadId === t.id).sort((a, b) => a.createdAt - b.createdAt)
    .map(r => ({ ...r, author: usersById.get(r.authorId)?.name || r.author }));
  res.json({ thread: threadDTO(t, req.user?.id), replies });
});
app.post('/api/threads/:id/replies', authNeed, writeLimiter, (req, res) => {
  const t = threadsById.get(req.params.id);
  if (!t) fail(404, 'not_found');
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) fail(400, 'empty');
  const r = { id: uid(), threadId: t.id, author: req.user.name, authorId: req.user.id, text, createdAt: Date.now() };
  db.treplies.push(r); t.lastAt = Date.now(); saveDB();
  res.json({ ...r, author: req.user.name });
});
app.delete('/api/threads/:id', authNeed, writeLimiter, (req, res) => {
  const t = threadsById.get(req.params.id);
  if (!t) fail(404, 'not_found');
  if (t.authorId !== req.user.id) fail(403, 'not_yours');
  db.threads = db.threads.filter(x => x.id !== t.id);
  db.treplies = db.treplies.filter(r => r.threadId !== t.id);
  threadsById.delete(t.id); saveDB();
  res.json({ ok: true });
});
app.delete('/api/treplies/:id', authNeed, writeLimiter, (req, res) => {
  const r = db.treplies.find(x => x.id === req.params.id);
  if (!r) fail(404, 'not_found');
  if (r.authorId !== req.user.id) fail(403, 'not_yours');
  db.treplies = db.treplies.filter(x => x.id !== r.id); saveDB();
  res.json({ ok: true });
});

// ───────────────────────── личка ─────────────────────────
const dmDTO = (m, selfId) => {
  const peerId = m.fromId === selfId ? m.toId : m.fromId;
  const peer = usersById.get(peerId);
  return { ...m, peer: peer ? { id: peer.id, name: peer.name, avatar: peer.avatar || null } : { id: peerId, name: 'Удалён', avatar: null } };
};
app.get('/api/users', authNeed, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 20);
  const limit = clampInt(req.query.limit, 20, 1, 20);
  let list = db.users.filter(u => u.id !== req.user.id);
  if (q) list = list.filter(u => u.name.toLowerCase().includes(q));
  list = list.slice(0, limit).map(u => ({ id: u.id, name: u.name, avatar: u.avatar || null }));
  res.json(list);
});
app.get('/api/dm/unread', authNeed, (req, res) => {
  let n = 0;
  for (const m of db.dms) if (m.toId === req.user.id && !m.read) n++;
  res.json({ unread: n });
});
app.get('/api/dm', authNeed, (req, res) => {
  const self = req.user.id, conv = new Map();
  for (const m of db.dms) {
    if (m.fromId !== self && m.toId !== self) continue;
    const peerId = m.fromId === self ? m.toId : m.fromId;
    const cur = conv.get(peerId);
    if (!cur || m.createdAt >= cur.lastAt) {
      conv.set(peerId, { peerId, lastText: m.text, lastAt: m.createdAt, unread: (cur?.unread || 0) + (m.toId === self && !m.read ? 1 : 0) });
    } else if (m.toId === self && !m.read) cur.unread++;
  }
  const list = [...conv.values()].map(c => {
    const peer = usersById.get(c.peerId);
    return { user: peer ? { id: peer.id, name: peer.name, avatar: peer.avatar || null } : { id: c.peerId, name: 'Удалён', avatar: null }, lastText: c.lastText, lastAt: c.lastAt, unread: c.unread };
  }).sort((a, b) => b.lastAt - a.lastAt);
  res.json(list);
});
app.get('/api/dm/:uid', authNeed, (req, res) => {
  const self = req.user.id, peer = req.params.uid;
  if (peer === self) fail(400, 'bad_request');
  const list = db.dms.filter(m => (m.fromId === self && m.toId === peer) || (m.fromId === peer && m.toId === self))
    .sort((a, b) => a.createdAt - b.createdAt).slice(-300);
  let touched = false;
  for (const m of list) if (m.toId === self && !m.read) { m.read = true; touched = true; }
  if (touched) saveDB();
  res.json(list.map(m => dmDTO(m, self)));
});
app.post('/api/dm/:uid', authNeed, writeLimiter, (req, res) => {
  const self = req.user.id, peer = req.params.uid;
  if (peer === self) fail(400, 'bad_request');
  if (!usersById.has(peer)) fail(404, 'not_found');
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) fail(400, 'empty');
  const m = { id: uid(), fromId: self, toId: peer, text, createdAt: Date.now(), read: false };
  db.dms.push(m); saveDB();
  res.json(dmDTO(m, self));
});

// ───────────────────────── fallback и ошибки ─────────────────────────
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
// SPA: отдаём index.html только для «страниц», а не для отсутствующих картинок/файлов
app.use((req, res, next) => {
  if (req.method !== 'GET' || path.extname(req.path)) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.use((_req, res) => res.status(404).end());

app.use((err, req, res, _next) => {
  // убираем «осиротевшие» загрузки при любой ошибке
  for (const f of collectFiles(req)) if (f.storedName) store.delFile(f.storedName).catch(() => {});
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code });
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file_too_big' : 'bad_upload' });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_big' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_request' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

// ───────────────────────── запуск / остановка ─────────────────────────
let server = null;
async function boot() {
  await store.init();
  db = await loadDB();
  rebuildIndexes();
  await store.save(db); // гарантируем, что данные есть в целевом хранилище
  server = app.listen(PORT, () => {
    console.log('WorkshopAG v5 on :' + PORT);
    console.log('хранилище: ' + store.kind + ' (' + store.source + ')' +
      (store.kind === 'file' && !MOUNT ? '  ⚠ ДАННЫЕ НЕ ПЕРЕЖИВУТ ДЕПЛОЙ — нужна БД или постоянный том' : '  ✓ переживает деплой'));
  });
  server.requestTimeout = 30e3;
  server.headersTimeout = 15e3;
}
boot().catch(e => { console.error('Не удалось запустить:', e); process.exit(1); });

function shutdown(sig) {
  console.log(sig + ' — сохраняю и выхожу');
  clearTimeout(saveTimer);
  // деплой шлёт SIGTERM: нельзя уйти, пока последние правки не в базе
  const flush = () => store.save(db).catch(e => console.error('flush:', e.message))
    .then(() => { flushDBSync(); });
  const done = () => { flush().finally(() => process.exit(0)); };
  if (!server) return done();
  server.close(done);
  setTimeout(done, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
process.on('uncaughtException', e => { console.error('uncaughtException:', e); flushDBSync(); process.exit(1); });
