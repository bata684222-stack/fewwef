// WorkshopAG v2 — без демо-постов, с фото и JSON в постах
// Auth-гейт на фронте, TikTok-лента, настройки, мой аккаунт
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const UP_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UP_DIR, { recursive: true });

// --- чистая база, никаких примеров: только реальные люди ---
function emptyDB() { return { users: [], posts: [], comments: [], votes: [] }; }
function loadDB() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    db.users = db.users || []; db.posts = db.posts || [];
    db.comments = db.comments || []; db.votes = db.votes || [];
    return db;
  } catch (_) { const d = emptyDB(); saveDB(d); return d; }
}
function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}
let db = loadDB();
const uid = () => crypto.randomUUID();

// --- загрузка файлов: фото (5MB) + JSON (1MB) + аватар ---
const storage = multer.diskStorage({
  destination: (_r, _f, cb) => cb(null, UP_DIR),
  filename: (_r, f, cb) => {
    const ext = path.extname(f.originalname || '').slice(0, 6) || '.bin';
    cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
  }
});
function fileFilter(_r, f, cb) {
  if (f.fieldname === 'photo' || f.fieldname === 'avatar') {
    if (/^image\/(png|jpe?g|webp|gif)$/.test(f.mimetype)) return cb(null, true);
    return cb(new Error('only_images'));
  }
  if (f.fieldname === 'jsonfile') {
    if (f.mimetype === 'application/json' || f.originalname.endsWith('.json')) return cb(null, true);
    return cb(new Error('only_json'));
  }
  cb(null, false);
}
const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024, files: 3 } });

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function authOpt(req, _res, next) {
  req.user = null;
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (t) { try { req.user = jwt.verify(t, JWT_SECRET); } catch (_) {} }
  next();
}
function authNeed(req, res, next) {
  authOpt(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'need_auth' });
    next();
  });
}
function postDTO(p, userId) {
  const vl = db.votes.filter(v => v.postId === p.id && v.value === 1).length;
  const vd = db.votes.filter(v => v.postId === p.id && v.value === -1).length;
  const comments = db.comments.filter(c => c.postId === p.id).length;
  const mine = userId ? (db.votes.find(v => v.postId === p.id && v.userId === userId)?.value || 0) : 0;
  return { ...p, likes: vl, dislikes: vd, comments, myVote: mine };
}
function pubUser(u) { return { id: u.id, name: u.name, avatar: u.avatar || null, createdAt: u.createdAt }; }

// ---- auth ----
app.post('/api/register', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 20);
  const password = String(req.body?.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'short_name' });
  if (password.length < 4) return res.status(400).json({ error: 'short_pass' });
  if (db.users.find(u => u.name.toLowerCase() === name.toLowerCase()))
    return res.status(409).json({ error: 'name_taken' });
  const u = { id: uid(), name, pass: bcrypt.hashSync(password, 8), avatar: null, createdAt: Date.now() };
  db.users.push(u); saveDB(db);
  const token = jwt.sign({ id: u.id, name: u.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: pubUser(u) });
});
app.post('/api/login', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  const u = db.users.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!u || !bcrypt.compareSync(password, u.pass)) return res.status(401).json({ error: 'bad_login' });
  const token = jwt.sign({ id: u.id, name: u.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: pubUser(u) });
});
app.get('/api/me', authOpt, (req, res) => {
  if (!req.user) return res.json({ user: null });
  const u = db.users.find(x => x.id === req.user.id);
  if (!u) return res.json({ user: null });
  const mine = db.posts.filter(p => p.authorId === u.id).length;
  res.json({ user: { ...pubUser(u), posts: mine } });
});
// настройки: смена ника/пароля + аватар
app.patch('/api/me', authNeed, upload.single('avatar'), (req, res) => {
  const u = db.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 20) : u.name;
  if (name.length < 2) return res.status(400).json({ error: 'short_name' });
  if (name.toLowerCase() !== u.name.toLowerCase() && db.users.find(x => x.name.toLowerCase() === name.toLowerCase()))
    return res.status(409).json({ error: 'name_taken' });
  u.name = name;
  if (req.body?.password) {
    if (String(req.body.password).length < 4) return res.status(400).json({ error: 'short_pass' });
    u.pass = bcrypt.hashSync(String(req.body.password), 8);
  }
  if (req.file) {
    if (u.avatar) { try { fs.unlinkSync(path.join(__dirname, 'public', u.avatar)); } catch (_) {} }
    u.avatar = 'uploads/' + req.file.filename;
  }
  // обновить имя автора в его постах/комментах
  for (const p of db.posts) if (p.authorId === u.id) p.author = u.name;
  for (const c of db.comments) if (c.authorId === u.id) c.author = u.name;
  saveDB(db);
  const token = jwt.sign({ id: u.id, name: u.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: pubUser(u) });
});
app.delete('/api/me', authNeed, (req, res) => {
  const u = db.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const ids = db.posts.filter(p => p.authorId === u.id).map(p => p.id);
  db.posts = db.posts.filter(p => p.authorId !== u.id);
  db.comments = db.comments.filter(c => c.authorId !== u.id && !ids.includes(c.postId));
  db.votes = db.votes.filter(v => v.userId !== u.id && !ids.includes(v.postId));
  db.users = db.users.filter(x => x.id !== u.id);
  saveDB(db);
  res.json({ ok: true });
});
app.get('/api/me/posts', authNeed, (req, res) => {
  res.json(db.posts.filter(p => p.authorId === req.user.id).map(p => postDTO(p, req.user.id)));
});

// ---- posts: текст + фото + JSON-файл ----
app.get('/api/posts', authOpt, (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const kind = String(req.query.kind || 'all');
  const sort = String(req.query.sort || 'new');
  let list = db.posts.slice();
  if (kind !== 'all') list = list.filter(p => p.kind === kind);
  if (q) list = list.filter(p => (p.title + ' ' + (p.body || '')).toLowerCase().includes(q));
  list = list.map(p => postDTO(p, req.user?.id));
  if (sort === 'top') list.sort((a, b) => (b.likes - b.dislikes) - (a.likes - a.dislikes));
  else list.sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});
app.post('/api/posts', authNeed, upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'jsonfile', maxCount: 1 }]), (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 80);
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  const kind = req.body?.kind === 'build' ? 'build' : 'proj';
  if (title.length < 2) return res.status(400).json({ error: 'short_title' });
  const photo = req.files?.photo?.[0] ? 'uploads/' + req.files.photo[0].filename : null;
  let jsonUrl = null, jsonName = null;
  if (req.files?.jsonfile?.[0]) {
    jsonUrl = 'uploads/' + req.files.jsonfile[0].filename;
    jsonName = req.files.jsonfile[0].originalname;
    // проверить что это валидный JSON
    try { JSON.parse(fs.readFileSync(path.join(__dirname, 'public', jsonUrl), 'utf-8')); }
    catch (_) { try { fs.unlinkSync(path.join(__dirname, 'public', jsonUrl)); } catch (_) {} return res.status(400).json({ error: 'bad_json' }); }
  }
  const u = db.users.find(x => x.id === req.user.id);
  const p = { id: uid(), title, body, kind, photo, jsonUrl, jsonName, author: u?.name || req.user.name, authorId: req.user.id, avatar: u?.avatar || null, createdAt: Date.now() };
  db.posts.unshift(p); saveDB(db);
  res.json(postDTO(p, req.user.id));
});
app.delete('/api/posts/:id', authNeed, (req, res) => {
  const p = db.posts.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  if (p.authorId !== req.user.id) return res.status(403).json({ error: 'not_yours' });
  for (const f of [p.photo, p.jsonUrl]) if (f) { try { fs.unlinkSync(path.join(__dirname, 'public', f)); } catch (_) {} }
  db.posts = db.posts.filter(x => x.id !== p.id);
  db.comments = db.comments.filter(c => c.postId !== p.id);
  db.votes = db.votes.filter(v => v.postId !== p.id);
  saveDB(db);
  res.json({ ok: true });
});
app.post('/api/posts/:id/vote', authNeed, (req, res) => {
  const p = db.posts.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  let v = Number(req.body?.value);
  v = v >= 1 ? 1 : v <= -1 ? -1 : 0;
  db.votes = db.votes.filter(x => !(x.postId === p.id && x.userId === req.user.id));
  if (v !== 0) db.votes.push({ postId: p.id, userId: req.user.id, value: v });
  saveDB(db);
  res.json(postDTO(p, req.user.id));
});

// ---- comments ----
app.get('/api/posts/:id/comments', (req, res) => {
  res.json(db.comments.filter(c => c.postId === req.params.id).sort((a, b) => a.createdAt - b.createdAt));
});
app.post('/api/posts/:id/comments', authNeed, (req, res) => {
  const p = db.posts.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'empty' });
  const u = db.users.find(x => x.id === req.user.id);
  const c = { id: uid(), postId: p.id, author: u?.name || req.user.name, authorId: req.user.id, text, createdAt: Date.now() };
  db.comments.push(c); saveDB(db);
  res.json(c);
});
app.delete('/api/comments/:id', authNeed, (req, res) => {
  const c = db.comments.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  if (c.authorId !== req.user.id) return res.status(403).json({ error: 'not_yours' });
  db.comments = db.comments.filter(x => x.id !== c.id);
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, posts: db.posts.length, users: db.users.length }));
app.use((err, _req, res, _next) => {
  if (err?.message === 'only_images') return res.status(400).json({ error: 'only_images' });
  if (err?.message === 'only_json') return res.status(400).json({ error: 'only_json' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'file_too_big' });
  return res.status(500).json({ error: 'server_error' });
});
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('WorkshopAG v2 on :' + PORT));
