// WorkshopAG v3 — фикс кликов + SVG-иконки + анимации. Только онлайн API.
const $ = id => document.getElementById(id);
const LS = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }, del(k) { try { localStorage.removeItem(k); } catch (_) {} } };
let token = LS.get('wsa_token'), me = null, kind = 'all', mode = 'register';

// --- SVG-иконки (инлайн, feather-style, без внешних файлов) ---
const IC = inner => '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
const ICON = {
  like: IC('<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>'),
  dislike: IC('<path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H6.28a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>'),
  cmt: IC('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
  send: IC('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  x: IC('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  file: IC('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>')
};

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
  const btn = $('g-go'); btn.disabled = true; $('g-err').textContent = '…';
  try {
    const r = await api('/api/' + mode, { method: 'POST', body: JSON.stringify({ name, password }) });
    token = r.token; me = r.user; LS.set('wsa_token', token);
    $('g-err').textContent = ''; $('g-pass').value = '';
    showApp(); nav('feed'); await refreshMe(); load();
  } catch (e) { $('g-err').textContent = 'Ошибка: ' + e.message; }
  btn.disabled = false;
}

// --- навигация ---
function nav(p) {
  for (const [id, pg] of [['nav-feed', 'feed'], ['nav-add', 'add'], ['nav-me', 'me'], ['nav-set', 'set']]) {
    const page = $('page-' + pg), b = $(id);
    const on = pg === p;
    page.style.display = on ? 'block' : 'none';
    b.classList.toggle('on', on);
    if (on) { page.classList.remove('fade'); void page.offsetWidth; page.classList.add('fade'); }
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
  posts.forEach((p, i) => { const c = card(p); c.style.animationDelay = Math.min(i * 45, 400) + 'ms'; f.appendChild(c); });
}
function card(p) {
  const d = document.createElement('div'); d.className = 'card';
  d.innerHTML =
    '<div class="chead"><img src="' + (p.avatar ? esc(p.avatar) : 'AG.png') + '" alt=""><div><b>' + esc(p.author) + '</b><small>' + new Date(p.createdAt).toLocaleString('ru-RU') + '</small></div><span class="tag">' + (p.kind === 'build' ? 'ПОСТРОЙКА' : 'СНАРЯД') + '</span></div>' +
    '<div class="cbody"><b>' + esc(p.title) + '</b><br>' + esc(p.body || '') + '</div>' +
    (p.photo ? '<img class="main" loading="lazy" src="' + esc(p.photo) + '" alt="">' : '') +
    (p.jsonUrl ? '<div class="jsonline">' + ICON.file + ' <a href="' + esc(p.jsonUrl) + '" download="' + esc(p.jsonName || 'build.json') + '">' + esc(p.jsonName || 'чертёж.json') + '</a> — открой в игре</div>' : '') +
    '<div class="actions"><button class="small like' + (p.myVote === 1 ? ' on' : '') + '">' + ICON.like + '<span>' + p.likes + '</span></button>' +
    '<button class="small dis' + (p.myVote === -1 ? ' on' : '') + '">' + ICON.dislike + '<span>' + p.dislikes + '</span></button>' +
    '<button class="small cmt">' + ICON.cmt + '<span>' + p.comments + '</span></button>' +
    '<span class="score">' + (p.likes - p.dislikes > 0 ? '+' : '') + (p.likes - p.dislikes) + '</span>' +
    (me && p.authorId === me.id ? '<button class="small del" title="Удалить">' + ICON.x + '</button>' : '') + '</div>' +
    '<div class="comments" style="display:none"></div>' +
    '<div class="actions"><input placeholder="Комментарий…" maxlength="500"><button class="small primary send" title="Отправить">' + ICON.send + '</button></div>';
  const box = d.querySelector('.comments');
  const likeB = d.querySelector('.like'), disB = d.querySelector('.dis');
  likeB.onclick = () => { likeB.classList.add('pop'); setTimeout(() => likeB.classList.remove('pop'), 320); vote(p, p.myVote === 1 ? 0 : 1); };
  disB.onclick = () => { disB.classList.add('pop'); setTimeout(() => disB.classList.remove('pop'), 320); vote(p, p.myVote === -1 ? 0 : -1); };
  d.querySelector('.cmt').onclick = () => { box.style.display = box.style.display === 'none' ? 'flex' : 'none'; if (box.style.display === 'flex') loadComments(p, box); };
  d.querySelector('.send').onclick = () => sendComment(p, d.querySelector('input'), box);
  const del = d.querySelector('.del');
  if (del) del.onclick = async () => { if (confirm('Удалить пост?')) { try { await api('/api/posts/' + p.id, { method: 'DELETE' }); load(); } catch (e) { alert(e.message); } } };
  return d;
}
async function vote(p, value) {
  try { await api('/api/posts/' + p.id + '/vote', { method: 'POST', body: JSON.stringify({ value }) }); load(); }
  catch (e) { alert('Ошибка: ' + e.message); }
}
async function loadComments(p, box) {
  box.innerHTML = '<div class="hint">…</div>';
  try {
    const arr = await api('/api/posts/' + p.id + '/comments');
    box.innerHTML = arr.length ? '' : '<div class="hint">Комментов нет — напиши первым</div>';
    for (const c of arr) {
      const el = document.createElement('div'); el.className = 'cmt rise';
      el.innerHTML = '<b>' + esc(c.author) + '</b><small>' + new Date(c.createdAt).toLocaleString('ru-RU') + '</small><p>' + esc(c.text) + '</p>';
      if (me && c.authorId === me.id) {
        const x = document.createElement('button'); x.className = 'small'; x.innerHTML = ICON.x; x.title = 'Удалить';
        x.onclick = async () => { await api('/api/comments/' + c.id, { method: 'DELETE' }); loadComments(p, box); };
        el.appendChild(x);
      }
      box.appendChild(el);
    }
  } catch (e) { box.innerHTML = '<div class="hint">Ошибка: ' + esc(e.message) + '</div>'; }
}
async function sendComment(p, inp, box) {
  const text = inp.value.trim(); if (!text) return;
  try {
    await api('/api/posts/' + p.id + '/comments', { method: 'POST', body: JSON.stringify({ text }) });
    inp.value = ''; box.style.display = 'flex'; loadComments(p, box); load();
  } catch (e) { alert('Ошибка: ' + e.message); }
}

// --- публикация: текст + фото + JSON ---
async function publish() {
  const title = $('title').value.trim();
  if (title.length < 2) return alert('Дай название');
  const fd = new FormData();
  fd.append('title', title);
  fd.append('body', $('body').value.trim());
  fd.append('kind', $('kind').value);
  if ($('photo').files[0]) fd.append('photo', $('photo').files[0]);
  if ($('jsonfile').files[0]) fd.append('jsonfile', $('jsonfile').files[0]);
  const btn = $('publish'); btn.disabled = true; btn.textContent = 'ПУБЛИКУЮ…';
  try {
    await api('/api/posts', { method: 'POST', body: fd });
    $('title').value = ''; $('body').value = ''; $('photo').value = ''; $('jsonfile').value = '';
    $('preview').style.display = 'none'; $('jname').textContent = '';
    nav('feed'); load();
  } catch (e) { alert('Ошибка: ' + e.message); }
  btn.disabled = false; btn.textContent = 'ОПУБЛИКОВАТЬ';
}

// --- мой акк / настройки ---
async function refreshMe() {
  const r = await api('/api/me'); me = r.user;
  if (!me) { token = null; LS.del('wsa_token'); showGate(); return; }
}
async function loadMine() {
  if (!me) return;
  $('myname').textContent = me.name;
  $('myava').src = me.avatar || 'AG.png';
  try {
    const posts = await api('/api/me/posts');
    $('mystats').textContent = 'постов: ' + posts.length;
    const box = $('mylist'); box.innerHTML = posts.length ? '' : '<div class="hint">У тебя пока нет постов</div>';
    posts.forEach((p, i) => { const c = card(p); c.style.animationDelay = Math.min(i * 45, 400) + 'ms'; box.appendChild(c); });
  } catch (e) { $('mylist').innerHTML = '<div class="hint">Ошибка: ' + esc(e.message) + '</div>'; }
}
async function loadSettings() {
  if (!me) return;
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
    const r = await fetch('/api/me', { method: 'PATCH', headers: authH(), body: fd }).then(x => { if (!x.ok) throw new Error('save_fail'); return x.json(); });
    token = r.token; LS.set('wsa_token', token); me = r.user;
    $('s-pass').value = ''; $('s-ava').value = '';
    alert('Сохранено');
  } catch (_) { alert('Ошибка сохранения (ник занят?)'); }
}

// --- init: обработчики вешаем ВСЕГДА (был баг: без токена кнопки умирали) ---
function init() {
  $('g-reg').onclick = () => { mode = 'register'; syncGate(); };
  $('g-log').onclick = () => { mode = 'login'; syncGate(); };
  $('g-go').onclick = gateGo;
  $('g-pass').addEventListener('keydown', e => { if (e.key === 'Enter') gateGo(); });
  $('g-name').addEventListener('keydown', e => { if (e.key === 'Enter') gateGo(); });
  syncGate();
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
    else $('preview').style.display = 'none';
  };
  $('jsonfile').onchange = () => { $('jname').textContent = $('jsonfile').files[0]?.name || ''; };
  $('s-save').onclick = saveSettings;
  $('logout').onclick = () => { token = null; me = null; LS.del('wsa_token'); showGate(); };
  $('delacc').onclick = async () => {
    if (!confirm('Удалить аккаунт и все посты?')) return;
    try { await api('/api/me', { method: 'DELETE' }); } catch (_) {}
    token = null; me = null; LS.del('wsa_token'); showGate();
  };
  if (!token) { showGate(); return; }
  showApp();
  refreshMe().then(() => { nav('feed'); load(); }).catch(() => showGate());
}
function syncTabs() {
  $('tab-all').classList.toggle('on', kind === 'all');
  $('tab-proj').classList.toggle('on', kind === 'proj');
  $('tab-build').classList.toggle('on', kind === 'build');
}
init();
