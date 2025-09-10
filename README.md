# RAG Demo • Next.js + Supabase (pgvector) + OpenAI/Ollama

Готовый минимальный шаблон демонстрации Retrieval‑Augmented Generation:
— загрузка файлов (PDF, DOCX, XLSX, TXT) → извлечение текста → нарезка → эмбеддинги → поиск по pgvector → чат «как ChatGPT», но только на основе загруженных документов.

## Стек
- **Next.js 14 (App Router)** + React 18 + TailwindCSS
- **Supabase** (Postgres + pgvector) для хранения документов/эмбеддингов
- **LLM/Embeddings**: OpenAI по умолчанию, опционально **Ollama** (локальная LLM/эмбеддинги)
- Хостинг: локально → Netlify

## Быстрый старт (локально)
1) Клонируйте проект и установите зависимости:
```bash
npm i
```

2) Создайте проект в **Supabase**, включите **pgvector**. Выполните SQL из `supabase/schema.sql` (через SQL Editor).
   > Обратите внимание на размерность вектора (по умолчанию 1536 под `text-embedding-3-small`).

3) Создайте `.env` по образцу `.env.example` и заполните:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (**только на сервере**, не публикуйте)
   - `SUPABASE_ANON_KEY` (если планируете клиентские вызовы к Storage и т.п.)
   - `OPENAI_API_KEY` (если используете OpenAI)
   - Если используете **Ollama** — запустите `ollama serve` и модели (`ollama pull llama3.1:8b`, `ollama pull nomic-embed-text`).

4) Запуск:
```bash
npm run dev
```
Откройте `http://localhost:3000` — загрузите файлы и задайте вопрос.

## Деплой на Netlify
1) Подключите репозиторий к Netlify.
2) Укажите переменные окружения из `.env` в настройках Netlify (Environment).
3) Добавьте плагин Next.js (автоматически из `@netlify/plugin-nextjs`) или оставьте авто‑детект.
4) Триггерните билд — API‑роуты будут работать как серверлесс‑функции.

## Как это работает
- `app/api/upload/route.ts` — приём файлов, извлечение текста (`pdf-parse`, `mammoth`, `xlsx`), нарезка (`lib/chunk.ts`), эмбеддинги (`lib/embed.ts`), запись `documents`/`chunks` в Supabase.
- `app/api/chat/route.ts` — эмбеддинг вопроса, поиск похожих фрагментов через RPC `match_chunks`, генерация ответа LLM (`lib/llm.ts`) с системной подсказкой «отвечай только по контексту».
- `supabase/schema.sql` — таблицы и RPC для pgvector (IVFFlat индекс для ускорения).

## Замечания по безопасности/стоимости
- Для демо допускается `SERVICE_ROLE_KEY` в серверных функциях Netlify. Никогда не публикуйте его в клиентском коде.
- Для снижения стоимости используйте `text-embedding-3-small`. Для локальной работы — Ollama.
- Очистку/удаление документов реализуйте по необходимости (доп. роут /api/delete).

## Идеи для расширения
- Стриминг ответов (Server-Sent Events)
- Подсветка найденных фрагментов и источников
- Сессии/авторизация пользователей (Supabase Auth)
- Модерация и ограничения размера загружаемых файлов
- Асинхронная обработка больших файлов (Supabase Edge Functions / очереди)
- Поддержка других форматов (CSV, PPTX, HTML)
