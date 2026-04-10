# Cyber Shield

Учебное веб-приложение для конкурса "КиберПраво: твой щит в сети". Проект помогает распознавать мошеннические сценарии через карточки с признаками, интерактивные тренировки и ИИ-чат с разбором тактик злоумышленника.

## Что уже есть

- `React + Vite + TypeScript` фронтенд под `GitHub Pages`
- локальное сохранение прогресса в `localStorage`
- 4 сценарных тренировки с ветвлением
- двухпанельный ИИ-чат: диалог + объяснение красных флагов
- `Cloudflare Worker` для безопасного вызова `Groq API`
- GitHub Actions workflow для публикации в `GitHub Pages`

## Локальный запуск

```bash
npm install
npm run dev
```

Файл `.env` для фронтенда:

```bash
VITE_CHAT_API_URL=https://your-worker-subdomain.workers.dev/api/chat
```

Если `VITE_CHAT_API_URL` не задан, приложение покажет интерфейс чата, но без живых ответов от ИИ.

## Cloudflare Worker

1. Установить аутентификацию:

```bash
npx wrangler login
```

2. Скопировать `worker/.dev.vars.example` в `worker/.dev.vars` и заполнить:

```bash
GROQ_API_KEY=...
ALLOWED_ORIGIN=https://your-user.github.io
GROQ_MODEL=llama-3.1-8b-instant
```

3. Запустить локально:

```bash
npm run dev:worker
```

4. Задеплоить:

```bash
npm run deploy:worker
```

Worker использует `POST /api/chat` и `GET /health`.

## GitHub Pages

Workflow уже добавлен в `.github/workflows/deploy-pages.yml`.

Чтобы публикация заработала:

1. В репозитории открыть `Settings -> Pages`.
2. Источник выставить на `GitHub Actions`.
3. Запушить ветку `master`.

## Переменные и секреты

- Фронтенд: `.env` на основе `.env.example`
- Worker локально: `worker/.dev.vars`
- Worker в Cloudflare:

```bash
npx wrangler secret put GROQ_API_KEY --config worker/wrangler.toml
```

Также нужно задать обычные переменные окружения Worker:

- `ALLOWED_ORIGIN`
- `GROQ_MODEL` опционально

## Проверка

```bash
npm run lint
npm run build
```
