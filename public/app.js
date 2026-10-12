// WorkshopAG v2 — гейт входа → TikTok-лента → настройки/акк. Только онлайн API.
const $ = id => document.getElementById(id);
const LS = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }, del(k) { try { localStorage.removeItem(k); } catch (_) {} } };
let token = LS.get('wsa_token'), me = null, kind = 'all', mode = 'register';

const authH = () => token ? { Authorization: 'Bearer ' + token } : {};
async function api(path, opt = {}) {
  const isFD = opt.body instanceof FormData;
  const r = await fetch(path, { headers: { ...(isFD ? {} : { 'Content-Type': 'application/json' }), ...authH() }, ...opt });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || ('http_' + r.status)); }
  return r.json();
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- гейт ---
function showGate() { $('gate').style.display = 'flex'; $('app').style.display = 'none'; }
function showApp() { $('gate').style.display = 'none'; $('app').style.display = 'flex'; }
function syncGate() {
  $('g-reg').classList.toggle('on', mode === 'register');
  $('g-log').classList.toggle('on', mode === 'login');
  $('g-go').textContent = mode === 'register' ? 'СОЗДАТЬ АКК →' : 'ВОЙТИ →';
}
async function gateGo() {
  const name = $('g-name').value.trim(), password = $('g-pass').value;
  if (name.length < 2 || password.length < 4) { $('g-err').textContent = 'Ник от 2 букв, пароль от 4 символов'; return; }
  $('g-err').textContent = '…';
  try {
    const r = await api('/api/' + mode, { method: 'POST', body: JSON.stringify({ name, password }) });
    token = r.token; me = r.user; LS.set('wsa_token', token);
    $('g-err').textContent = '';
    showApp(); await refreshMe(); load();
  } catch (e) { $('g-err').textContent = 'Ошибка: ' + e.message; }
}

// --- навигация ---
function nav(p) {
  for (const [id, pg] of [['nav-feed', 'feed'], ['nav-add', 'add'], ['nav-me', 'me'], ['nav-set', 'set']]) {
    $('page-' + pg).style.display = pg === p ? 'block' : 'none';
    $(id).classList.toggle('on', pg === p);
  }
  if (p === 'me') loadMine();
  if (p === 'set') loadSettings();
  window.scrollTo({ top: 0 });
}

// --- лента ---
async function load() {
  const q = $('q').value.trim(), sort = $('sort').value;
  let posts;
  try {
    posts = await api('/api/posts?' + new URLSearchParams({ kind, q, sort }));
  } catch (e) { $('empty').style.display = 'block'; $('empty').textContent = 'Нет связи с сервером: ' + e.message; $('feed').innerHTML = ''; return; }
  const f = $('feed'); f.innerHTML = '';
  $('empty').style.display = posts.length ? 'none' : 'block';
  for (const p of posts) f.appendChild(card(p));
}
function card(p) {
  const d = document.createElement('div'); d.className = 'card';
  d.innerHTML =
    '<div class="chead"><img src="' + (p.avatar ? esc(p.avatar) : 'AG.png') + '"><div><b>' + esc(p.author) + '</b><small>' + new Date(p.createdAt).toLocaleString('ru-RU') + '</small></div><span class="tag">' + (p.kind === 'build' ? 'ПОСТРОЙКА' : 'СНАРЯД') + '</span></div>' +
    '<div class="cbody"><b>' + esc(p.title) + '</b><br>' + esc(p.body || '') + '</div>' +
    (p.photo ? '<img class="main" loading="lazy" src="' + esc(p.photo) + '">' : '') +
    (p.jsonUrl ? '<div class="jsonline">🧩 <a href="' + esc(p.jsonUrl) + '" download="' + esc(p.jsonName || 'build.json') + '">' + esc(p.jsonName || 'чертёж.json') + '</a> — открой в игре</div>' : '') +
    '<div class="actions"><button class="small like">👍 ' + p.likes + '</button><button class="small dis">👎 ' + p.dislikes + '</button><button class="small cmt">💬 ' + p.comments + '</button><span class="score">' + (p.likes - p.dislikes > 0 ? '+' : '') + (p.likes - p.dislikes) + '</span>' + (me && p.authorId === me.id ? '<button class="small del">✕</button>' : '') + '</div>' +
    '<div class="comments" style="display:none"></div>' +
    '<div class="actions"><input placeholder="Комментарий…" maxlength="500"><button class="small primary send">→</button></div>';
  const box = d.querySelector('.comments');
  d.querySelector('.like').onclick = e => vote(p, p.myVote === 1 ? 0 : 1, e.target);
  d.querySelector('.dis').onclick = e => vote(p, p.myVote === -1 ? 0 : -1, e.target);
  d.querySelector('.cmt').onclick = () => { box.style.display = box.style.display === 'none' ? 'flex' : 'none'; if (box.style.display === 'flex') loadComments(p, box); };
  d.querySelector('.send').onclick = () => sendComment(p, d.querySelector('input'), box, load);
  const del = d.querySelector('.del');
  if (del) del.onclick = async () => { if (confirm('Удалить пост?')) { await api('/api/posts/' + p.id, { method: 'DELETE' }); load(); } };
  return d;
}
async function vote(p, value) { await api('/api/posts/' + p.id + '/vote', { method: 'POST', body: JSON.stringify({ value }) }); load(); }
async function loadComments(p, box) {
  box.innerHTML = '<div class="hint">…</div>';
  const arr = await api('/api/posts/' + p.id + '/comments');
  box.innerHTML = arr.length ? '' : '<div class="hint">Комментов нет — напиши первым</div>';
  for (const c of arr) {
    const el = document.createElement('div'); el.className = 'cmt';
    el.innerHTML = '<b>' + esc(c.author) + '</b><small>' + new Date(c.createdAt).toLocaleString('ru-RU') + '</small><p>' + esc(c.text) + '</p>';
    if (me && c.authorId === me.id) {
      const x = document.createElement('button'); x.className = 'small'; x.textContent = '✕';
      x.onclick = async () => { await api('/api/comments/' + c.id, { method: 'DELETE' }); loadComments(p, box); };
      el.appendChild(x);
    }
    box.appendChild(el);
  }
}
async function sendComment(p, inp, box, reload) {
  const text = inp.value.trim(); if (!text) return;
  await api('/api/posts/' + p.id + '/comments', { method: 'POST', body: JSON.stringify({ text }) });
  inp.value = ''; box.style.display = 'flex'; loadComments(p, box); if (reload) load();
}

// --- публикация: текст + фото + JSON ---
async function publish() {
  const fd = new FormData();
  fd.append('title', $('title').value.trim());
  fd.append('body', $('body').value.trim());
  fd.append('kind', $('kind').value);
  if ($('photo').files[0]) fd.append('photo', $('photo').files[0]);
  if ($('jsonfile').files[0]) fd.append('jsonfile', $('jsonfile').files[0]);
  if (fd.get('title').length < 2) return alert('Дай название');
  try {
    await api('/api/posts', { method: 'POST', body: fd });
    $('title').value = ''; $('body').value = ''; $('photo').value = ''; $('jsonfile').value = '';
    $('preview').style.display = 'none'; $('jname').textContent = '';
    nav('feed'); load();
  } catch (e) { alert('Ошибка: ' + e.message); }
}

// --- мой акк / настройки ---
async function refreshMe() {
  const r = await api('/api/me'); me = r.user;
  if (!me) { token = null; LS.del('wsa_token'); showGate(); return; }
}
async function loadMine() {
  $('myname').textContent = me.name;
  $('myava').src = me.avatar || 'AG.png';
  const posts = await api('/api/me/posts');
  $('mystats').textContent = 'постов: ' + posts.length;
  const box = $('mylist'); box.innerHTML = posts.length ? '' : '<div class="hint">У тебя пока нет постов</div>';
  for (const p of posts) box.appendChild(card(p));
}
async function loadSettings() {
  $('s-name').value = me.name;
  try { const h = await api('/api/health'); $('health').textContent = 'Сервер ок · постов: ' + h.posts + ' · юзеров: ' + h.users; }
  catch (_) { $('health').textContent = 'Сервер недоступен'; }
}
async function saveSettings() {
  const fd = new FormData();
  fd.append('name', $('s-name').value.trim());
  if ($('s-pass').value) fd.append('password', $('s-pass').value);
  if ($('s-ava').files[0]) fd.append('avatar', $('s-ava').files[0]);
  try {
    const r = await fetch('/api/me', { method: 'PATCH', headers: authH(), body: fd }).then(x => { if (!x.ok) throw new Error('err'); return x.json(); });
    token = r.token; LS.set('wsa_token', token); me = r.user;
    alert('Сохранено'); loadMine();
  } catch (_) { alert('Ошибка сохранения (ник занят?)'); }
}

function init() {
  $('g-reg').onclick = () => { mode = 'register'; syncGate(); };
  $('g-log').onclick = () => { mode = 'login'; syncGate(); };
  $('g-go').onclick = gateGo;
  $('g-pass').addEventListener('keydown', e => { if (e.key === 'Enter') gateGo(); });
  syncGate();
  if (!token) { showGate(); return; }
  showApp();
  refreshMe().then(load).catch(() => showGate());
  $('tab-all').onclick = () => { kind = 'all'; syncTabs(); load(); };
  $('tab-proj').onclick = () => { kind = 'proj'; syncTabs(); load(); };
  $('tab-build').onclick = () => { kind = 'build'; syncTabs(); load(); };
  $('q').oninput = load; $('sort').onchange = load;
  $('nav-feed').onclick = () => nav('feed'); $('nav-add').onclick = () => nav('add');
  $('nav-me').onclick = () => nav('me'); $('nav-set').onclick = () => nav('set');
  $('publish').onclick = publish;
  $('photo').onchange = () => {
    const f = $('photo').files[0];
    if (f) { $('preview').src = URL.createObjectURL(f); $('preview').style.display = 'block'; }
  };
  $('jsonfile').onchange = () => { $('jname').textContent = $('jsonfile').files[0]?.name || ''; };
  $('s-save').onclick = saveSettings;
  $('logout').onclick = () => { token = null; me = null; LS.del('wsa_token'); showGate(); };
  $('delacc').onclick = async () => {
    if (!confirm('Удалить аккаунт и все посты?')) return;
    await api('/api/me', { method: 'DELETE' });
    token = null; me = null; LS.del('wsa_token'); showGate();
  };
}
function syncTabs() {
  $('tab-all').classList.toggle('on', kind === 'all');
  $('tab-proj').classList.toggle('on', kind === 'proj');
  $('tab-build').classList.toggle('on', kind === 'build');
}
init();
