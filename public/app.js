// WorkshopAG v4 — удобный интерфейс: догрузка ленты, мгновенные лайки, тосты, лайтбокс
'use strict';
const $ = id => document.getElementById(id);
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} }
};

let token = LS.get('wsa_token'), me = null;
let kind = 'all', sort = 'new', mode = 'register', postKind = 'proj';
let curPage = null, feedDirty = true;
let forumCats = [], forumCat = 'all', curThread = null;
let dmPeer = null, dmName = '', dmTimer = null;
const PAGE = 12;
const feed = { offset: 0, total: 0, busy: false, done: false, req: 0 };

// ───────── иконки ─────────
const IC = inner => '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
const ICON = {
  like: IC('<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>'),
  dislike: IC('<path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H6.28a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>'),
  cmt: IC('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
  send: IC('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  x: IC('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  file: IC('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
  download: IC('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  trash: IC('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
  search: IC('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  eye: IC('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: IC('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'),
  image: IC('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
  edit: IC('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  up: IC('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
  check: IC('<polyline points="20 6 9 17 4 12"/>'),
  logout: IC('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  home: IC('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
  forum: IC('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  mail: IC('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  check: IC('<polyline points="20 6 9 17 4 12"/>'),
  shield: IC('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  shieldCheck: IC('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15.5 9.5"/>'),
  crown: IC('<path d="M3 18h18l-1.6-9-4.4 3L12 5 8 12 3.6 9z"/><line x1="3" y1="21" x2="21" y2="21"/>'),
  bot: IC('<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4"/><circle cx="9" cy="14" r="1.2"/><circle cx="15" cy="14" r="1.2"/><line x1="2" y1="13" x2="4" y2="13"/><line x1="20" y1="13" x2="22" y2="13"/>'),
  users: IC('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  userPlus: IC('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>'),
  megaphone: IC('<path d="M3 11l15-6v14L3 13z"/><path d="M3 11v2a2 2 0 0 0 2 2h1v3a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-4"/>'),
  back: IC('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  bell: IC('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
  plus: IC('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  user: IC('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  gear: IC('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>')
};

// ───────── утилиты ─────────
const esc = s => String(s ?? '').replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const url = u => u ? '/' + String(u).replace(/^\/+/, '') : '';
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return (s / 60 | 0) + ' мин назад';
  if (s < 86400) return (s / 3600 | 0) + ' ч назад';
  if (s < 604800) return (s / 86400 | 0) + ' дн назад';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}
const ERR = {
  short_name: 'Ник слишком короткий (от 2 символов)', bad_name: 'Ник: только буквы, цифры, _ - . и пробел',
  short_pass: 'Пароль от 4 символов', long_pass: 'Пароль слишком длинный', name_taken: 'Этот ник уже занят',
  bad_login: 'Неверный ник или пароль', need_auth: 'Нужно войти заново', too_many_requests: 'Слишком много попыток — подожди немного',
  file_too_big: 'Файл слишком большой', only_images: 'Нужна картинка png/jpg/webp/gif', only_json: 'Нужен файл .json',
  bad_json: 'Файл — не корректный JSON', short_title: 'Название слишком короткое', not_found: 'Не найдено',
  not_yours: 'Это не твоё', empty: 'Пусто', server_error: 'Ошибка сервера, попробуй позже', bad_upload: 'Ошибка загрузки файла',
  too_big: 'Слишком большой запрос', bad_request: 'Так нельзя', bad_reaction: 'Такой реакции нет',
  reserved_name: 'Этот ник зарезервирован владельцем', use_register: 'Зарегистрируйся как обычно', last_admin: 'Нельзя: это последний админ', not_admin: 'Нужны права'
};
const errText = e => ERR[e.message] || (/^http_/.test(e.message) ? 'Ошибка сети (' + e.message.slice(5) + ')' : 'Нет связи с сервером');

function toast(msg, type = 'info') {
  const box = $('toasts'), t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  box.appendChild(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 3200);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn._html = btn.innerHTML; btn.disabled = true; if (label) btn.textContent = label; }
  else { btn.disabled = false; if (btn._html) btn.innerHTML = btn._html; }
}

// ───────── API ─────────
const authH = () => token ? { Authorization: 'Bearer ' + token } : {};
async function request(path, opt = {}) {
  const isFD = opt.body instanceof FormData;
  const headers = { ...(isFD || !opt.body ? {} : { 'Content-Type': 'application/json' }), ...authH() };
  const r = await fetch(path, { ...opt, headers });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    if (r.status === 401 && token) logout('Сессия истекла — войди снова');
    throw new Error(e.error || 'http_' + r.status);
  }
  return r;
}
const api = (p, o) => request(p, o).then(r => r.json());

// ───────── вход ─────────
function showGate() { $('gate').style.display = 'flex'; $('app').style.display = 'none'; }
function showApp() { $('gate').style.display = 'none'; $('app').style.display = 'flex'; }
function logout(msg) {
  token = null; me = null; LS.del('wsa_token'); curPage = null; feedDirty = true;
  stopDmPoll(); dmPeer = null; forumCats = []; forumCat = 'all'; curThread = null;
  $('dm-dot').hidden = true;
  $('feed').replaceChildren(); $('mylist').replaceChildren();
  showGate(); if (msg) toast(msg);
}
function syncGate() {
  const reg = mode === 'register';
  $('g-reg').classList.toggle('on', reg); $('g-reg').setAttribute('aria-selected', reg);
  $('g-log').classList.toggle('on', !reg); $('g-log').setAttribute('aria-selected', !reg);
  $('g-go').textContent = reg ? 'Создать аккаунт →' : 'Войти →';
  $('g-pass').autocomplete = reg ? 'new-password' : 'current-password';
  $('g-err').textContent = '';
}
async function gateGo() {
  const name = $('g-name').value.trim(), password = $('g-pass').value;
  if (name.length < 2) { $('g-err').textContent = ERR.short_name; $('g-name').focus(); return; }
  if (password.length < 4) { $('g-err').textContent = ERR.short_pass; $('g-pass').focus(); return; }
  const btn = $('g-go'); busy(btn, true, 'Подожди…'); $('g-err').textContent = '';
  try {
    const r = await api('/api/' + mode, { method: 'POST', body: JSON.stringify({ name, password }) });
    token = r.token; me = r.user; LS.set('wsa_token', token);
    $('g-pass').value = '';
    showApp(); curPage = null; feedDirty = true; nav('feed'); startDmPoll();
  } catch (e) { $('g-err').textContent = errText(e); }
  busy(btn, false);
}
function bindEye(btnId, inputId) {
  const b = $(btnId), i = $(inputId);
  b.onclick = () => {
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    b.innerHTML = show ? ICON.eyeOff : ICON.eye;
    b.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
  };
}

// ───────── навигация ─────────
const PAGES = [['nav-feed', 'feed'], ['nav-forum', 'forum'], ['nav-add', 'add'], ['nav-dm', 'dm'], ['nav-me', 'me'], ['nav-set', 'set'], ['nav-user', 'user'], ['nav-admin', 'admin']];
function nav(p) {
  if (p === 'feed' && curPage === 'feed') { window.scrollTo({ top: 0, behavior: 'smooth' }); load(); return; }
  curPage = p;
  $('page-thread').style.display = p === 'thread' ? 'block' : 'none';
  for (const [id, pg] of PAGES) {
    const page = $('page-' + pg), b = $(id), on = pg === p;
    if (!page) continue;
    page.style.display = on ? 'block' : 'none';
    b?.classList.toggle('on', on);
    if (on) { b?.setAttribute('aria-current', 'page'); page.classList.remove('fade'); void page.offsetWidth; page.classList.add('fade'); }
    else b?.removeAttribute('aria-current');
  }
  if (p === 'feed' && feedDirty) { feedDirty = false; load(); loadBroadcast(); }
  if (p === 'forum' && !forumCats.length) loadForums();
  else if (p === 'forum') loadThreads();
  if (p === 'dm') { dmToList(); botChat = null; loadConvos(); pollUnread(); }
  if (p === 'me') loadMine();
  if (p === 'set') loadSettings();
  if (p === 'admin') loadAdmin();
  window.scrollTo({ top: 0 });
}

// ───────── лента ─────────
function skeletons(n = 3) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div'); s.className = 'card sk';
    s.innerHTML = '<i class="l1"></i><i class="l2"></i><i class="l3"></i>';
    frag.appendChild(s);
  }
  return frag;
}
function showEmpty(html) { const e = $('empty'); e.innerHTML = html; e.hidden = false; }
function emptyIfNeeded() {
  if ($('feed').children.length) return;
  const q = $('q').value.trim();
  showEmpty(q
    ? ICON.search + '<b>Ничего не найдено</b><span>По запросу «' + esc(q) + '» постов нет</span>'
    : ICON.image + '<b>Пока пусто</b><span>Стань первым — опубликуй свой снаряд или постройку</span><button class="primary" data-go="add">' + ICON.plus + ' Создать пост</button>');
}
async function load(reset = true) {
  if (reset) {
    feed.offset = 0; feed.done = false; feed.req++; feed.busy = false;
    $('empty').hidden = true; $('feed').replaceChildren(skeletons());
  } else if (feed.busy || feed.done) return;
  const my = feed.req; feed.busy = true; $('more').hidden = reset;
  try {
    const params = new URLSearchParams({ kind, q: $('q').value.trim(), sort, limit: PAGE, offset: feed.offset });
    const r = await request('/api/posts?' + params);
    const total = Number(r.headers.get('X-Total-Count'));
    const posts = await r.json();
    if (my !== feed.req) return; // пришёл устаревший ответ
    const f = $('feed');
    if (reset) f.replaceChildren();
    const frag = document.createDocumentFragment();
    posts.forEach((p, i) => { const c = card(p); c.style.animationDelay = Math.min(i * 40, 300) + 'ms'; frag.appendChild(c); });
    f.appendChild(frag);
    feed.offset += posts.length;
    feed.done = posts.length < PAGE || (total > 0 && feed.offset >= total);
    if (total) { feed.total = total; $('count').textContent = 'Постов: ' + total; } else $('count').textContent = '';
    emptyIfNeeded();
  } catch (e) {
    if (my !== feed.req) return;
    if (reset) {
      $('feed').replaceChildren();
      showEmpty('<b>Не получилось загрузить</b><span>' + esc(errText(e)) + '</span><button data-go="retry">Повторить</button>');
    } else toast(errText(e), 'err');
  } finally {
    if (my === feed.req) {
      feed.busy = false; $('more').hidden = true;
      const s = $('sentinel').getBoundingClientRect(); // если экран ещё не заполнен — подгружаем дальше
      if (!feed.done && curPage === 'feed' && s.top < innerHeight + 400) load(false);
    }
  }
}

function card(p) {
  const d = document.createElement('article');
  d.className = 'card'; d.dataset.id = p.id;
  const own = me && p.authorId === me.id;
  const canDel = own || canAdmin();
  d.innerHTML =
    '<div class="chead"><img class="ava" src="' + (p.avatar ? esc(url(p.avatar)) : 'AG.png') + '" alt="" width="40" height="40" loading="lazy">' +
      '<div class="who"><b>' + nameLink(p.author, p.authorId, p.authorBadge) + '</b><small title="' + esc(new Date(p.createdAt).toLocaleString('ru-RU')) + '">' + ago(p.createdAt) + '</small></div>' +
      '<span class="tag">' + (p.kind === 'build' ? 'ПОСТРОЙКА' : 'СНАРЯД') + '</span></div>' +
    '<div class="cbody"><h4 class="ctitle">' + esc(p.title) + '</h4>' + (p.body ? '<div class="ctext">' + esc(p.body) + '</div>' : '') + '</div>' +
    (p.photo ? '<img class="main" loading="lazy" decoding="async" src="' + esc(url(p.photo)) + '" alt="' + esc(p.title) + '">' : '') +
    (p.jsonUrl ? '<div class="jsonbox">' + ICON.file + '<span class="jn">' + esc(p.jsonName || 'чертёж.json') + '</span>' +
      '<a class="btn small" href="' + esc(url(p.jsonUrl)) + '" download="' + esc(p.jsonName || 'build.json') + '">' + ICON.download + 'Скачать</a></div>' : '') +
    '<div class="actions">' +
      '<button class="chip like" type="button" aria-label="Нравится">' + ICON.like + '<span></span></button>' +
      '<button class="chip dis" type="button" aria-label="Не нравится">' + ICON.dislike + '<span></span></button>' +
      '<button class="chip cmtb" type="button" aria-label="Комментарии">' + ICON.cmt + '<span></span></button>' +
      '<span class="spacer"></span><span class="score"></span>' +
      (canDel ? '<button class="icon-btn del" type="button" title="' + (own ? 'Удалить пост' : 'Удалить как модератор') + '" aria-label="Удалить пост">' + ICON.trash + '</button>' : '') +
    '</div>' +
    '<div class="react" aria-label="Реакции"></div>' +
    '<div class="comments" hidden><div class="clist"></div>' +
      '<div class="cform"><input placeholder="Написать комментарий…" maxlength="500" aria-label="Комментарий" enterkeyhint="send">' +
      '<button class="icon-btn primary send" type="button" title="Отправить" aria-label="Отправить">' + ICON.send + '</button></div></div>';

  d.querySelectorAll('.ava').forEach(i => i.addEventListener('error', () => { if (!i.dataset.f) { i.dataset.f = 1; i.src = 'AG.png'; } }));
  const main = d.querySelector('img.main'); if (main) main.addEventListener('error', () => main.remove());
  paint(d, p);

  const likeB = d.querySelector('.like'), disB = d.querySelector('.dis'), cmtB = d.querySelector('.cmtb');
  const reactBox = d.querySelector('.react');
  reactBox.appendChild(rAdd(REACTS, 'добавить реакцию', () => showReacts(d, p)));
  paintReact(d, p);
  const box = d.querySelector('.comments'), inp = box.querySelector('input'), sendB = box.querySelector('.send');
  likeB.onclick = () => { pop(likeB); vote(p, d, p.myVote === 1 ? 0 : 1); };
  disB.onclick = () => { pop(disB); vote(p, d, p.myVote === -1 ? 0 : -1); };
  cmtB.onclick = () => {
    const open = box.hidden; box.hidden = !open; cmtB.classList.toggle('on', open);
    if (open) { if (!d._loaded) loadComments(p, d); else inp.focus(); }
  };
  sendB.onclick = () => sendComment(p, d, inp, sendB);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendComment(p, d, inp, sendB); } });
  const del = d.querySelector('.del');
  if (del) del.onclick = () => deletePost(p, d);
  return d;
}
function pop(b) { b.classList.add('pop'); setTimeout(() => b.classList.remove('pop'), 320); }

// ───────── реакции ─────────
const REACTS = ['🔥', '👏', '🎯', '🧠', '💀'];
function rAdd(emojis, title, onclick) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 're'; b.title = title;
  b.setAttribute('aria-label', title);
  b.textContent = emojis.join(' ');
  b.onclick = onclick;
  return b;
}
function paintReact(d, p) {
  const box = d.querySelector('.react');
  box.querySelectorAll('.re:not(.add)').forEach(n => n.remove());
  const counts = p.reactions || {}, mine = p.myReactions || [];
  const list = REACTS.filter(e => counts[e] || mine.includes(e));
  const add = box.querySelector('.re.add');
  for (const e of list) {
    const b = rAdd([e], e + ' — ' + counts[e], () => react(d, p, e));
    if (counts[e]) b.appendChild(Object.assign(document.createElement('i'), { textContent: counts[e] }));
    if (mine.includes(e)) b.classList.add('on');
    box.insertBefore(b, add);
  }
}
function showReacts(d, p) {
  let pop_ = d.querySelector('.reactpop');
  if (pop_) { pop_.remove(); return; }
  pop_ = document.createElement('div');
  pop_.className = 'reactpop';
  for (const e of REACTS) {
    const b = rAdd([e], e, () => { react(d, p, e); pop_.remove(); });
    if ((p.myReactions || []).includes(e)) b.classList.add('on');
    pop_.appendChild(b);
  }
  d.querySelector('.react').appendChild(pop_);
  setTimeout(() => {
    const off = ev => { if (!pop_.contains(ev.target)) { pop_.remove(); document.removeEventListener('click', off); } };
    setTimeout(() => document.addEventListener('click', off), 0);
  }, 0);
}
async function react(d, p, emoji) { // мгновенно, с откатом при ошибке
  const snap = JSON.parse(JSON.stringify({ reactions: p.reactions || {}, myReactions: p.myReactions || [] }));
  const mine = new Set(p.myReactions || []);
  const had = mine.has(emoji);
  if (had) mine.delete(emoji); else mine.add(emoji);
  p.myReactions = [...mine];
  p.reactions = Object.assign({}, p.reactions);
  p.reactions[emoji] = Math.max(0, (p.reactions[emoji] || 0) + (had ? -1 : 1));
  if (!p.reactions[emoji]) delete p.reactions[emoji];
  const b = d.querySelector('.react .re.add');
  if (b) pop(b);
  paintReact(d, p);
  try {
    const r = await api('/api/posts/' + p.id + '/react', { method: 'POST', body: JSON.stringify({ emoji }) });
    p.reactions = r.reactions; p.myReactions = r.myReactions; paintReact(d, p);
  } catch (e) {
    p.reactions = snap.reactions; p.myReactions = snap.myReactions;
    paintReact(d, p); toast(errText(e), 'err');
  }
}
function paint(d, p) {
  const L = d.querySelector('.like'), D = d.querySelector('.dis'), C = d.querySelector('.cmtb'), S = d.querySelector('.score');
  L.classList.toggle('on', p.myVote === 1); L.setAttribute('aria-pressed', p.myVote === 1);
  D.classList.toggle('on', p.myVote === -1); D.setAttribute('aria-pressed', p.myVote === -1);
  L.lastElementChild.textContent = p.likes; D.lastElementChild.textContent = p.dislikes; C.lastElementChild.textContent = p.comments;
  const sc = p.likes - p.dislikes;
  S.textContent = (sc > 0 ? '+' : '') + sc;
  S.className = 'score' + (sc > 0 ? ' pos' : sc < 0 ? ' neg' : '');
}
async function vote(p, d, value) { // мгновенно, без перерисовки ленты; откат при ошибке
  const snap = { likes: p.likes, dislikes: p.dislikes, myVote: p.myVote };
  if (p.myVote === 1) p.likes--; else if (p.myVote === -1) p.dislikes--;
  if (value === 1) p.likes++; else if (value === -1) p.dislikes++;
  p.myVote = value; paint(d, p);
  try {
    const r = await api('/api/posts/' + p.id + '/vote', { method: 'POST', body: JSON.stringify({ value }) });
    p.likes = r.likes; p.dislikes = r.dislikes; p.myVote = r.myVote; paint(d, p);
  } catch (e) { Object.assign(p, snap); paint(d, p); toast(errText(e), 'err'); }
}
async function deletePost(p, d) {
  if (!confirm('Удалить пост «' + p.title + '»?')) return;
  try {
    const own = me && p.authorId === me.id;
    await api(own ? '/api/posts/' + p.id : '/api/admin/post/' + p.id, { method: 'DELETE' });
    d.classList.add('gone');
    setTimeout(() => { d.remove(); if (curPage === 'me') loadMine(); else emptyIfNeeded(); }, 250);
    feedDirty = curPage !== 'feed'; if (curPage === 'feed') feed.total--, $('count').textContent = 'Постов: ' + Math.max(0, feed.total);
    toast(own ? 'Пост удалён' : 'Удалено модератором', 'ok');
  } catch (e) { toast(errText(e), 'err'); }
}

// ───────── комментарии ─────────
function commentEl(p, d, c) {
  const el = document.createElement('div'); el.className = 'cm';
  el.innerHTML = '<div class="cmeta"><b>' + nameLink(c.author, c.authorId, c.badge) + '</b><small>' + ago(c.createdAt) + '</small></div><p>' + esc(c.text) + '</p>';
  if (me && (c.authorId === me.id || canAdmin())) {
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'cdel icon-btn'; x.innerHTML = ICON.x;
    x.title = c.authorId === me.id ? 'Удалить' : 'Удалить как модератор';
    x.setAttribute('aria-label', 'Удалить комментарий');
    x.onclick = async () => {
      try {
        const own = c.authorId === me.id;
        await api(own ? '/api/comments/' + c.id : '/api/admin/comment/' + c.id, { method: 'DELETE' });
        const list = el.parentNode; el.remove();
        p.comments = Math.max(0, p.comments - 1); paint(d, p);
        if (!list.children.length) list.innerHTML = '<div class="hint noc">Комментариев пока нет</div>';
      } catch (e) { toast(errText(e), 'err'); }
    };
    el.querySelector('.cmeta').appendChild(x);
  }
  return el;
}
async function loadComments(p, d) {
  const list = d.querySelector('.clist');
  list.innerHTML = '<div class="spinner"></div>';
  try {
    const arr = await api('/api/posts/' + p.id + '/comments');
    d._loaded = true; list.replaceChildren();
    if (!arr.length) list.innerHTML = '<div class="hint noc">Комментариев пока нет — напиши первым</div>';
    for (const c of arr) list.appendChild(commentEl(p, d, c));
    d.querySelector('.cform input').focus({ preventScroll: true });
  } catch (e) { list.innerHTML = '<div class="hint">Ошибка: ' + esc(errText(e)) + '</div>'; }
}
async function sendComment(p, d, inp, btn) {
  const text = inp.value.trim(); if (!text || btn.disabled) return;
  btn.disabled = true;
  try {
    const c = await api('/api/posts/' + p.id + '/comments', { method: 'POST', body: JSON.stringify({ text }) });
    inp.value = '';
    const list = d.querySelector('.clist'); list.querySelector('.noc')?.remove();
    if (d._loaded) { c.author = me.name; list.appendChild(commentEl(p, d, c)); }
    p.comments++; paint(d, p);
    if (!d._loaded) loadComments(p, d);
  } catch (e) { toast(errText(e), 'err'); }
  btn.disabled = false; inp.focus();
}

// ───────── форумы ─────────
async function loadForums() {
  try {
    const cats = await api('/api/forums');
    forumCats = [{ id: 'all', name: 'Все' }, ...cats];
    const box = $('forum-cats'); box.replaceChildren();
    for (const c of forumCats) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = c.name + (c.threads ? ' · ' + c.threads : '');
      b.classList.toggle('on', forumCat === c.id);
      b.onclick = () => { forumCat = c.id; box.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); loadThreads(); };
      box.appendChild(b);
    }
    loadThreads();
  } catch (e) { toast(errText(e), 'err'); }
}
async function loadThreads() {
  const box = $('threads'); box.replaceChildren(skeletons(2)); $('threads-empty').hidden = true;
  try {
    const list = await api('/api/threads?' + new URLSearchParams({ cat: forumCat, sort: 'active', limit: 50 }));
    box.replaceChildren();
    if (!list.length) { const e = $('threads-empty'); e.innerHTML = ICON.forum + '<b>Тем пока нет</b><span>Создай первую выше</span>'; e.hidden = false; return; }
    list.forEach((t, i) => {
      const d = document.createElement('div');
      d.className = 'trow'; d.style.animationDelay = Math.min(i * 40, 300) + 'ms';
      d.innerHTML = '<b>' + esc(t.title) + '</b>' +
        (t.body ? '<div class="tbody">' + esc(t.body) + '</div>' : '') +
        '<div class="tmeta"><span class="tag">' + esc(t.catName) + '</span><span>' + esc(t.author) + ' · ' + ago(t.lastAt) + '</span><span class="rc">' + ICON.cmt.replace('class="ic"', 'class="ic" width="14" height="14"') + ' ' + t.replies + '</span></div>';
      d.onclick = () => openThread(t.id);
      box.appendChild(d);
    });
  } catch (e) { box.replaceChildren(); const x = $('threads-empty'); x.innerHTML = '<b>Ошибка</b><span>' + esc(errText(e)) + '</span>'; x.hidden = false; }
}
async function newThread() {
  const title = $('th-title').value.trim(), body = $('th-body').value.trim();
  if (title.length < 2) { toast('Дай теме название', 'err'); $('th-title').focus(); return; }
  const btn = $('th-add'); busy(btn, true, 'Создаю…');
  try {
    const t = await api('/api/threads', { method: 'POST', body: JSON.stringify({ cat: forumCat === 'all' ? 'general' : forumCat, title, body }) });
    $('th-title').value = ''; $('th-body').value = '';
    loadForums(); openThread(t.id); toast('Тема создана', 'ok');
  } catch (e) { toast(errText(e), 'err'); }
  busy(btn, false);
}
async function openThread(id) {
  try {
    const { thread: t, replies } = await api('/api/threads/' + id);
    curThread = t;
    const v = $('thread-view');
    const own = me && t.authorId === me.id;
    v.innerHTML = '<div class="card"><div class="chead"><img class="ava" src="' + (t.avatar ? esc(url(t.avatar)) : 'AG.png') + '" alt="" width="40" height="40">' +
      '<div class="who"><b>' + esc(t.author) + '</b><small>' + ago(t.createdAt) + '</small></div><span class="tag">' + esc(t.catName) + '</span></div>' +
      '<div class="cbody"><h4 class="ctitle">' + esc(t.title) + '</h4>' + (t.body ? '<div class="ctext">' + esc(t.body) + '</div>' : '') + '</div>' +
      '<div class="actions"><span class="hint">ответов: ' + replies.length + '</span><span class="spacer"></span>' +
      (own ? '<button class="icon-btn del" id="th-del" type="button" title="Удалить тему">' + ICON.trash + '</button>' : '') + '</div>' +
      '<div class="comments"><div class="clist" id="th-replies"></div></div></div>';
    const list = v.querySelector('#th-replies');
    list.innerHTML = replies.length ? '' : '<div class="hint noc">Ответов нет — напиши первым</div>';
    for (const r of replies) list.appendChild(threadReplyEl(t, r, list));
    const del = v.querySelector('#th-del');
    if (del) del.onclick = async () => {
      if (!confirm('Удалить тему и все ответы?')) return;
      try { await api('/api/threads/' + t.id, { method: 'DELETE' }); curThread = null; nav('forum'); toast('Тема удалена', 'ok'); }
      catch (e) { toast(errText(e), 'err'); }
    };
    nav('thread');
  } catch (e) { toast(errText(e), 'err'); }
}
function threadReplyEl(t, r, list) {
  const el = document.createElement('div'); el.className = 'cm';
  el.innerHTML = '<div class="cmeta"><b>' + nameLink(r.author, r.authorId, r.badge) + '</b><small>' + ago(r.createdAt) + '</small></div><p>' + esc(r.text) + '</p>';
  if (me && (r.authorId === me.id || canAdmin())) {
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'cdel icon-btn'; x.innerHTML = ICON.x;
    x.title = r.authorId === me.id ? 'Удалить' : 'Удалить как модератор';
    x.setAttribute('aria-label', 'Удалить ответ');
    x.onclick = async () => {
      try {
        const own = r.authorId === me.id;
        await api(own ? '/api/treplies/' + r.id : '/api/admin/reply/' + r.id, { method: 'DELETE' }); el.remove(); if (!list.children.length) list.innerHTML = '<div class="hint noc">Ответов нет — напиши первым</div>'; }
      catch (e) { toast(errText(e), 'err'); }
    };
    el.querySelector('.cmeta').appendChild(x);
  }
  return el;
}
async function sendReply() {
  if (!curThread) return;
  const text = $('treply').value.trim(); if (!text) return;
  const btn = $('treply-send'); busy(btn, true, 'Отправляю…');
  try {
    await api('/api/threads/' + curThread.id + '/replies', { method: 'POST', body: JSON.stringify({ text }) });
    $('treply').value = ''; openThread(curThread.id); loadForums();
  } catch (e) { toast(errText(e), 'err'); }
  busy(btn, false);
}

// ───────── личка ─────────
async function pollUnread() {
  if (!token) return;
  try {
    const { unread } = await api('/api/dm/unread');
    const dot = $('dm-dot');
    dot.hidden = !unread; dot.textContent = unread > 99 ? '99+' : unread;
  } catch (_) {}
}
function dmToList() {
  dmPeer = null; botChat = null; $('dm-list-view').hidden = false; $('dm-chat-view').hidden = true;
}
async function loadConvos() {
  const box = $('dm-convos'); box.replaceChildren(); $('dm-empty').hidden = true;
  try {
    const list = await api('/api/dm');
    if (!list.length) { const e = $('dm-empty'); e.innerHTML = ICON.mail + '<b>Диалогов нет</b><span>Найди человека выше и напиши первым</span>'; e.hidden = false; }
    for (const c of list) {
      const d = document.createElement('div'); d.className = 'convo';
      d.innerHTML = '<img src="' + (c.user.avatar ? esc(url(c.user.avatar)) : 'AG.png') + '" alt="" loading="lazy"><div class="cinfo"><b>' + nameLink(c.user.name, c.user.id, c.user.badge) + '</b><div class="clast">' + esc(c.lastText) + '</div></div>' +
        '<span class="ctime">' + ago(c.lastAt) + '</span>' + (c.unread ? '<span class="unread-n">' + c.unread + '</span>' : '');
      d.onclick = () => openChat(c.user.id, c.user.name, c.user.avatar);
      box.appendChild(d);
    }
    box.prepend(botRow());
  } catch (e) { toast(errText(e), 'err'); }
}
let dmQT;
async function dmSearch() {
  const q = $('dm-q').value.trim(), box = $('dm-found'); box.replaceChildren();
  if (q.length < 1) return;
  try {
    const users = await api('/api/users?' + new URLSearchParams({ q, limit: 10 }));
    if (!users.length) { box.innerHTML = '<div class="hint">Никого не нашёл</div>'; return; }
    for (const u of users) {
      const d = document.createElement('div'); d.className = 'convo';
      d.innerHTML = '<img src="' + (u.avatar ? esc(url(u.avatar)) : 'AG.png') + '" alt="" loading="lazy"><div class="cinfo"><b>' + esc(u.name) + '</b><div class="clast">написать сообщение →</div></div>';
      d.onclick = () => openChat(u.id, u.name, u.avatar);
      box.appendChild(d);
    }
  } catch (e) { toast(errText(e), 'err'); }
}
async function openChat(uid, name, avatar) {
  dmPeer = uid; dmName = name; botChat = null;
  $('dm-list-view').hidden = true; $('dm-chat-view').hidden = false;
  $('dm-name').textContent = name; $('dm-ava').src = avatar ? url(avatar) : 'AG.png';
  $('dm-text').value = '';
  await loadChat();
  pollUnread();
}
function bub(m) {
  const mine = me && m.fromId === me.id;
  const d = document.createElement('div');
  d.className = 'bub ' + (mine ? 'me' : 'them');
  d.innerHTML = esc(m.text) + '<small>' + new Date(m.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + '</small>';
  return d;
}
async function loadChat() {
  if (!dmPeer) return;
  const box = $('dm-msgs');
  try {
    const arr = await api('/api/dm/' + dmPeer);
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.replaceChildren();
    if (!arr.length) box.innerHTML = '<div class="hint center">Напиши первым — история пуста</div>';
    for (const m of arr) box.appendChild(bub(m));
    if (nearBottom || !box.dataset.once) { box.scrollTop = box.scrollHeight; box.dataset.once = 1; }
    pollUnread(); loadConvosQuiet();
  } catch (e) { toast(errText(e), 'err'); }
}
async function loadConvosQuiet() { // обновить список без мигания, пока открыт чат
  try {
    const list = await api('/api/dm');
    const box = $('dm-convos'); if (!box) return;
    box.replaceChildren(); $('dm-empty').hidden = true;
    if (!list.length) { const e = $('dm-empty'); e.innerHTML = ICON.mail + '<b>Диалогов нет</b>'; e.hidden = false; return; }
    for (const c of list) {
      const d = document.createElement('div'); d.className = 'convo';
      d.innerHTML = '<img src="' + (c.user.avatar ? esc(url(c.user.avatar)) : 'AG.png') + '" alt="" loading="lazy"><div class="cinfo"><b>' + esc(c.user.name) + '</b><div class="clast">' + esc(c.lastText) + '</div></div>' +
        '<span class="ctime">' + ago(c.lastAt) + '</span>' + (c.unread ? '<span class="unread-n">' + c.unread + '</span>' : '');
      d.onclick = () => openChat(c.user.id, c.user.name, c.user.avatar);
      box.appendChild(d);
    }
  } catch (_) {}
}
async function sendDM() {
  if (botChat) return sendBot();
  if (!dmPeer) return;
  const inp = $('dm-text'), text = inp.value.trim(); if (!text) return;
  inp.value = '';
  try {
    const m = await api('/api/dm/' + dmPeer, { method: 'POST', body: JSON.stringify({ text }) });
    const box = $('dm-msgs'); box.querySelector('.hint')?.remove();
    box.appendChild(bub(m)); box.scrollTop = box.scrollHeight;
    loadConvosQuiet();
  } catch (e) { toast(errText(e), 'err'); inp.value = text; }
}
function startDmPoll() {
  stopDmPoll();
  pollUnread();
  dmTimer = setInterval(async () => {
    if (!token || !$('app') || $('app').style.display === 'none') return;
    pollUnread();
    if (curPage === 'dm' && dmPeer && !$('dm-chat-view').hidden) loadChat();
  }, 8000);
}
function stopDmPoll() { if (dmTimer) { clearInterval(dmTimer); dmTimer = null; } }

// ───────── бейджи и профиль ─────────
function badges(b) {
  const x = b || {};
  const out = [];
  if (x.admin) out.push('<i class="bg bg-admin" title="Администратор">' + ICON.crown + 'АДМИН</i>');
  if (x.mod) out.push('<i class="bg bg-mod" title="Модератор">' + ICON.shield + 'МОД</i>');
  if (x.verified) out.push('<i class="bg bg-ver" title="Проверенный">' + ICON.shieldCheck + '</i>');
  return out.length ? '<span class="badges">' + out.join('') + '</span>' : '';
}
function nameLink(name, id, badge) {
  return '<b class="nlink" data-user="' + esc(id) + '">' + esc(name) + '</b>' + badges(badge);
}
document.addEventListener('click', e => {
  const u = e.target.closest('[data-user]');
  if (u && curPage !== 'user') openUser(u.dataset.user);
});
const canAdmin = () => !!(me && me.badge && (me.badge.admin || me.badge.mod));
const isAdminU = () => !!(me && me.badge && me.badge.admin);
async function openUser(id) {
  if (!id || !token) return;
  nav('user');
  const box = $('user-view'); box.replaceChildren(skeletons(1));
  try {
    const d = await api('/api/users/' + id);
    const u = d.user;
    box.replaceChildren();
    const top = document.createElement('div');
    top.className = 'prof-top';
    top.innerHTML = '<img src="' + (u.avatar ? esc(url(u.avatar)) : 'AG.png') + '" alt="">' +
      '<div class="pinfo"><b>' + esc(u.name) + badges(u.badge) + '</b>' +
      '<div class="hint">с нами с ' + new Date(u.createdAt).toLocaleDateString('ru-RU') + '</div></div>';
    const acts = document.createElement('div');
    acts.className = 'prof-actions';
    if (!d.isSelf) {
      const f = document.createElement('button');
      f.className = 'primary'; f.type = 'button';
      f.innerHTML = (d.follows ? ICON.check + 'Вы подписаны' : ICON.userPlus + 'Подписаться');
      f.onclick = async () => {
        try {
          const r = await api('/api/users/' + id + '/follow', { method: 'POST' });
          d.follows = r.follows; d.user.followers = r.followers;
          f.innerHTML = (r.follows ? ICON.check + 'Вы подписаны' : ICON.userPlus + 'Подписаться');
          f.classList.toggle('primary', !r.follows);
          const fl = box.querySelector('.followers');
          if (fl) fl.innerHTML = fCounters(d.user);
          toast(r.follows ? 'Подписались на ' + u.name : 'Отписались', 'ok');
        } catch (e) { toast(errText(e), 'err'); }
      };
      acts.appendChild(f);
      const m = document.createElement('button');
      m.type = 'button'; m.textContent = 'Написать';
      m.onclick = () => { nav('dm'); dmToList(); openChat(id, u.name, u.avatar); };
      acts.appendChild(m);
    }
    const fl = document.createElement('div');
    fl.className = 'followers'; fl.innerHTML = fCounters(u);
    const list = document.createElement('div');
    list.className = 'feed'; list.style.display = 'flex'; list.style.flexDirection = 'column';
    list.style.gap = 'var(--gap)'; list.style.marginTop = '14px';
    if (!d.posts.length) list.innerHTML = '<div class="hint center">У игрока пока нет постов</div>';
    d.posts.forEach(p => list.appendChild(card(p)));
    box.append(top, acts, fl, document.createElement('h3'), list);
    box.querySelector('h3').textContent = 'Посты игрока';
  } catch (e) { box.innerHTML = '<div class="hint center">' + esc(errText(e)) + '</div>'; }
}
const fCounters = u =>
  '<span><b>' + u.posts + '</b>постов</span><span><b>' + (u.likes || 0) + '</b>лайков</span>' +
  '<span><b>' + u.followers + '</b>подписчиков</span><span><b>' + u.following + '</b>подписок</span>';

// ───────── рассылка ─────────
async function loadBroadcast() {
  try {
    const list = await api('/api/broadcasts');
    const b = $('bc-banner');
    if (!list.length) { b.hidden = true; return; }
    const last = list[list.length - 1];
    b.hidden = false;
    b.innerHTML = '<span class="ico">' + ICON.megaphone + '</span><b>' + esc(last.text) + '</b>' +
      '<small class="hint">' + esc(last.by) + ' · ' + ago(last.at) + '</small>';
  } catch (_) {}
}

// ───────── админка ─────────
async function loadAdmin() {
  if (!canAdmin()) return;
  try {
    const s = await api('/api/admin/stats');
    $('admin-stats').innerHTML = [
      ['игроков', s.users], ['админов', s.admins], ['модераторов', s.mods],
      ['галочек', s.verified], ['постов', s.posts], ['комментариев', s.comments],
      ['реакций', s.reactions], ['тем', s.threads]
    ].map(([n, v]) => '<div><b>' + v + '</b><span>' + n + '</span></div>').join('');
  } catch (e) { toast(errText(e), 'err'); }
  await loadAdminUsers();
  await loadBroadcasts();
}
let admT;
function loadAdminUsers() {
  clearTimeout(admT);
  return new Promise(res => {
    admT = setTimeout(async () => {
      const box = $('adm-users'); box.replaceChildren(skeletons(2));
      try {
        const list = await api('/api/admin/users?' + new URLSearchParams({ q: $('adm-q').value.trim() }));
        box.replaceChildren();
        if (!list.length) { box.innerHTML = '<div class="hint center">Никого не нашли</div>'; return res(); }
        for (const u of list) box.appendChild(adminUserRow(u));
      } catch (e) { box.innerHTML = '<div class="hint center">' + esc(errText(e)) + '</div>'; }
      res();
    }, 200);
  });
}
function adminUserRow(u) {
  const row = document.createElement('div'); row.className = 'au';
  row.innerHTML = '<img src="' + (u.avatar ? esc(url(u.avatar)) : 'AG.png') + '" alt="" loading="lazy">' +
    '<div class="ainfo"><b>' + esc(u.name) + '</b> <span class="hint">' + u.posts + ' постов · ' + ago(u.joined) + '</span></div>';
  const roles = document.createElement('div'); roles.className = 'aroles';
  const mk = (label, on, ic, apply) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = (on ? '✓ ' : '') + label;
    b.className = on ? 'on' : '';
    b.onclick = async () => {
      try {
        const r = await api('/api/admin/user/' + u.id + '/role', { method: 'POST', body: JSON.stringify(apply) });
        b.classList.toggle('on', r.badge[apply.admin !== undefined ? 'admin' : apply.mod !== undefined ? 'mod' : 'verified']);
        b.textContent = (r.badge[apply.admin !== undefined ? 'admin' : apply.mod !== undefined ? 'mod' : 'verified'] ? '✓ ' : '') + label;
        if (me && r.id === me.id) me.badge = r.badge;
        toast('Готово', 'ok'); loadAdmin();
      } catch (e) { toast(errText(e), 'err'); }
    };
    return b;
  };
  roles.append(
    mk('АДМИН', u.badge.admin, ICON.crown, { admin: !u.badge.admin }),
    mk('МОД', u.badge.mod, ICON.shield, { mod: !u.badge.mod }),
    mk('ГАЛОЧКА', u.badge.verified, ICON.shieldCheck, { verified: !u.badge.verified })
  );
  row.append(roles);
  if (isAdminU() && u.id !== me.id) {
    const del = document.createElement('button');
    del.type = 'button'; del.title = 'Удалить игрока'; del.innerHTML = ICON.trash;
    del.onclick = async () => {
      if (!confirm('Удалить игрока ' + u.name + ' и всё его содержимое?')) return;
      try { await api('/api/admin/user/' + u.id, { method: 'DELETE' }); toast('Игрок удалён', 'ok'); loadAdmin(); }
      catch (e) { toast(errText(e), 'err'); }
    };
    row.appendChild(del);
  }
  row.querySelector('.ainfo').onclick = () => openUser(u.id);
  row.querySelector('.ainfo').style.cursor = 'pointer';
  return row;
}
async function loadBroadcasts() {
  try {
    const list = await api('/api/broadcasts');
    const box = $('bc-list'); box.replaceChildren();
    for (const b of list.slice().reverse()) {
      const d = document.createElement('div'); d.className = 'bc';
      d.innerHTML = '<div class="bctext">' + esc(b.text) + '<br><small>' + esc(b.by) + ' · ' + new Date(b.at).toLocaleString('ru-RU') + '</small></div>';
      if (isAdminU()) {
        const x = document.createElement('button');
        x.className = 'icon-btn'; x.type = 'button'; x.title = 'Удалить'; x.innerHTML = ICON.x;
        x.onclick = async () => { await api('/api/admin/broadcast/' + b.id, { method: 'DELETE' }); loadBroadcasts(); loadBroadcast(); };
        d.appendChild(x);
      }
      box.appendChild(d);
    }
    if (!list.length) box.innerHTML = '<div class="hint center">Объявлений пока нет</div>';
  } catch (e) { /* не админ — молча */ }
}
async function sendBroadcast() {
  const text = $('bc-text').value.trim();
  if (text.length < 2) return toast('Напиши сообщение', 'err');
  const btn = $('bc-send'); busy(btn, true, 'Отправляю…');
  try {
    await api('/api/admin/broadcast', { method: 'POST', body: JSON.stringify({ text }) });
    $('bc-text').value = ''; toast('Объявление отправлено всем', 'ok');
    loadBroadcasts(); loadBroadcast();
  } catch (e) { toast(errText(e), 'err'); }
  busy(btn, false);
}

// ───────── бот ─────────
let botChat = null;
function botRow() {
  const d = document.createElement('div'); d.className = 'convo botrow';
  d.innerHTML = '<img src="AG.png" alt="" class="botava"><div class="cinfo"><b>AG Бот</b><div class="clast">помощь и информация — напиши /помощь</div></div>' + ICON.bot;
  d.onclick = () => openBot();
  return d;
}
async function openBot() {
  botChat = [];
  $('dm-list-view').hidden = true; $('dm-chat-view').hidden = false;
  $('dm-name').textContent = 'AG Бот';
  $('dm-ava').src = 'AG.png';
  const box = $('dm-msgs'); box.replaceChildren();
  const greet = document.createElement('div');
  greet.className = 'bub them';
  greet.innerHTML = 'Привет! Я бот воркшопа 🤖 Помогу по площадке и дам статистику.<br><small>Напиши /помощь</small>';
  box.appendChild(greet);
  $('dm-text').value = '';
  $('dm-text').focus();
}
function botBubble(text, mine) {
  const d = document.createElement('div');
  d.className = 'bub ' + (mine ? 'me' : 'them');
  d.innerHTML = esc(text).replace(/\n/g, '<br>') + '<small>' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + '</small>';
  return d;
}
async function sendBot() {
  const inp = $('dm-text'), text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  const box = $('dm-msgs');
  box.appendChild(botBubble(text, true));
  box.scrollTop = box.scrollHeight;
  try {
    const r = await api('/api/bot', { method: 'POST', body: JSON.stringify({ text }) });
    setTimeout(() => {
      box.appendChild(botBubble(r.reply, false));
      box.scrollTop = box.scrollHeight;
    }, 280);
  } catch (e) { box.appendChild(botBubble('Ошибка: ' + errText(e), false)); }
}

// ───────── новый пост ─────────
function pickFile(input, max, test, err) {
  const f = input.files[0]; if (!f) return null;
  if (f.size > max) { input.value = ''; toast('Файл больше ' + (max / 1048576) + ' MB', 'err'); return null; }
  if (!test(f)) { input.value = ''; toast(err, 'err'); return null; }
  return f;
}
let previewURL = null;
function setPhoto() {
  if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = null; }
  const f = pickFile($('photo'), 5 << 20, f => f.type.startsWith('image/'), ERR.only_images);
  if (f) { previewURL = URL.createObjectURL(f); $('preview').src = previewURL; }
  $('preview-wrap').hidden = !f; $('drop-photo').hidden = !!f;
}
function setJson() {
  const f = pickFile($('jsonfile'), 2 << 20, f => /\.json$/i.test(f.name) || f.type === 'application/json', ERR.only_json);
  $('jname').textContent = f ? f.name + ' · ' + Math.max(1, Math.round(f.size / 1024)) + ' KB' : '';
  $('jchip').hidden = !f; $('drop-json').hidden = !!f;
}
function resetForm() {
  for (const id of ['title', 'body', 'photo', 'jsonfile']) $(id).value = '';
  $('title-n').textContent = '0/80'; $('body-n').textContent = '0/2000';
  setPhoto(); setJson(); setKind('proj');
}
function setKind(k) {
  postKind = k;
  $('kind-proj').classList.toggle('on', k === 'proj'); $('kind-build').classList.toggle('on', k === 'build');
}
async function publish() {
  const title = $('title').value.trim();
  if (title.length < 2) { toast('Дай посту название', 'err'); $('title').focus(); return; }
  const fd = new FormData();
  fd.append('title', title); fd.append('body', $('body').value.trim()); fd.append('kind', postKind);
  if ($('photo').files[0]) fd.append('photo', $('photo').files[0]);
  if ($('jsonfile').files[0]) fd.append('jsonfile', $('jsonfile').files[0]);
  const btn = $('publish'); busy(btn, true, 'Публикую…');
  try {
    await api('/api/posts', { method: 'POST', body: fd });
    resetForm(); feedDirty = true; nav('feed'); toast('Пост опубликован', 'ok');
  } catch (e) { toast(errText(e), 'err'); }
  busy(btn, false);
}

// ───────── профиль / настройки ─────────
async function refreshMe() {
  const r = await api('/api/me'); me = r.user;
  if (!me) logout();
  $('me-admin').hidden = !canAdmin();
}
async function loadMine() {
  if (!me) return;
  $('myname').textContent = me.name;
  $('myava').src = me.avatar ? url(me.avatar) : 'AG.png';
  const mine = document.querySelector('#page-me .pinfo b');
  if (mine) mine.innerHTML = esc(me.name) + badges(me.badge);
  $('me-admin').hidden = !canAdmin();
  const box = $('mylist'); box.replaceChildren(skeletons(1));
  try {
    const posts = await api('/api/me/posts');
    const likes = posts.reduce((s, p) => s + p.likes, 0);
    $('mystats').textContent = 'постов: ' + posts.length + ' · лайков: ' + likes;
    box.replaceChildren();
    if (!posts.length) {
      box.innerHTML = '<div class="empty">' + ICON.image + '<b>Постов пока нет</b><span>Самое время что-нибудь опубликовать</span><button class="primary" data-go="add">' + ICON.plus + ' Создать пост</button></div>';
      return;
    }
    posts.forEach((p, i) => { const c = card(p); c.style.animationDelay = Math.min(i * 40, 300) + 'ms'; box.appendChild(c); });
  } catch (e) { box.innerHTML = '<div class="hint center">Ошибка: ' + esc(errText(e)) + '</div>'; }
}
async function loadSettings() {
  if (!me) return;
  $('s-name').value = me.name; $('s-prev').src = me.avatar ? url(me.avatar) : 'AG.png';
  try { const h = await api('/api/health'); $('health').textContent = 'Сервер ок · v' + (h.version || '?') + ' · постов: ' + h.posts + ' · юзеров: ' + h.users; }
  catch (_) { $('health').textContent = 'Сервер недоступен'; }
}
async function saveSettings() {
  const name = $('s-name').value.trim();
  if (name.length < 2) { toast(ERR.short_name, 'err'); return; }
  const fd = new FormData();
  fd.append('name', name);
  if ($('s-pass').value) fd.append('password', $('s-pass').value);
  const ava = pickFile($('s-ava'), 5 << 20, f => f.type.startsWith('image/'), ERR.only_images);
  if (ava) fd.append('avatar', ava);
  const btn = $('s-save'); busy(btn, true, 'Сохраняю…');
  try {
    const r = await api('/api/me', { method: 'PATCH', body: fd });
    token = r.token; LS.set('wsa_token', token); me = r.user;
    $('s-pass').value = ''; $('s-ava').value = ''; feedDirty = true;
    $('s-prev').src = me.avatar ? url(me.avatar) : 'AG.png';
    toast('Сохранено', 'ok');
  } catch (e) { toast(errText(e), 'err'); }
  busy(btn, false);
}

// ───────── лайтбокс ─────────
function openLB(src) { $('lb-img').src = src; $('lightbox').hidden = false; document.body.style.overflow = 'hidden'; }
function closeLB() { $('lightbox').hidden = true; $('lb-img').removeAttribute('src'); document.body.style.overflow = ''; }

// ───────── init ─────────
function init() {
  document.querySelectorAll('[data-ic]').forEach(el => el.insertAdjacentHTML('afterbegin', ICON[el.dataset.ic] || ''));

  // вход
  $('g-reg').onclick = () => { mode = 'register'; syncGate(); };
  $('g-log').onclick = () => { mode = 'login'; syncGate(); };
  $('g-go').onclick = gateGo;
  for (const id of ['g-name', 'g-pass']) {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') gateGo(); });
    $(id).addEventListener('input', () => { $('g-err').textContent = ''; });
  }
  bindEye('g-eye', 'g-pass'); bindEye('s-eye', 's-pass');
  syncGate();

  // шапка и поиск
  $('brand').onclick = () => { if (curPage === 'feed') window.scrollTo({ top: 0, behavior: 'smooth' }); else nav('feed'); };
  let qT;
  $('q').oninput = () => {
    $('q-clear').hidden = !$('q').value;
    if (curPage !== 'feed') nav('feed');
    clearTimeout(qT); qT = setTimeout(load, 300);
  };
  $('q-clear').onclick = () => { $('q').value = ''; $('q-clear').hidden = true; load(); $('q').focus(); };

  // вкладки ленты и сортировка
  const setTab = k => {
    kind = k;
    $('tab-all').classList.toggle('on', k === 'all'); $('tab-proj').classList.toggle('on', k === 'proj'); $('tab-build').classList.toggle('on', k === 'build');
    load();
  };
  $('tab-all').onclick = () => setTab('all'); $('tab-proj').onclick = () => setTab('proj'); $('tab-build').onclick = () => setTab('build');
  const setSort = s => {
    sort = s; $('sort-new').classList.toggle('on', s === 'new'); $('sort-top').classList.toggle('on', s === 'top'); load();
  };
  $('sort-new').onclick = () => setSort('new'); $('sort-top').onclick = () => setSort('top');
  $('empty').onclick = e => {
    const b = e.target.closest('[data-go]'); if (!b) return;
    b.dataset.go === 'retry' ? load() : nav(b.dataset.go);
  };
  document.addEventListener('click', e => {
    const go = e.target.closest('#mylist [data-go]'); if (go) nav(go.dataset.go);
    const im = e.target.closest('img.main'); if (im) openLB(im.currentSrc || im.src);
  });

  // бесконечная лента
  new IntersectionObserver(es => { if (es[0].isIntersecting && curPage === 'feed') load(false); }, { rootMargin: '500px' }).observe($('sentinel'));

  // нижняя навигация
  $('nav-feed').onclick = () => nav('feed'); $('nav-forum').onclick = () => nav('forum');
  $('nav-add').onclick = () => nav('add'); $('nav-dm').onclick = () => nav('dm');
  $('nav-me').onclick = () => nav('me'); $('nav-set').onclick = () => nav('set');
  $('me-edit').onclick = () => nav('set');

  // форумы
  $('th-add').onclick = newThread;
  $('th-back').onclick = () => nav('forum');
  $('treply-send').onclick = sendReply;

  // личка
  $('dm-q').oninput = () => { clearTimeout(dmQT); dmQT = setTimeout(dmSearch, 300); };
  $('dm-back').onclick = () => { dmToList(); loadConvos(); };
  $('dm-send').onclick = sendDM;
  $('dm-text').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendDM(); } });

  // админка и навигация «назад»
  $('me-admin').onclick = () => nav('admin');
  $('bc-send').onclick = sendBroadcast;
  $('adm-q').oninput = loadAdminUsers;
  document.querySelectorAll('.prof-back').forEach(b => b.onclick = () => nav(b.dataset.go));

  // форма поста
  $('kind-proj').onclick = () => setKind('proj'); $('kind-build').onclick = () => setKind('build');
  $('title').oninput = () => { $('title-n').textContent = $('title').value.length + '/80'; };
  $('body').oninput = () => { $('body-n').textContent = $('body').value.length + '/2000'; };
  $('photo').onchange = setPhoto; $('jsonfile').onchange = setJson;
  $('photo-clear').onclick = () => { $('photo').value = ''; setPhoto(); };
  $('json-clear').onclick = () => { $('jsonfile').value = ''; setJson(); };
  $('publish').onclick = publish;
  document.querySelectorAll('.drop').forEach(z => {
    const inp = z.querySelector('input');
    ['dragenter', 'dragover'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.remove('over'); }));
    z.addEventListener('drop', e => {
      if (!e.dataTransfer.files.length) return;
      inp.files = e.dataTransfer.files; inp.dispatchEvent(new Event('change'));
    });
  });

  // настройки
  $('s-save').onclick = saveSettings;
  $('s-ava').onchange = () => {
    const f = pickFile($('s-ava'), 5 << 20, f => f.type.startsWith('image/'), ERR.only_images);
    if (f) $('s-prev').src = URL.createObjectURL(f);
  };
  $('logout').onclick = () => { if (confirm('Выйти из аккаунта?')) logout(); };
  $('delacc').onclick = async () => {
    if (!confirm('Удалить аккаунт и ВСЕ твои посты? Это нельзя отменить.')) return;
    try { await api('/api/me', { method: 'DELETE' }); logout('Аккаунт удалён'); }
    catch (e) { toast(errText(e), 'err'); }
  };

  // лайтбокс, «наверх»
  $('lightbox').onclick = closeLB;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('lightbox').hidden) closeLB(); });
  const top = $('totop'); let tick = false;
  top.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  addEventListener('scroll', () => {
    if (tick) return; tick = true;
    requestAnimationFrame(() => { top.hidden = scrollY < 700 || curPage !== 'feed'; tick = false; });
  }, { passive: true });

  // старт
  if (!token) { showGate(); return; }
  showApp(); nav('feed'); startDmPoll();
  refreshMe().then(() => { if (curPage === 'me') loadMine(); }).catch(() => toast('Нет связи с сервером', 'err'));
}
init();
