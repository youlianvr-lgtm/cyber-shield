# Cyber Shield

Учебное веб-приложение для тренировки распознавания мошеннических сценариев: сигналы риска, сценарные тренировки и интерактивный чат с разбором.

## Стек

- React + Vite + TypeScript
- Локальное хранение прогресса в `localStorage`
- Cloudflare Worker для проксирования AI-диалога
- GitHub Pages для публикации фронтенда

## Локальный запуск

```bash
npm install
npm run dev
```

Фронтенд использует переменную окружения:

```bash
VITE_CHAT_API_URL=https://your-worker-subdomain.workers.dev/api/chat
```

Если переменная не указана, UI чата работает в режиме без живых ответов.

## Worker (опционально)

```bash
npm run dev:worker
npm run deploy:worker
```

Локальные секреты: `worker/.dev.vars` (на основе `worker/.dev.vars.example`).

## Проверка перед публикацией

```bash
npm run lint
npm run build
```

## Публикация в GitHub Pages

Workflow расположен в `.github/workflows/deploy-pages.yml` и запускается при пуше в ветку `main`.

В настройках репозитория:

1. Откройте `Settings -> Pages`.
2. Выберите источник `GitHub Actions`.

## Ветки

- Основная ветка проекта: `main`
- `master` используется только как архивная/историческая
