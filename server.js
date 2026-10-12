// WorkshopAG v3 — тот же API, но надёжнее, быстрее и безопаснее
// npm i express cors bcryptjs jsonwebtoken multer helmet express-rate-limit compression
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
const UP_DIR = path.join(PUBLIC_DIR, 'uploads');
const DB_FILE = path.join(__dirname, 'data', 'db.json');
fs.mkdirSync(UP_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// ───────────────────────── ошибки ─────────────────────────
class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new HttpError(status, code); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ───────────────────────── база ─────────────────────────
// Формат: { users:[], posts:[], comments:[], votes:{ "postId:userId": 1|-1 } }
function emptyDB() { return { users: [], posts: [], comments: [], votes: {} }; }

function parseDB(raw) {
  const db = JSON.parse(raw);
  db.users = db.users || []; db.posts = db.posts || []; db.comments = db.comments || [];
  if (Array.isArray(db.votes)) { // миграция со старого формата (массив)
    const m = {};
    for (const v of db.votes) m[v.postId + ':' + v.userId] = v.value;
    db.votes = m;
  } else db.votes = db.votes || {};
  return db;
}

function loadDB() {
  let raw;
  try { raw = fs.readFileSync(DB_FILE, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return emptyDB(); throw e; }
  try { return parseDB(raw); }
  catch (e) {
    // НЕ затираем битую базу молча (раньше это стирало все данные)
    const copy = DB_FILE + '.corrupt-' + Date.now();
    fs.copyFileSync(DB_FILE, copy);
    console.error('db.json повреждён, копия: ' + copy + '. Пробую бэкап…');
    try { return parseDB(fs.readFileSync(DB_FILE + '.bak', 'utf8')); }
    catch (_) { console.error('Бэкап тоже недоступен. Остановка, чтобы не потерять данные.'); process.exit(1); }
  }
}

let db = loadDB();

// индексы в памяти: поиск O(1) вместо filter/find по массивам на каждый запрос
const usersById = new Map();
const usersByName = new Map(); // lower-case имя -> user
const postsById = new Map();
const stats = new Map();       // postId -> { l, d, c }

const st = id => { let s = stats.get(id); if (!s) { s = { l: 0, d: 0, c: 0 }; stats.set(id, s); } return s; };
function rebuildIndexes() {
  usersById.clear(); usersByName.clear(); postsById.clear(); stats.clear();
  for (const u of db.users) { usersById.set(u.id, u); usersByName.set(u.name.toLowerCase(), u); }
  for (const p of db.posts) postsById.set(p.id, p);
  for (const [k, v] of Object.entries(db.votes)) {
    const s = st(k.split(':')[0]);
    if (v === 1) s.l++; else if (v === -1) s.d++;
  }
  for (const c of db.comments) st(c.postId).c++;
}
rebuildIndexes();

// сохранение: дебаунс + атомарная запись (tmp → rename) + почасовой бэкап
let saveTimer = null, saving = false, lastBackup = 0;
function saveDB() { if (!saveTimer) saveTimer = setTimeout(flushDB, 250); }
async function flushDB() {
  saveTimer = null;
  if (saving) return saveDB();
  saving = true;
  const tmp = DB_FILE + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify(db));
    if (Date.now() - lastBackup > 3600e3) {
      await fsp.copyFile(DB_FILE, DB_FILE + '.bak').catch(() => {});
      lastBackup = Date.now();
    }
    await fsp.rename(tmp, DB_FILE);
  } catch (e) {
    console.error('Ошибка сохранения БД:', e);
    setTimeout(saveDB, 2000); // повторить
  } finally { saving = false; }
}
function flushDBSync() {
  try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }
  catch (e) { console.error('Не удалось сохранить при выходе:', e); }
}

const uid = () => crypto.randomUUID();
const DUMMY_HASH = bcrypt.hashSync('dummy-password', BCRYPT_COST); // против тайминг-атаки на логин

// ───────────────────────── файлы ─────────────────────────
const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

const storage = multer.diskStorage({
  destination: (_r, _f, cb) => cb(null, UP_DIR),
  filename: (_r, f, cb) => {
    // расширение НЕ берём из имени пользователя (можно было залить .html и получить XSS)
    const ext = f.fieldname === 'jsonfile' ? '.json' : (MIME_EXT[f.mimetype] || '.bin');
    cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext);
  }
});
function fileFilter(_r, f, cb) {
  if (f.fieldname === 'photo' || f.fieldname === 'avatar') {
    return MIME_EXT[f.mimetype] ? cb(null, true) : cb(new HttpError(400, 'only_images'));
  }
  if (f.fieldname === 'jsonfile') {
    return (f.mimetype === 'application/json' || /\.json$/i.test(f.originalname || ''))
      ? cb(null, true) : cb(new HttpError(400, 'only_json'));
  }
  cb(null, false);
}
const upload = multer({ storage, fileFilter, limits: { fileSize: IMG_MAX, files: 2, fields: 10 } });

function sniffImage(b) { // проверка по сигнатуре, а не по заявленному mimetype
  if (b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return '.jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return '.png';
  const h6 = b.toString('ascii', 0, 6);
  if (h6 === 'GIF87a' || h6 === 'GIF89a') return '.gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}
async function readHead(file) {
  const fh = await fsp.open(file, 'r');
  try { const b = Buffer.alloc(12); await fh.read(b, 0, 12, 0); return b; }
  finally { await fh.close(); }
}
const collectFiles = req => [
  ...(req.file ? [req.file] : []),
  ...Object.values(req.files || {}).flat()
];
function safeUnlink(rel) {
  if (!rel || typeof rel !== 'string') return;
  fsp.unlink(path.join(UP_DIR, path.basename(rel))).catch(() => {}); // basename = защита от path traversal
}
async function validateUploads(req) {
  for (const f of collectFiles(req)) {
    if (f.fieldname === 'jsonfile') {
      if (f.size > JSON_MAX) fail(400, 'file_too_big');
      try { JSON.parse(await fsp.readFile(f.path, 'utf8')); } catch (_) { fail(400, 'bad_json'); }
    } else {
      const ext = sniffImage(await readHead(f.path));
      if (!ext) fail(400, 'only_images');
      if (!f.filename.endsWith(ext)) { // имя по реальному типу
        const nf = f.filename.replace(/\.[^.]+$/, '') + ext;
        await fsp.rename(f.path, path.join(UP_DIR, nf));
        f.filename = nf; f.path = path.join(UP_DIR, nf);
      }
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

// статика: кэш; загрузки неизменяемы (имена случайные)
app.use('/uploads', express.static(UP_DIR, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny' }));
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
  if (req.file) { safeUnlink(u.avatar); u.avatar = 'uploads/' + req.file.filename; }
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
    const p = {
      id: uid(), title, body, kind,
      photo: ph ? 'uploads/' + ph.filename : null,
      jsonUrl: js ? 'uploads/' + js.filename : null,
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

app.get('/api/health', (_req, res) => res.json({ ok: true, posts: db.posts.length, users: db.users.length, uptime: Math.round(process.uptime()) }));

// ───────────────────────── fallback и ошибки ─────────────────────────
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
// SPA: отдаём index.html только для «страниц», а не для отсутствующих картинок/файлов
app.use((req, res, next) => {
  if (req.method !== 'GET' || path.extname(req.path)) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.use((_req, res) => res.status(404).end());

app.use((err, req, res, _next) => {
  for (const f of collectFiles(req)) safeUnlink(f.filename); // убираем «осиротевшие» загрузки при любой ошибке
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
const server = app.listen(PORT, () => console.log('WorkshopAG v3 on :' + PORT));
server.requestTimeout = 30e3;
server.headersTimeout = 15e3;

function shutdown(sig) {
  console.log(sig + ' — сохраняю и выхожу');
  clearTimeout(saveTimer);
  server.close(() => { flushDBSync(); process.exit(0); });
  setTimeout(() => { flushDBSync(); process.exit(0); }, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
process.on('uncaughtException', e => { console.error('uncaughtException:', e); flushDBSync(); process.exit(1); });
