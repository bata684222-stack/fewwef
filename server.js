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
// имена владельцев: админка им выдаётся только через /api/setup с верным паролем,
// просто зарегистрировать такой ник и получить права НЕЛЬЗЯ
const ADMIN_NAMES = (process.env.ADMIN_NAMES || 'xqzas')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const VERIFIED_NAMES = (process.env.VERIFIED_NAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const hasAdmins = () => db.users.some(isAdmin);
const reservedName = n => ADMIN_NAMES.includes(n.toLowerCase());
const isAdmin = u => !!u && !!u.admin;
const isMod = u => !!u && (!!u.admin || !!u.mod);
const badgeOf = u => ({ admin: !!(u && u.admin), mod: !!(u && u.mod && !u.admin), verified: !!(u && u.verified) });

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
function emptyDB() { return { users: [], posts: [], comments: [], votes: {}, reactions: {}, follows: {}, broadcasts: [], threads: [], treplies: [], dms: [], groups: [], gmsgs: [], calls: [], gcalls: [] }; }

function parseDB(raw) {
  const db = typeof raw === 'string' ? JSON.parse(raw) : raw;
  db.users = db.users || []; db.posts = db.posts || []; db.comments = db.comments || [];
  db.threads = db.threads || []; db.treplies = db.treplies || []; db.dms = db.dms || [];
  db.reactions = db.reactions || {};
  db.follows = db.follows || {};
  db.broadcasts = db.broadcasts || [];
  db.groups = db.groups || []; db.gmsgs = db.gmsgs || []; db.calls = db.calls || []; db.gcalls = db.gcalls || [];
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
const groupsById = new Map();
const stats = new Map();       // postId -> { l, d, c }

const st = id => { let s = stats.get(id); if (!s) { s = { l: 0, d: 0, c: 0, r: {} }; stats.set(id, s); } return s; };
function rebuildIndexes() {
  usersById.clear(); usersByName.clear(); postsById.clear(); threadsById.clear(); groupsById.clear(); stats.clear();
  for (const u of db.users) { usersById.set(u.id, u); usersByName.set(u.name.toLowerCase(), u); }
  for (const p of db.posts) postsById.set(p.id, p);
  for (const t of db.threads) threadsById.set(t.id, t);
  for (const g of db.groups) groupsById.set(g.id, g);
  for (const [k, v] of Object.entries(db.votes)) {
    const s = st(k.split(':')[0]);
    if (v === 1) s.l++; else if (v === -1) s.d++;
  }
  for (const c of db.comments) st(c.postId).c++;
  for (const [k, v] of Object.entries(db.reactions)) {
    if (!v) continue;
    const s = st(k.slice(0, k.indexOf('|')));      // ключ: postId|userId|emoji
    const e = k.slice(k.lastIndexOf('|') + 1);
    s.r[e] = (s.r[e] || 0) + 1;
  }
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
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return null; // без dotfiles
  return base;
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
  res.set('Content-Disposition', 'inline');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(buf);
}));
// ───────────────────────── статика и версия ─────────────────────────
// Идея: index.html всегда свежий (no-cache), а app.js/style.css помечаются
// версией-хэшем в имени (?v=...), поэтому браузер не берёт старый файл из кэша,
// но зря не качает его при каждом обновлении.
const ASSETS = ['app.js', 'style.css', 'AG.png'];
let ASSET_V = 'dev';
function computeAssetVersion() {
  const h = crypto.createHash('sha1');
  for (const f of ASSETS) {
    try { h.update(fs.readFileSync(path.join(PUBLIC_DIR, f))); }
    catch (_) { h.update(f); }
  }
  ASSET_V = h.digest('hex').slice(0, 8);
}
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const ogEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').slice(0, 300);
function serveIndex(_req, res, meta) {
  let html;
  try { html = fs.readFileSync(INDEX_FILE, 'utf8'); }
  catch (_) { return res.status(500).type('txt').send('index.html не найден'); }
  // подставляем версию в ссылки на ассеты (и чиним относительные в абсолютные)
  html = html.replace(/(src|href)="\/?(app\.js|style\.css)(?:\?v=[a-z0-9]+)?"/gi,
    (_, a, f) => a + '="/' + f + '?v=' + ASSET_V + '"');
  if (meta) { // красивое превью расшаренного поста в мессенджерах
    const tags = '<meta property="og:type" content="article">' +
      '<meta property="og:site_name" content="WorkshopAG">' +
      '<meta property="og:title" content="' + ogEsc(meta.title) + '">' +
      '<meta property="og:description" content="' + ogEsc(meta.desc) + '">' +
      (meta.img ? '<meta property="og:image" content="' + ogEsc(meta.img) + '">' : '') + '</head>';
    html = html.replace('</head>', tags);
  }
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('X-App-Version', ASSET_V);
  res.type('html').send(html);
}
// прямые загрузки игры: форсируем «скачать файлом», а не «открыть в браузере»
// (трейлер идёт через обычную статику ниже — видео должно играть инлайн)
const DL_FILES = {
  'ArmorGame-v1.0.exe': 'application/x-msdownload',
  'ArmorGame-v1.0.apk': 'application/vnd.android.package-archive'
};
app.get('/downloads/:file', (req, res, next) => {
  const type = DL_FILES[req.params.file];
  if (!type) return next(); // трейлер и прочее отдаёт обычная статика ниже
  res.set('Content-Type', type);
  res.set('Content-Disposition', 'attachment; filename="' + req.params.file + '"');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(path.join(PUBLIC_DIR, 'downloads', req.params.file), err => {
    if (err && !res.headersSent) res.status(404).end();
  });
});
app.get('/', (req, res) => serveIndex(req, res));
app.get('/index.html', serveIndex); // и напрямую — тоже без кэша
// короткая ссылка на пост: /p/<id> — человеку отдаёт приложение, роботу — превью
app.get('/p/:id', (req, res) => {
  const p = postsById.get(req.params.id);
  if (!p) return serveIndex(req, res);
  const a = usersById.get(p.authorId);
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const base = host ? proto + '://' + host : '';
  serveIndex(req, res, {
    title: (p.kind === 'build' ? '▦ ' : '🚀 ') + p.title + ' — WorkshopAG',
    desc: (a ? a.name : p.author) + (p.body ? ': ' + p.body.slice(0, 160) : '') + ' · 👍' + (stats.get(p.id)?.l || 0) + ' · 👁' + (p.views || 0),
    img: p.photo && base ? base + '/' + p.photo : (base ? base + '/AG.png' : null)
  });
});
// ассеты — надолго: имя меняется при каждом деплое через ?v=
app.use(express.static(PUBLIC_DIR, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny' }));

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
      if (u && (p.tv || 0) === (u.tv || 0)) {
        req.user = u;
        u.lastSeen = Date.now(); // heartbeat: любой запрос = «я в сети», пишется раз в минуту
      }
    } catch (_) {}
  }
  next();
}
function authNeed(req, res, next) {
  authOpt(req, res, () => req.user ? next() : res.status(401).json({ error: 'need_auth' }));
}

const pubUser = u => ({ id: u.id, name: u.name, avatar: u.avatar || null, badge: badgeOf(u), views: u.views || 0, callsOff: !!u.callsOff, online: isOnline(u), lastSeen: u.lastSeen || 0, createdAt: u.createdAt });
const ONLINE_MS = 120e3;
function isOnline(u) { return !!u && (Date.now() - (u.lastSeen || 0)) < ONLINE_MS; }
// раз в минуту фиксируем heartbeat в хранилище, чтобы онлайн переживал рестарт
setInterval(() => { try { saveDB(); } catch (_) {} }, 60e3).unref?.();
const REACTIONS = ['🔥', '👏', '🎯', '🧠', '💀'];
function postDTO(p, viewerId) {
  const s = stats.get(p.id) || { l: 0, d: 0, c: 0, r: {} };
  const a = usersById.get(p.authorId);
  let mine = [];
  if (viewerId) {
    for (const e of REACTIONS) if (db.reactions[p.id + '|' + viewerId + '|' + e]) mine.push(e);
  }
  return {
    ...p,
    author: a ? a.name : p.author,           // всегда актуальные ник/аватар
    avatar: a ? a.avatar || null : null,
    likes: s.l, dislikes: s.d, comments: s.c, views: p.views || 0, downloads: p.downloads || 0,
    reactions: s.r, myReactions: mine,
    authorBadge: badgeOf(a), authorOnline: isOnline(a),
    myVote: viewerId ? (db.votes[p.id + ':' + viewerId] || 0) : 0
  };
}
const commentDTO = c => ({ ...c, author: usersById.get(c.authorId)?.name || c.author, badge: badgeOf(usersById.get(c.authorId)) });
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
  if (reservedName(name) && hasAdmins()) fail(403, 'reserved_name'); // ник владельца занят им самим
  const pass = await bcrypt.hash(password, BCRYPT_COST);
  if (usersByName.has(name.toLowerCase())) fail(409, 'name_taken'); // гонка во время await
  const u = { id: uid(), name, pass, avatar: null, tv: 0, lastSeen: Date.now(), createdAt: Date.now() };
  if (!hasAdmins()) u.admin = true; // самый первый игрок площадки — админ, дальше только выдача
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

// ───────────────────────── первичное получение прав ─────────────────────────
// Единственный легальный путь стать админом «с нуля»:
//  - админов в базе нет вообще → создаёт/выдаёт первому заявителю;
//  - владелец из ADMIN_NAMES со СВОИМ паролем → выдача в любое время.
// Подобрать чужой пароль нельзя, просто зарегистрировать ник владельца — тоже.
app.post('/api/setup', authLimiter, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  if (name.length < 2 || !NAME_RE.test(name)) fail(400, 'bad_name');
  if (password.length < 4 || password.length > 72) fail(400, 'short_pass');
  const key = name.toLowerCase();
  const u = usersByName.get(key);
  if (u) {
    const ok = await bcrypt.compare(password, u.pass);
    if (!ok) fail(401, 'bad_login');
    if (ADMIN_NAMES.includes(key)) u.admin = true;
    if (VERIFIED_NAMES.includes(key)) u.verified = true;
    if (!hasAdmins()) u.admin = true; // админов нет — первый заявитель забирает площадку
    saveDB();
    return res.json({ token: signToken(u), user: pubUser(u) });
  }
  if (hasAdmins() && !ADMIN_NAMES.includes(key) && !VERIFIED_NAMES.includes(key)) fail(403, 'use_register');
  const pass = await bcrypt.hash(password, BCRYPT_COST);
  if (usersByName.has(key)) fail(409, 'name_taken');
  const nu = { id: uid(), name, pass, avatar: null, tv: 0, lastSeen: Date.now(), createdAt: Date.now() };
  if (ADMIN_NAMES.includes(key) || !hasAdmins()) nu.admin = true;
  if (VERIFIED_NAMES.includes(key)) nu.verified = true;
  db.users.push(nu); usersById.set(nu.id, nu); usersByName.set(key, nu);
  saveDB();
  res.json({ token: signToken(nu), user: pubUser(nu) });
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
      if (reservedName(name) && hasAdmins()) fail(403, 'reserved_name'); // нельзя притвориться владельцем
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
  if (req.body?.callsOff !== undefined) { // '1'/true = не звонить мне
    const v = req.body.callsOff;
    u.callsOff = v === true || v === '1' || v === 'true' || v === 'on';
  }
  if (req.file) {
    const nm = await persistUpload(req.file);
    safeUnlink(u.avatar); // старый аватар
    u.avatar = 'uploads/' + nm;
  }
  saveDB();
  res.json({ token: signToken(u), user: pubUser(u) });
}));

// полное удаление аккаунта со всем содержимым (своё и по решению админа)
function dropUser(u) {
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
  for (const k of Object.keys(db.reactions)) {
    const [pid, , uid2] = k.split('|');
    if (uid2 === u.id || ids.has(pid)) delete db.reactions[k];
  }
  for (const k of Object.keys(db.follows)) { if (k === u.id) delete db.follows[k]; else delete db.follows[k][u.id]; }
  const myThreads = new Set(db.threads.filter(t => t.authorId === u.id).map(t => t.id));
  db.threads = db.threads.filter(t => t.authorId !== u.id);
  db.treplies = db.treplies.filter(r => r.authorId !== u.id && !myThreads.has(r.threadId));
  db.dms = db.dms.filter(m => m.fromId !== u.id && m.toId !== u.id);
  for (const id of myThreads) threadsById.delete(id);
  // группы: свои удаляем целиком, из чужих выходим
  const myGroups = new Set(db.groups.filter(g => g.ownerId === u.id).map(g => g.id));
  db.groups = db.groups.filter(g => g.ownerId !== u.id);
  for (const g of db.groups) delete g.members[u.id];
  db.gmsgs = db.gmsgs.filter(m => m.authorId !== u.id && !myGroups.has(m.groupId));
  for (const g of db.groups) groupsById.delete(g.id);
  for (const id of myGroups) groupsById.delete(id);
  db.calls = db.calls.filter(c => c.from !== u.id && c.to !== u.id);
  for (const r of db.gcalls) delete r.peers[u.id];
  db.gcalls = db.gcalls.filter(r => Object.keys(r.peers).length);
  db.users = db.users.filter(x => x.id !== u.id);
  usersById.delete(u.id); usersByName.delete(u.name.toLowerCase());
  rebuildIndexes(); saveDB();
}
app.delete('/api/me', authNeed, writeLimiter, (req, res) => {
  dropUser(req.user);
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
// один пост — для расшаренных ссылок
app.get('/api/posts/:id', authOpt, (req, res) => {
  const p = postsById.get(req.params.id);
  if (!p) fail(404, 'not_found');
  res.json(postDTO(p, req.user?.id));
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
  for (const k of Object.keys(db.reactions)) if (k.startsWith(p.id + '|')) delete db.reactions[k];
  postsById.delete(p.id); stats.delete(p.id);
  saveDB();
  res.json({ ok: true });
});

// правка своего поста: название/текст/тип + замена или удаление фото и JSON
app.patch('/api/posts/:id', authNeed, writeLimiter,
  ...withUploads(upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'jsonfile', maxCount: 1 }])),
  wrap(async (req, res) => {
    const p = postsById.get(req.params.id);
    if (!p) fail(404, 'not_found');
    if (p.authorId !== req.user.id) fail(403, 'not_yours');
    if (req.body?.title !== undefined) {
      const title = String(req.body.title).trim().slice(0, 80);
      if (title.length < 2) fail(400, 'short_title');
      p.title = title;
    }
    if (req.body?.body !== undefined) p.body = String(req.body.body).trim().slice(0, 2000);
    if (req.body?.kind === 'proj' || req.body?.kind === 'build') p.kind = req.body.kind;
    const ph = req.files?.photo?.[0], js = req.files?.jsonfile?.[0];
    if (ph) { safeUnlink(p.photo); p.photo = 'uploads/' + await persistUpload(ph); }
    else if (req.body?.removePhoto) { safeUnlink(p.photo); p.photo = null; }
    if (js) {
      safeUnlink(p.jsonUrl);
      p.jsonUrl = 'uploads/' + await persistUpload(js);
      p.jsonName = String(js.originalname || 'file.json').slice(0, 80);
    } else if (req.body?.removeJson) { safeUnlink(p.jsonUrl); p.jsonUrl = null; p.jsonName = null; }
    saveDB();
    res.json(postDTO(p, req.user.id));
  }));

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

// ───────────────────────── реакции ─────────────────────────
// одна реакция на эмодзи от пользователя; повторный клик снимает её
app.get('/api/reactions', (_req, res) => res.json({ reactions: REACTIONS }));
app.post('/api/posts/:id/react', authNeed, writeLimiter, (req, res) => {
  const p = postsById.get(req.params.id);
  if (!p) fail(404, 'not_found');
  const emoji = String(req.body?.emoji || '');
  if (!REACTIONS.includes(emoji)) fail(400, 'bad_reaction');
  const key = p.id + '|' + req.user.id + '|' + emoji;
  const s = st(p.id);
  if (db.reactions[key]) { delete db.reactions[key]; s.r[emoji] = Math.max(0, (s.r[emoji] || 1) - 1); }
  else { db.reactions[key] = 1; s.r[emoji] = (s.r[emoji] || 0) + 1; }
  saveDB();
  res.json(postDTO(p, req.user.id));
});

// просмотр поста: +1 (фронт шлёт один раз за сессию, накрутка лечится на клиенте)
app.post('/api/posts/:id/view', authOpt, (req, res) => {
  const p = postsById.get(req.params.id);
  if (!p) fail(404, 'not_found');
  p.views = (p.views || 0) + 1;
  saveDB();
  res.json({ views: p.views });
});

// скачивание чертежа: +1 (фронт шлёт один раз за сессию)
app.post('/api/posts/:id/download', authOpt, (req, res) => {
  const p = postsById.get(req.params.id);
  if (!p || !p.jsonUrl) fail(404, 'not_found');
  p.downloads = (p.downloads || 0) + 1;
  saveDB();
  res.json({ downloads: p.downloads });
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
  res.json({ ...c, badge: badgeOf(req.user) });
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
  version: ASSET_V,
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
    authorBadge: badgeOf(a), authorOnline: isOnline(a),
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
    .map(r => ({ ...r, author: usersById.get(r.authorId)?.name || r.author, badge: badgeOf(usersById.get(r.authorId)) }));
  res.json({ thread: threadDTO(t, req.user?.id), replies });
});
app.post('/api/threads/:id/replies', authNeed, writeLimiter, (req, res) => {
  const t = threadsById.get(req.params.id);
  if (!t) fail(404, 'not_found');
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) fail(400, 'empty');
  const r = { id: uid(), threadId: t.id, author: req.user.name, authorId: req.user.id, text, createdAt: Date.now() };
  db.treplies.push(r); t.lastAt = Date.now(); saveDB();
  res.json({ ...r, author: req.user.name, badge: badgeOf(req.user) });
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
  return { ...m, peer: peer ? { id: peer.id, name: peer.name, avatar: peer.avatar || null, badge: badgeOf(peer), online: isOnline(peer) } : { id: peerId, name: 'Удалён', avatar: null, badge: {} } };
};
app.get('/api/users', authNeed, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 20);
  const limit = clampInt(req.query.limit, 20, 1, 20);
  let list = db.users.filter(u => u.id !== req.user.id);
  if (q) list = list.filter(u => u.name.toLowerCase().includes(q));
  list = list.slice(0, limit).map(u => ({ id: u.id, name: u.name, avatar: u.avatar || null, badge: badgeOf(u), online: isOnline(u) }));
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
    return { user: peer ? { id: peer.id, name: peer.name, avatar: peer.avatar || null, badge: badgeOf(peer), online: isOnline(peer) } : { id: c.peerId, name: 'Удалён', avatar: null, badge: {} }, lastText: c.lastText, lastAt: c.lastAt, unread: c.unread };
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

// ───────────────────────── профили и подписки ─────────────────────────
function followersOf(id) {
  let n = 0;
  for (const list of Object.values(db.follows)) if (list[id]) n++;
  return n;
}
app.get('/api/users/:id', authNeed, (req, res) => {
  const u = usersById.get(req.params.id);
  if (!u) fail(404, 'not_found');
  const self = req.user.id === u.id;
  if (!self) { u.views = (u.views || 0) + 1; saveDB(); } // чужие просмотры профиля считаем
  const posts = db.posts.filter(p => p.authorId === u.id);
  let following = 0;
  for (const t of Object.values(db.follows)) if (t[u.id]) following++;
  res.json({
    user: {
      ...pubUser(u), posts: posts.length,
      followers: followersOf(u.id), following,
      likes: posts.reduce((s, p) => s + (stats.get(p.id)?.l || 0), 0)
    },
    isSelf: self,
    follows: !!db.follows[req.user.id]?.[u.id],
    posts: posts.map(p => postDTO(p, req.user.id))
  });
});
app.post('/api/users/:id/follow', authNeed, writeLimiter, (req, res) => {
  const target = usersById.get(req.params.id);
  if (!target) fail(404, 'not_found');
  if (target.id === req.user.id) fail(400, 'bad_request');
  const mine = db.follows[req.user.id] || (db.follows[req.user.id] = {});
  if (mine[target.id]) delete mine[target.id];
  else mine[target.id] = Date.now();
  if (!Object.keys(mine).length) delete db.follows[req.user.id];
  saveDB();
  res.json({ follows: !!db.follows[req.user.id]?.[target.id], followers: followersOf(target.id) });
});

// кто сейчас в сети (heartbeat моложе 2 минут)
app.get('/api/online', authNeed, (req, res) => {
  const list = db.users
    .filter(u => u.id !== req.user.id && isOnline(u))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, 50)
    .map(u => ({ id: u.id, name: u.name, avatar: u.avatar || null, badge: badgeOf(u) }));
  res.json(list);
});

// ───────────────────────── рассылка от админа ─────────────────────────
app.get('/api/broadcasts', (_req, res) => {
  res.json(db.broadcasts.slice(-10));
});

// ───────────────────────── админка ─────────────────────────
function needAdmin(req, res, next) {
  authOpt(req, res, () => isAdmin(req.user) ? next() : res.status(403).json({ error: 'not_admin' }));
}
function needMod(req, res, next) {
  authOpt(req, res, () => isMod(req.user) ? next() : res.status(403).json({ error: 'not_admin' }));
}
app.get('/api/admin/stats', needMod, (req, res) => {
  let comments = 0, reactions = 0;
  for (const c of db.comments) comments++;
  for (const v of Object.values(db.reactions)) if (v) reactions++;
  res.json({
    users: db.users.length, admins: db.users.filter(isAdmin).length,
    mods: db.users.filter(u => u.mod && !u.admin).length,
    verified: db.users.filter(u => u.verified).length,
    posts: db.posts.length, comments, reactions,
    threads: db.threads.length, dms: db.dms.length, broadcasts: db.broadcasts.length,
    online: '—'
  });
});
app.get('/api/admin/users', needAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = db.users.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (q) list = list.filter(u => u.name.toLowerCase().includes(q));
  res.json(list.slice(0, 100).map(u => ({
    ...pubUser(u),
    posts: db.posts.filter(p => p.authorId === u.id).length,
    joined: u.createdAt
  })));
});
app.post('/api/admin/user/:id/role', needAdmin, writeLimiter, (req, res) => {
  const u = usersById.get(req.params.id);
  if (!u) fail(404, 'not_found');
  const b = req.body || {};
  // нельзя лишить прав последнего админа
  if (u.admin && b.admin === false) {
    const admins = db.users.filter(isAdmin);
    if (admins.length <= 1) fail(400, 'last_admin');
  }
  if (b.admin !== undefined) u.admin = !!b.admin;
  if (b.mod !== undefined) u.mod = !!b.mod;
  if (b.verified !== undefined) u.verified = !!b.verified;
  saveDB();
  res.json(pubUser(u));
});
app.delete('/api/admin/user/:id', needAdmin, (req, res) => {
  const u = usersById.get(req.params.id);
  if (!u) fail(404, 'not_found');
  if (u.id === req.user.id) fail(400, 'bad_request');
  if (u.admin && db.users.filter(isAdmin).length <= 1) fail(400, 'last_admin');
  dropUser(u);
  res.json({ ok: true });
});
app.post('/api/admin/broadcast', needMod, (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (text.length < 2) fail(400, 'empty');
  const b = { id: uid(), text, by: req.user.name, byId: req.user.id, at: Date.now() };
  db.broadcasts.push(b);
  if (db.broadcasts.length > 50) db.broadcasts.shift();
  saveDB();
  res.json(b);
});
app.delete('/api/admin/broadcast/:id', needAdmin, (req, res) => {
  db.broadcasts = db.broadcasts.filter(b => b.id !== req.params.id);
  saveDB(); res.json({ ok: true });
});
// модерация контента: удаление любых постов/комментов/тем
function dropPost(id) {
  const p = postsById.get(id); if (!p) return false;
  safeUnlink(p.photo); safeUnlink(p.jsonUrl);
  db.posts = db.posts.filter(x => x.id !== id);
  db.comments = db.comments.filter(c => c.postId !== id);
  for (const k of Object.keys(db.votes)) if (k.startsWith(id + ':')) delete db.votes[k];
  for (const k of Object.keys(db.reactions)) if (k.startsWith(id + '|')) delete db.reactions[k];
  postsById.delete(id); stats.delete(id);
  saveDB(); return true;
}
function dropComment(id) {
  const c = db.comments.find(x => x.id === id);
  if (!c) return false;
  db.comments = db.comments.filter(x => x.id !== id);
  const s = stats.get(c.postId); if (s && s.c > 0) s.c--;
  saveDB(); return true;
}
function dropThread(id) {
  const t = threadsById.get(id); if (!t) return false;
  db.threads = db.threads.filter(x => x.id !== id);
  db.treplies = db.treplies.filter(r => r.threadId !== id);
  threadsById.delete(id);
  saveDB(); return true;
}
app.delete('/api/admin/post/:id', needMod, (req, res) => dropPost(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'not_found' }));
app.delete('/api/admin/comment/:id', needMod, (req, res) => dropComment(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'not_found' }));
app.delete('/api/admin/thread/:id', needMod, (req, res) => dropThread(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'not_found' }));
app.delete('/api/admin/reply/:id', needMod, (req, res) => {
  const r = db.treplies.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  db.treplies = db.treplies.filter(x => x.id !== r.id);
  saveDB(); res.json({ ok: true });
});
app.get('/api/admin/reports', needMod, (_req, res) => res.json([]));

// ───────────────────────── бот-помощник ─────────────────────────
const BOT_REPLIES = {
  'привет': 'Привет, {name}! Я AG-бот воркшопа. Напиши /помощь — расскажу, что умею.',
  'здор': 'Здоровец-здарова, {name}! /помощь — список команд.',
  'здравствуй': 'Привет, {name}! Команда /помощь покажет, что я умею.',
  'здравствуйте': 'Привет, {name}! Команда /помощь покажет, что я умею.',
  'пока': 'Пока, {name}! Загляни ещё 👋',
  'до свидания': 'До связи, {name}! Хорошей охоты 💥',
  'спасибо': 'Всегда пожалуйста, {name}!',
  'как дела': 'У меня всё по расписанию: {posts} постов, {users} игроков, ни дня без пробития. А у тебя? 😄',
  'кто ты': 'Я AG-бот воркшопа. Подсказываю по площадке, считаю статистику и ношу новости.',
  'кто я': 'Ты — {name}. Постов: {myposts}, лайков получено: {mylikes}.',
  'ты бот': 'Да, я бот 😌 Но стараюсь быть полезным. /помощь — список команд.'
};
function botAnswer(text, u) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  const cmd = low.startsWith('/') ? low.split(/\s+/)[0].slice(1) : null;
  const myposts = db.posts.filter(p => p.authorId === u.id).length;
  const mylikes = db.posts.filter(p => p.authorId === u.id).reduce((s, p) => s + (stats.get(p.id)?.l || 0), 0);
  const ctx = { name: u.name, posts: db.posts.length, users: db.users.length, myposts, mylikes };

  if (cmd === 'помощь' || cmd === 'help' || cmd === 'команды' || cmd === 'start') {
    return [
      '🤖 Команды бота:',
      '/помощь — этот список',
      '/стата — статистика площадки',
      '/топ — лучшие посты',
      '/кто я — твоя статистика',
      '/новости — последнее объявление',
      '/модерация — как связаться с админом'
    ].join('\n');
  }
  if (cmd === 'стата' || cmd === 'статистика' || cmd === 'stats') {
    return '📊 Площадка: постов ' + db.posts.length + ', игроков ' + db.users.length +
      ', тем на форуме ' + db.threads.length + ', комментариев ' + db.comments.length + '.';
  }
  if (cmd === 'топ' || cmd === 'top') {
    const top = db.posts.map(p => ({ p, s: stats.get(p.id)?.l || 0 })).sort((a, b) => b.s - a.s).slice(0, 3);
    if (!top.length) return 'Топ пуст — опубликуй первый пост!';
    return '🏆 Топ постов:\n' + top.map((x, i) => (i + 1) + '. ' + x.p.title + ' — ' + x.s + ' лайков').join('\n');
  }
  if (cmd === 'кто я' || cmd === 'me' || cmd === 'профиль') {
    return '🧑 ' + u.name + ': постов ' + ctx.myposts + ', лайков ' + ctx.mylikes +
      (badgeOf(u).admin ? ', админ' : badgeOf(u).mod ? ', модератор' : '') + '.';
  }
  if (cmd === 'новости' || cmd === 'news') {
    const b = db.broadcasts[db.broadcasts.length - 1];
    return b ? '📢 ' + b.text + '\n— ' + b.by : 'Пока нет объявлений.';
  }
  if (cmd === 'модерация' || cmd === 'помощь админа' || cmd === 'мод') {
    const mods = db.users.filter(u => u.admin || u.mod).map(u => '@' + u.name).join(', ');
    return '🛡 Написать можно: ' + (mods || 'никого пока нет') + '. Удаляет спам и выдаёт галочки.';
  }
  if (cmd === 'админка') {
    return isMod(u) ? '🛡 У тебя есть админка — кнопка «Админка» в профиле.' : '🚫 Админка только для модераторов.';
  }
  const words = ['снаряд', 'плита', 'брон', 'проби', 'армор'];
  for (const [k, v] of Object.entries(BOT_REPLIES)) {
    if (low.includes(k)) return v.replace(/\{(\w+)\}/g, (_, x) => ctx[x] ?? '');
  }
  if (words.some(w => low.includes(w))) {
    return '💡 Про броню: у снаряда есть масса, скорость и обтекаемость — они решают, пробитие или рикошет. Сравни материалы в ленте и спрашивай игроков в комментариях.';
  }
  return '🤖 Не понял. Напиши /помощь — покажу команды.';
}
app.post('/api/bot', authNeed, writeLimiter, (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!text) fail(400, 'empty');
  const reply = botAnswer(text, req.user);
  res.json({ reply, at: Date.now() });
});

// ───────────────────────── группы ─────────────────────────
function groupDTO(g, viewerId) {
  const o = usersById.get(g.ownerId);
  const members = Object.keys(g.members || {});
  return {
    id: g.id, name: g.name, desc: g.desc || '',
    owner: o ? o.name : '—', ownerId: g.ownerId,
    members: members.length, isMember: !!viewerId && !!g.members[viewerId],
    myRole: viewerId ? (g.members[viewerId] || null) : null,
    createdAt: g.createdAt
  };
}
app.get('/api/groups', authNeed, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 30);
  const mine = String(req.query.mine || '') === '1';
  let list = db.groups.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (mine) list = list.filter(g => g.members[req.user.id]);
  if (q) list = list.filter(g => (g.name + ' ' + (g.desc || '')).toLowerCase().includes(q));
  res.json(list.slice(0, 100).map(g => groupDTO(g, req.user.id)));
});
app.post('/api/groups', authNeed, writeLimiter, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const desc = String(req.body?.desc || '').trim().slice(0, 300);
  if (name.length < 2) fail(400, 'short_title');
  const g = { id: uid(), name, desc, ownerId: req.user.id, members: { [req.user.id]: 'owner' }, createdAt: Date.now() };
  db.groups.unshift(g); groupsById.set(g.id, g); saveDB();
  res.json(groupDTO(g, req.user.id));
});
app.get('/api/groups/:id', authNeed, (req, res) => {
  const g = groupsById.get(req.params.id);
  if (!g) fail(404, 'not_found');
  const members = Object.entries(g.members || {}).map(([uid, role]) => {
    const u = usersById.get(uid);
    return u ? { id: u.id, name: u.name, avatar: u.avatar || null, badge: badgeOf(u), online: isOnline(u), role } : null;
  }).filter(Boolean);
  res.json({ ...groupDTO(g, req.user.id), members });
});
app.post('/api/groups/:id/join', authNeed, writeLimiter, (req, res) => {
  const g = groupsById.get(req.params.id);
  if (!g) fail(404, 'not_found');
  g.members[req.user.id] = g.members[req.user.id] || 'member';
  saveDB();
  res.json(groupDTO(g, req.user.id));
});
app.post('/api/groups/:id/leave', authNeed, writeLimiter, (req, res) => {
  const g = groupsById.get(req.params.id);
  if (!g) fail(404, 'not_found');
  if (g.ownerId === req.user.id) fail(400, 'owner_cant_leave');
  delete g.members[req.user.id];
  saveDB();
  res.json({ ok: true });
});
app.post('/api/groups/:id/kick', authNeed, writeLimiter, (req, res) => {
  const g = groupsById.get(req.params.id);
  if (!g) fail(404, 'not_found');
  const target = String(req.body?.userId || '');
  if (!target) fail(400, 'bad_request');
  const canKick = g.ownerId === req.user.id || isMod(req.user);
  if (!canKick) fail(403, 'not_admin');
  if (target === g.ownerId) fail(400, 'bad_request'); // владельца кикнуть нельзя
  delete g.members[target];
  saveDB();
  res.json({ ok: true });
});
app.delete('/api/groups/:id', authNeed, writeLimiter, (req, res) => {
  const g = groupsById.get(req.params.id);
  if (!g) fail(404, 'not_found');
  if (g.ownerId !== req.user.id && !isAdmin(req.user)) fail(403, 'not_admin');
  db.groups = db.groups.filter(x => x.id !== g.id);
  db.gmsgs = db.gmsgs.filter(m => m.groupId !== g.id);
  db.gcalls = db.gcalls.filter(r => r.groupId !== g.id);
  groupsById.delete(g.id);
  saveDB();
  res.json({ ok: true });
});
app.get('/api/groups/:id/msgs', authNeed, (req, res) => {
  const g = groupsById.get(req.params.id);
  if (!g) fail(404, 'not_found');
  if (!g.members[req.user.id] && !isMod(req.user)) fail(403, 'not_member');
  const since = Number(req.query.since || 0);
  const list = db.gmsgs.filter(m => m.groupId === g.id && m.createdAt > since)
    .sort((a, b) => a.createdAt - b.createdAt).slice(-200);
  res.json(list.map(m => ({ ...m, author: usersById.get(m.authorId)?.name || m.author, badge: badgeOf(usersById.get(m.authorId)) })));
});
app.post('/api/groups/:id/msgs', authNeed, writeLimiter, (req, res) => {
  const g = groupsById.get(req.params.id);
  if (!g) fail(404, 'not_found');
  if (!g.members[req.user.id] && !isMod(req.user)) fail(403, 'not_member');
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) fail(400, 'empty');
  const m = { id: uid(), groupId: g.id, author: req.user.name, authorId: req.user.id, text, createdAt: Date.now() };
  db.gmsgs.push(m); saveDB();
  res.json({ ...m, badge: badgeOf(req.user) });
});
app.delete('/api/groups/:gid/msgs/:mid', authNeed, writeLimiter, (req, res) => {
  const g = groupsById.get(req.params.gid);
  if (!g) fail(404, 'not_found');
  const m = db.gmsgs.find(x => x.id === req.params.mid && x.groupId === g.id);
  if (!m) fail(404, 'not_found');
  const can = m.authorId === req.user.id || g.ownerId === req.user.id || isMod(req.user);
  if (!can) fail(403, 'not_yours');
  db.gmsgs = db.gmsgs.filter(x => x.id !== m.id);
  saveDB();
  res.json({ ok: true });
});

// ───────────────────────── звонки (WebRTC, сигнал через API) ─────────────────────────
// Поток: caller создаёт offer → POST /api/calls → callee видит входящий → answer.
// ICE-кандидаты обе стороны шлют сюда же, забирают через state. Медиа идёт напрямую (P2P).
function pruneCalls() {
  const old = Date.now() - 5 * 60e3;
  const n0 = db.calls.length;
  db.calls = db.calls.filter(c => c.status !== 'ended' || c.updatedAt > old);
  if (db.calls.length !== n0) saveDB();
}
function activeCallOf(uid) {
  return db.calls.find(c => (c.from === uid || c.to === uid) && (c.status === 'ringing' || c.status === 'active'));
}
function callPeer(u, c) {
  const pid = c.from === u.id ? c.to : c.from;
  const p = usersById.get(pid);
  return p ? { id: p.id, name: p.name, avatar: p.avatar || null, badge: badgeOf(p) } : { id: pid, name: 'Удалён', avatar: null, badge: {} };
}
app.post('/api/calls', authNeed, writeLimiter, (req, res) => {
  pruneCalls();
  const peer = usersById.get(String(req.body?.to || ''));
  if (!peer) fail(404, 'not_found');
  if (peer.id === req.user.id) fail(400, 'bad_request');
  if (peer.callsOff) fail(403, 'calls_off'); // игрок запретил звонки
  if (activeCallOf(req.user.id)) fail(409, 'busy_self');
  if (activeCallOf(peer.id)) fail(409, 'busy_peer');
  for (const r of db.gcalls) {
    if (r.status !== 'open') continue;
    if (r.peers[req.user.id]) fail(409, 'busy_self');
    if (r.peers[peer.id]) fail(409, 'busy_peer');
  }
  const kind = req.body?.kind === 'video' ? 'video' : 'audio';
  const offer = req.body?.offer;
  if (!offer || typeof offer.sdp !== 'string' || offer.sdp.length > 20000) fail(400, 'bad_offer');
  const c = {
    id: uid(), from: req.user.id, to: peer.id, kind,
    offer: { type: 'offer', sdp: String(offer.sdp).slice(0, 20000) },
    answer: null, iceFrom: [], iceTo: [],
    status: 'ringing', createdAt: Date.now(), updatedAt: Date.now()
  };
  db.calls.push(c); saveDB();
  res.json({ id: c.id, status: c.status, peer: callPeer(req.user, c) });
});
app.get('/api/calls/incoming', authNeed, (req, res) => {
  pruneCalls();
  const list = db.calls.filter(c => c.to === req.user.id && c.status === 'ringing')
    .map(c => ({ id: c.id, kind: c.kind, peer: callPeer(req.user, c), createdAt: c.createdAt }));
  res.json(list);
});
app.get('/api/calls/:id/state', authNeed, (req, res) => {
  const c = db.calls.find(x => x.id === req.params.id);
  if (!c || (c.from !== req.user.id && c.to !== req.user.id)) fail(404, 'not_found');
  const mine = c.from === req.user.id;
  res.json({
    id: c.id, kind: c.kind, status: c.status, peer: callPeer(req.user, c),
    offer: !mine && c.status === 'ringing' ? c.offer : null,
    answer: mine ? c.answer : null,
    ice: mine ? c.iceTo : c.iceFrom
  });
});
app.post('/api/calls/:id/answer', authNeed, writeLimiter, (req, res) => {
  const c = db.calls.find(x => x.id === req.params.id);
  if (!c || c.to !== req.user.id || c.status !== 'ringing') fail(404, 'not_found');
  const answer = req.body?.answer;
  if (!answer || typeof answer.sdp !== 'string' || answer.sdp.length > 20000) fail(400, 'bad_offer');
  c.answer = { type: 'answer', sdp: String(answer.sdp).slice(0, 20000) };
  c.status = 'active'; c.updatedAt = Date.now();
  saveDB();
  res.json({ ok: true });
});
app.post('/api/calls/:id/ice', authNeed, writeLimiter, (req, res) => {
  const c = db.calls.find(x => x.id === req.params.id);
  if (!c || (c.from !== req.user.id && c.to !== req.user.id)) fail(404, 'not_found');
  if (c.status === 'ended') fail(404, 'not_found');
  const cand = req.body?.candidate;
  if (!cand || typeof cand.candidate !== 'string' || cand.candidate.length > 4000) fail(400, 'bad_ice');
  const mine = c.from === req.user.id;
  const arr = mine ? c.iceFrom : c.iceTo;
  if (arr.length > 100) fail(400, 'too_many');
  arr.push({ candidate: String(cand.candidate).slice(0, 4000), sdpMid: String(cand.sdpMid || '').slice(0, 64), sdpMLineIndex: Number(cand.sdpMLineIndex) || 0 });
  c.updatedAt = Date.now();
  saveDB();
  res.json({ ok: true, n: arr.length });
});
app.post('/api/calls/:id/reject', authNeed, writeLimiter, (req, res) => {
  const c = db.calls.find(x => x.id === req.params.id);
  if (!c || c.to !== req.user.id || c.status !== 'ringing') fail(404, 'not_found');
  c.status = 'ended'; c.updatedAt = Date.now();
  saveDB();
  res.json({ ok: true });
});
app.post('/api/calls/:id/hangup', authNeed, writeLimiter, (req, res) => {
  const c = db.calls.find(x => x.id === req.params.id);
  if (!c || (c.from !== req.user.id && c.to !== req.user.id)) fail(404, 'not_found');
  c.status = 'ended'; c.updatedAt = Date.now();
  saveDB();
  res.json({ ok: true });
});

// ───────────────────────── групповые звонки (комната + mesh-сигнал) ─────────────────────────
// Как работает: первый вошедший создаёт комнату, остальные подтягиваются.
// Новичок делает offer каждому, кто уже внутри; те отвечают. ICE — так же парами.
// Лимит 6 участников. Закрывается, когда вышел последний.
const GCALL_MAX = 6;
function openGRoom(gid) { return db.gcalls.find(r => r.groupId === gid && r.status === 'open'); }
function gRoomDTO(room) {
  const peers = Object.entries(room.peers || {}).map(([uid, p]) => {
    const u = usersById.get(uid);
    return { id: uid, name: u ? u.name : '?', avatar: u ? u.avatar || null : null, joinedAt: p.joinedAt, offers: p.offers, answers: p.answers, ice: p.ice };
  });
  return { id: room.id, groupId: room.groupId, kind: room.kind, by: room.by, createdAt: room.createdAt, peers };
}
app.post('/api/groups/:id/call', authNeed, writeLimiter, (req, res) => {
  const g = groupsById.get(req.params.id);
  if (!g) fail(404, 'not_found');
  if (!g.members[req.user.id] && !isMod(req.user)) fail(403, 'not_member');
  if (activeCallOf(req.user.id)) fail(409, 'busy_self');
  let room = openGRoom(g.id);
  if (room) {
    if (room.peers[req.user.id]) fail(409, 'busy_self');
    if (Object.keys(room.peers).length >= GCALL_MAX) fail(409, 'room_full');
    const kind = room.kind;
    room.peers[req.user.id] = { offers: {}, answers: {}, ice: {}, joinedAt: Date.now() };
    room.updatedAt = Date.now();
    saveDB();
    return res.json({ ...gRoomDTO(room), kind, joined: true });
  }
  const kind = req.body?.kind === 'video' ? 'video' : 'audio';
  room = { id: uid(), groupId: g.id, kind, by: req.user.id, status: 'open', peers: { [req.user.id]: { offers: {}, answers: {}, ice: {}, joinedAt: Date.now() } }, createdAt: Date.now(), updatedAt: Date.now() };
  db.gcalls.push(room); saveDB();
  res.json({ ...gRoomDTO(room), joined: true });
});
app.get('/api/groups/:id/call', authNeed, (req, res) => {
  const g = groupsById.get(req.params.id);
  if (!g) fail(404, 'not_found');
  if (!g.members[req.user.id] && !isMod(req.user)) fail(403, 'not_member');
  const room = openGRoom(g.id);
  if (!room) return res.json({ room: null });
  res.json({ room: gRoomDTO(room), inRoom: !!room.peers[req.user.id] });
});
app.post('/api/groups/:id/call/offer', authNeed, writeLimiter, (req, res) => {
  const room = openGRoom(req.params.id);
  if (!room || !room.peers[req.user.id]) fail(404, 'not_found');
  const to = String(req.body?.to || '');
  if (!room.peers[to] || to === req.user.id) fail(400, 'bad_request');
  const offer = req.body?.offer;
  if (!offer || typeof offer.sdp !== 'string' || offer.sdp.length > 20000) fail(400, 'bad_offer');
  room.peers[req.user.id].offers[to] = { type: 'offer', sdp: String(offer.sdp).slice(0, 20000) };
  room.updatedAt = Date.now();
  saveDB();
  res.json({ ok: true });
});
app.post('/api/groups/:id/call/answer', authNeed, writeLimiter, (req, res) => {
  const room = openGRoom(req.params.id);
  if (!room || !room.peers[req.user.id]) fail(404, 'not_found');
  const to = String(req.body?.to || '');
  if (!room.peers[to] || to === req.user.id) fail(400, 'bad_request');
  const answer = req.body?.answer;
  if (!answer || typeof answer.sdp !== 'string' || answer.sdp.length > 20000) fail(400, 'bad_offer');
  room.peers[req.user.id].answers[to] = { type: 'answer', sdp: String(answer.sdp).slice(0, 20000) };
  room.updatedAt = Date.now();
  saveDB();
  res.json({ ok: true });
});
app.post('/api/groups/:id/call/ice', authNeed, writeLimiter, (req, res) => {
  const room = openGRoom(req.params.id);
  if (!room || !room.peers[req.user.id]) fail(404, 'not_found');
  const to = String(req.body?.to || '');
  if (!room.peers[to] || to === req.user.id) fail(400, 'bad_request');
  const cand = req.body?.candidate;
  if (!cand || typeof cand.candidate !== 'string' || cand.candidate.length > 4000) fail(400, 'bad_ice');
  const arr = room.peers[req.user.id].ice[to] || (room.peers[req.user.id].ice[to] = []);
  if (arr.length > 100) fail(400, 'too_many');
  arr.push({ candidate: String(cand.candidate).slice(0, 4000), sdpMid: String(cand.sdpMid || '').slice(0, 64), sdpMLineIndex: Number(cand.sdpMLineIndex) || 0 });
  room.updatedAt = Date.now();
  saveDB();
  res.json({ ok: true });
});
app.post('/api/groups/:id/call/leave', authNeed, writeLimiter, (req, res) => {
  const room = openGRoom(req.params.id);
  if (!room || !room.peers[req.user.id]) return res.json({ ok: true });
  delete room.peers[req.user.id];
  if (!Object.keys(room.peers).length) {
    room.status = 'closed';
    db.gcalls = db.gcalls.filter(r => r.id !== room.id);
  }
  saveDB();
  res.json({ ok: true });
});
app.post('/api/groups/:id/call/end', authNeed, writeLimiter, (req, res) => {
  const g = groupsById.get(req.params.id);
  if (!g) fail(404, 'not_found');
  const room = openGRoom(g.id);
  if (!room) return res.json({ ok: true });
  if (g.ownerId !== req.user.id && !isAdmin(req.user)) fail(403, 'not_admin');
  db.gcalls = db.gcalls.filter(r => r.id !== room.id);
  saveDB();
  res.json({ ok: true });
});

// ───────────────────────── fallback и ошибки ─────────────────────────
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
// SPA: любой «путь страницы» отдаёт index.html (без кэша), а файлы — 404
app.use((req, res, next) => {
  if (req.method !== 'GET' || path.extname(req.path)) return next();
  serveIndex(req, res);
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
  computeAssetVersion();
  db = await loadDB();
  rebuildIndexes();
  // роли никому не выдаём и не снимаем при старте: только панель админа и /api/setup
  await store.save(db); // гарантируем, что данные есть в целевом хранилище
  server = app.listen(PORT, () => {
    console.log('WorkshopAG v5 on :' + PORT);
    console.log('хранилище: ' + store.kind + ' (' + store.source + ')' +
      (store.kind === 'file' && !MOUNT ? '  ⚠ ДАННЫЕ НЕ ПЕРЕЖИВУТ ДЕПЛОЙ — нужна БД или постоянный том' : '  ✓ переживает деплой'));
    console.log('версия ассетов: ' + ASSET_V);
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
