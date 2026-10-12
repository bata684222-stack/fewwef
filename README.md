# WorkshopAG

Онлайн-воркшоп в стиле **AG — Armor Simulation**: посты (снаряды/постройки), лайки/дизлайки, комменты, аккаунты.

Стиль забран из `index.html` (переменные `--acc:#f5a623`, Rajdhani, тёмные карточки `.wsitem`).

## Локальный запуск

```bash
cd workshopAG
npm install
npm start
# открыть http://localhost:3000
```

## Что умеет

- `POST /api/register`, `POST /api/login`, `GET /api/me` — ники + bcrypt + JWT (30 дней)
- `GET /api/posts?kind=all|proj|build&q=&sort=new|top`
- `POST /api/posts`, `DELETE /api/posts/:id` (только свои)
- `POST /api/posts/:id/vote {value:1|-1|0}` — лайк/дизлайк, один голос на акк
- `GET/POST /api/posts/:id/comments`, `DELETE /api/comments/:id`
- Фронт: `public/` — если сервер недоступен, работает офлайн на localStorage

## Залить на GitHub (сам)

```bash
cd workshopAG
git init
git add .
git commit -m "WorkshopAG v1"
git branch -M main
git remote add origin https://github.com/ТВОЙ-НИК/workshopag.git
git push -u origin main
```

> Токен `ghp_...` никуда в файлы НЕ вшивать. Ты его уже светил в чате — отзови на github.com/settings/tokens и создай новый. То же с `rak_...` от relaxAI — он только для ИИ-запросов, для воркшопа не нужен, тоже перевыпусти.

## Онлайн на Render

Вариант 1 — через Dashboard: New → Web Service → выбрать репо → Build `npm install`, Start `npm start`, добавить env `JWT_SECRET` (Generate).

Вариант 2 — Blueprint: в репо уже есть `render.yaml`, в Dashboard: New → Blueprint → выбрать репо.

Вариант 3 — через Render API (ключ только в env, не в код):
`Authorization: Bearer $RENDER_API_KEY` → `POST https://api.render.com/v1/services`.

## Связка с игрой

В `index.html` воркшоп ходит на `wsBase`. После деплоя поставь URL WorkshopAG в игру как `wsBase`, либо жми «Скачанные» — фронт WorkshopAG отдаёт те же поля `title/body/kind`.
