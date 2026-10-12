# WorkshopAG

Онлайн-воркшоп в стиле **AG — Armor Simulation**: регистрация/вход, TikTok-лента, посты с фото и JSON-чертежами, лайки/дизлайки, комменты, мой аккаунт, настройки.

База чистая — никаких демо-постов, только реальные люди.

## Локальный запуск

```bash
npm install
npm start
# открыть http://localhost:3000
```

## Что умеет фронт (`public/`)

- Первый экран — меню РЕГИСТРАЦИЯ / ВОЙТИ
- Лента (все / снаряды / постройки), поиск, сортировка новые/топ
- Новый пост: текст + фото (png/jpg/webp/gif, 5MB) + JSON-чертёж (проверяется, скачивается по ссылке)
- Лайк/дизлайк (один голос на акк), комменты, удаление своих
- Мой акк (аватар, мои посты), настройки (ник, пароль, аватар, удалить акк)

## API

- `POST /api/register`, `POST /api/login`, `GET /api/me`, `PATCH /api/me`, `DELETE /api/me`, `GET /api/me/posts`
- `GET /api/posts?kind=all|proj|build&q=&sort=new|top&limit=&offset=` (всего — в `X-Total-Count`)
- `POST /api/posts` (multipart: `title, body, kind, photo, jsonfile`), `DELETE /api/posts/:id`
- `POST /api/posts/:id/vote {value:1|-1|0}`
- `GET/POST /api/posts/:id/comments`, `DELETE /api/comments/:id`
- `GET /api/health`

## Деплой (Node 18+, `npm install`, старт `npm start`)

Обязательна переменная окружения **`JWT_SECRET`** (длинная случайная строка) — без неё в production сервер не стартует. Опционально: `PORT`, `CORS_ORIGIN`, `TRUST_PROXY`, `NODE_ENV=production`.

База — `data/db.json` (атомарная запись + почасовой `.bak`, битая база не затирается). Загрузки — `public/uploads/`.

В репо есть `render.yaml` (Blueprint). Для хостинга из формы импорта: корневая папка — корень репозитория, стек Node.js/Express, автодеплой по пушу в `main`.

## Связка с игрой

В `index.html` воркшоп ходит на `wsBase`. После деплоя поставь URL WorkshopAG в игру как `wsBase`.
