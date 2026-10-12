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
- Форумы: `GET /api/forums`, `GET /api/threads?cat=&sort=active|new&q=`, `POST /api/threads {cat,title,body}`, `GET /api/threads/:id`, `POST /api/threads/:id/replies {text}`, `DELETE /api/threads/:id`, `DELETE /api/treplies/:id`
- Личка: `GET /api/users?q=` (поиск акков), `GET /api/dm` (диалоги), `GET /api/dm/unread`, `GET/POST /api/dm/:uid`

## Деплой (Node 18+, `npm install`, старт `npm start`)

Обязательна переменная окружения **`JWT_SECRET`** (длинная случайная строка) — без неё в production сервер не стартует. Опционально: `PORT`, `CORS_ORIGIN`, `TRUST_PROXY`, `NODE_ENV=production`.

### Сохранение данных

Диск контейнера обнуляется при каждом деплое, поэтому без базы всё пропадёт. Приложение само выбирает хранилище:

| Переменная | Что подхватится | Комментарий |
|---|---|---|
| `DATABASE_URL` | PostgreSQL | аккаунты, посты, форумы, ЛС **и** фото/чертежи |
| `REDIS_URL` или `KV_URL` | Key Value (Redis) | то же самое |
| ничего | `data/db.json` + `public/uploads` | только для локальной разработки |

Как включить на Render: Dashboard → **New → Postgres** (или Key Value) → в проекте привяжи базу к сервису (`fewwef` → Environment). Render сам подставит `DATABASE_URL`. После этого `npm install` в пакетах появятся `pg` и `redis`.

Если хранилище недоступно, сервер не падает: пишет в лог предупреждение и падает на диск (данные переживут рестарт процесса, но не деплой).

При первом запуске с базой приложение само переносит в неё локальный `data/db.json` и уже загруженные файлы — ничего не теряется.

### Бэкап

Весь массив данных хранится одной записью, поэтому его легко выгрузить: `GET /api/health` показывает состояние, а сама база — обычная таблица `ag_state` (колонка `data`, jsonb) и `ag_files`. Копия = `SELECT data FROM ag_state`; восстановление = вставить обратно.

Загрузки: `public/uploads/` (в `.gitignore`, файлы не коммитятся).

## Связка с игрой

В `index.html` воркшоп ходит на `wsBase`. После деплоя поставь URL WorkshopAG в игру как `wsBase`.
