классная мысль. давай сделаем **один “паспорт проекта”**, который можно кинуть в начало нового чата — и у меня будет весь нужный контекст без листания истории. Ниже — готовый файл. Сохрани его как `docs/PROJECT_SNAPSHOT.md` в репозитории (и просто копируй содержимое в новый чат, когда надо продолжить работу).

---

# PROJECT\_SNAPSHOT.md

> **Как этим пользоваться в новом чате**
> Скопируйте весь этот файл в первый запрос нового чата. В нём: архитектура, переменные окружения, схемы таблиц, карта API, и текущие рабочие файлы (полные тексты ключевых роутов и функций), плюс заметки и TODO.

## 1) TL;DR / Контекст

* **Проекты:**

  * **prod**: `RAGDemo` — рабочая версия.
  * **lab**: `RAGDemo-lab` — «песочница» для PDF и экспериментальных правок.
* **Хостинг фронта/роутов:** Netlify (Next.js 14, App Router).
* **Хранилище и БД:** Supabase с `pgvector`.
* **Bucket:** `documents`.
* **Цель:** RAG: загрузка документов → чанкинг → эмбеддинги → поиск релевантных чанков → ответ + «Источники».
* **PDF статус:** в `lab` используем `pdfjs+pdfparse` (без системных двоичных зависимостей). Если файл не парсится — возвращаем `error: empty text`.

## 2) Переменные окружения (Netlify → Site settings → Environment)

```
NEXT_PUBLIC_SUPABASE_URL=<…>
SUPABASE_ANON_KEY=<…>
SUPABASE_SERVICE_ROLE_KEY=<…>

OPENAI_API_KEY=<…>
LLM_PROVIDER=openai
CHAT_MODEL=gpt-4o-mini

EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIM=1536

DOCS_BUCKET=documents

MAX_CONTEXT_CHUNKS=16
MAX_CHUNKS=32
CHUNK_CLIP_LEN=280
CITATION_TTL=600

INGEST_BATCH=48
INGEST_SUBBATCH=16

PDF_MODE=pdfjs+pdfparse
```

## 3) Supabase схема (минимальная)

```sql
-- documents
-- id UUID PK (DEFAULT gen_random_uuid())
-- filename TEXT
-- mime_type TEXT
-- storage_path TEXT
-- size_bytes BIGINT NULL
-- original_text_len INT NULL
-- status TEXT CHECK (status IN ('queued','processing','ready','error')) DEFAULT 'queued'
-- error TEXT NULL
-- created_at TIMESTAMPTZ DEFAULT now()

-- chunks
-- id UUID PK (DEFAULT gen_random_uuid())
-- document_id UUID REFERENCES documents(id) ON DELETE CASCADE
-- chunk_index INT
-- content TEXT
-- embedding VECTOR(1536)
-- created_at TIMESTAMPTZ DEFAULT now()

-- RPC:
-- match_chunks(query_embedding VECTOR(1536), match_count INT)
-- hybrid_match_chunks(query_text TEXT, query_embedding VECTOR(1536), match_count INT)
```

## 4) Карта API (Next.js /app/api)

* `GET  /api/ping` — health.
* `POST /api/upload` — приём файлов, запись в Storage + `documents`, запуск фоновой индексации.
* `GET  /api/doc-status?docId=…` — статус документа и количество чанков.
* `POST /api/chat` — ответ + «Источники» (RAG).
* `POST /api/reindex` — поставить все доки в очередь (lab-инструмент).

## 5) Netlify Functions (фоновые)

* `/.netlify/functions/ingest-background` — **асинхронная** индексация одного документа (рекомендуется).
* `/.netlify/functions/ingest-run` — **синхронная** индексация (может упираться в таймаут).
* `/.netlify/functions/ingest-debug` — диагностика: скачивание и превью текста (без вставки).

---

## 6) Рабочие файлы (полные версии)

### app/api/chat/route.ts

```ts
// app/api/chat/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const MAX_CONTEXT_CHUNKS = Number(process.env.MAX_CONTEXT_CHUNKS || 16);
const CHUNK_CLIP_LEN = Number(process.env.CHUNK_CLIP_LEN || 280);
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4o-mini";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 1536);

function sbAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

function normalize(s: string) {
  return s.replace(/\r/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function clip(s: string, n = CHUNK_CLIP_LEN) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages: Array<{ role: string; content: string }> = body?.messages || [];
    const lastUser =
      messages.slice().reverse().find((m) => m.role === "user")?.content?.toString() || "";
    if (!lastUser.trim()) {
      return new Response(JSON.stringify({ error: "empty user message" }), { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    // embed query
    const emb = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: lastUser });
    const qVec = emb.data[0]?.embedding;
    if (!qVec || qVec.length !== EMBEDDING_DIM) {
      return new Response(JSON.stringify({ error: "embedding failed" }), { status: 500 });
    }

    const supabase = sbAdmin();

    // try hybrid first
    let top: any[] = [];
    try {
      const r = await supabase.rpc("hybrid_match_chunks", {
        query_text: lastUser,
        query_embedding: qVec,
        match_count: MAX_CONTEXT_CHUNKS,
      });
      if (!r.error && Array.isArray(r.data)) top = r.data;
    } catch (_) {
      /* no-op, fallback below */
    }

    // fallback to pure vector match
    if (top.length === 0) {
      const r2 = await supabase.rpc("match_chunks", {
        query_embedding: qVec,
        match_count: MAX_CONTEXT_CHUNKS,
      });
      if (r2.error) throw new Error(r2.error.message);
      top = r2.data || [];
    }

    // gather docs meta for citations
    const docIds = Array.from(new Set((top as any[]).map((r) => r.document_id))).filter(Boolean);
    let docsMeta: Array<{ id: string; filename: string; storage_path: string | null }> = [];
    if (docIds.length) {
      const { data, error } = await supabase
        .from("documents")
        .select("id, filename, storage_path")
        .in("id", docIds);
      if (!error && Array.isArray(data)) docsMeta = data as any;
    }

    // build context
    const contextBlocks: string[] = [];
    const seen = new Set<number>();
    for (const row of top as any[]) {
      const idx = Number(row.chunk_index ?? -1);
      if (seen.has(idx)) continue;
      seen.add(idx);
      const one = [
        `# Doc:${row.document_id} • chunk:${row.chunk_index}`,
        normalize(row.content || ""),
      ].join("\n");
      contextBlocks.push(one);
    }

    const system = [
      "Ты — ассистент, отвечающий строго по предоставленному контексту.",
      "Если ответ не найден в контексте — прямо скажи об этом.",
      "В конце верни список источников с метаданными по документам.",
    ].join(" ");

    const prompt = [
      "Контекст ниже. Используй только его.",
      "",
      contextBlocks.join("\n\n---\n\n"),
      "",
      "Вопрос пользователя:",
      lastUser.trim(),
    ].join("\n");

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    });

    const answer = completion.choices[0]?.message?.content?.trim() || "";

    // citations: group by document_id
    const docOrder: string[] = docIds;
    type Citation = {
      id: string;
      label: string;
      file: string;
      url: string | null;
      parts: Array<{ idx: number; preview: string }>;
    };
    const citations: Citation[] = [];
    for (const id of docOrder) {
      const meta = docsMeta?.find((d) => d.id === id);
      if (!meta) continue;

      let url: string | null = null;
      if (meta.storage_path) {
        // публичные линки не формируем тут (RLS/политики разные), пока просто null
        url = null;
      }

      const parts = (top as any[])
        .filter((r) => r.document_id === id)
        .slice(0, 4)
        .map((r) => ({
          idx: Number(r.chunk_index ?? 0),
          preview: clip(normalize(r.content || "")),
        }));

      citations.push({
        id,
        label: meta.filename || "document",
        file: meta.filename || "document",
        url,
        parts,
      });
    }

    return new Response(JSON.stringify({ ok: true, answer, citations }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), {
      status: 500,
    });
  }
}
```

### app/api/upload/route.ts

```ts
// app/api/upload/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const BUCKET = process.env.DOCS_BUCKET || "documents";
const NETLIFY = process.env.NETLIFY === "true";

function sbAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function sanitizeFilename(name: string) {
  return (name || "file").replace(/[^\w.\- ]/g, "_").replace(/\s+/g, "_").slice(0, 140);
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const files = form.getAll("files") as File[];
    if (!files?.length) {
      return NextResponse.json({ ok: false, error: "no files" }, { status: 400 });
    }

    const supabase = sbAdmin();
    const results: any[] = [];

    for (const f of files) {
      const id = uuidv4();
      const name = sanitizeFilename(f.name || "file");
      const storagePath = `${id}__${name}`;

      // save to storage
      const ab = await f.arrayBuffer();
      const up = await supabase.storage.from(BUCKET).upload(storagePath, ab, {
        contentType: f.type || "application/octet-stream",
        upsert: false,
      });
      if (up.error) {
        results.push({ name: f.name, size: f.size, type: f.type, error: up.error.message });
        continue;
      }

      // insert document row
      const ins = await supabase
        .from("documents")
        .insert({
          id,
          filename: f.name || "file",
          mime_type: f.type || "application/octet-stream",
          storage_path: storagePath,
          size_bytes: Number(f.size ?? 0),
          status: "queued",
        })
        .select("id")
        .single();

      if (ins.error) {
        results.push({
          name: f.name,
          size: f.size,
          type: f.type,
          storagePath,
          error: ins.error.message,
        });
        continue;
      }

      // trigger background ingest
      let bgRespStatus: number | null = null;
      let bgRespData: any = null;

      try {
        // Netlify background function
        const endpoint = new URL("/.netlify/functions/ingest-background", req.url);
        const r = await fetch(endpoint.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docId: id }),
        });
        bgRespStatus = r.status;
        bgRespData = r.status === 202 ? null : await r.text();
      } catch (e: any) {
        bgRespStatus = 0;
        bgRespData = e?.message || String(e);
      }

      results.push({
        name: f.name,
        size: f.size,
        type: f.type,
        docId: id,
        storagePath,
        ingest: { ok: bgRespStatus === 202, status: bgRespStatus, data: bgRespData },
      });
    }

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
```

### app/api/doc-status/route.ts

```ts
// app/api/doc-status/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

function sbAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function GET(req: NextRequest) {
  try {
    const docId = new URL(req.url).searchParams.get("docId") || "";
    if (!docId) return new Response(JSON.stringify({ ok: false, error: "no docId" }), { status: 400 });

    const supabase = sbAdmin();
    const { data: doc, error } = await supabase.from("documents").select("*").eq("id", docId).single();
    if (error || !doc) return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404 });

    const { count } = await supabase.from("chunks").select("*", { count: "exact", head: true }).eq("document_id", docId);
    return new Response(JSON.stringify({ ok: true, doc, chunks: count || 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), { status: 500 });
  }
}
```

### app/api/reindex/route.ts

```ts
// app/api/reindex/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

function sbAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const scope = (body?.scope || "all") as "all" | "missing" | "failed";

    const supabase = sbAdmin();

    let q = supabase.from("documents").select("id,status").order("created_at", { ascending: false });
    const { data: docs, error } = await q;
    if (error) throw new Error(error.message);

    const docIds = (docs || [])
      .filter((d: any) => {
        if (scope === "all") return true;
        if (scope === "missing") return d.status !== "ready";
        if (scope === "failed") return d.status === "error";
        return true;
      })
      .map((d: any) => d.id);

    if (!docIds.length) return new Response(JSON.stringify({ ok: true, queued: 0 }));

    await supabase.from("documents").update({ status: "queued", error: null } as any).in("id", docIds);

    let queued = 0;
    for (const id of docIds) {
      const endpoint = new URL("/.netlify/functions/ingest-background", req.url);
      await fetch(endpoint.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId: id }),
      });
      queued++;
    }

    return new Response(JSON.stringify({ ok: true, queued }));
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), { status: 500 });
  }
}
```

### netlify/functions/ingest-background.ts

```ts
// netlify/functions/ingest-background.ts
import type { BackgroundHandler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const BUCKET = process.env.DOCS_BUCKET || "documents";
const EMB_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const EMB_DIM = Number(process.env.EMBEDDING_DIM || 1536);
const BATCH = Number(process.env.INGEST_BATCH || 48);
const SUB = Number(process.env.INGEST_SUBBATCH || 16);

function sbAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function normalize(text: string) {
  return text.replace(/\r/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
}

function chunkText(t: string, size = 900, overlap = 150) {
  const out: string[] = [];
  let i = 0;
  while (i < t.length) {
    const end = Math.min(i + size, t.length);
    let cut = end;
    const soft = t.lastIndexOf(" ", end - 20);
    if (soft > i + 200) cut = soft;
    out.push(t.slice(i, cut).trim());
    i = Math.max(0, cut - overlap);
    if (i >= t.length) break;
  }
  return out.filter(Boolean);
}

async function embedBatch(openai: OpenAI, texts: string[]) {
  const res = await openai.embeddings.create({ model: EMB_MODEL, input: texts });
  return res.data.map((d) => d.embedding as number[]);
}

async function downloadDoc(supabase: ReturnType<typeof sbAdmin>, key: string) {
  const d = await supabase.storage.from(BUCKET).download(key);
  if (d.error || !d.data) throw new Error(`download failed: ${key} (${d.error?.message ?? "no data"})`);
  const buf = Buffer.from(await d.data.arrayBuffer());
  return buf;
}

async function extractText(buf: Buffer, mime: string | null, key: string) {
  const lower = key.toLowerCase();
  if ((mime?.startsWith("text/")) || lower.endsWith(".txt")) {
    return normalize(buf.toString("utf8"));
  }
  if (lower.endsWith(".docx") || (mime ?? "").includes("word")) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return normalize(value || "");
  }
  if (lower.endsWith(".pdf") || (mime ?? "").includes("pdf")) {
    // Лёгкий режим для Netlify: пробуем pdf-parse, иначе пусто
    try {
      const pdfParse = (await import("pdf-parse")).default as any;
      const parsed = await pdfParse(buf);
      return normalize(parsed.text || "");
    } catch {
      return "";
    }
  }
  return "";
}

export const handler: BackgroundHandler = async (event) => {
  const supabase = sbAdmin();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

  try {
    const body = JSON.parse(event.body || "{}");
    const docId: string = body?.docId;
    if (!docId) return { statusCode: 400, body: "no docId" };

    const { data: doc, error } = await supabase.from("documents").select("*").eq("id", docId).single();
    if (error || !doc) return { statusCode: 404, body: "not found" };

    await supabase.from("documents").update({ status: "processing", error: null }).eq("id", docId);

    const buf = await downloadDoc(supabase, doc.storage_path);
    const text = await extractText(buf, doc.mime_type, doc.storage_path);

    if (!text) {
      await supabase.from("documents").update({ status: "error", error: "empty text after extraction" }).eq("id", docId);
      return { statusCode: 200, body: "done" };
    }

    const parts = chunkText(text);
    if (parts.length === 0) {
      await supabase.from("documents").update({ status: "error", error: "no chunks" }).eq("id", docId);
      return { statusCode: 200, body: "done" };
    }

    await supabase.from("chunks").delete().eq("document_id", docId);

    let inserted = 0;
    for (let i = 0; i < parts.length; i += BATCH) {
      const batch = parts.slice(i, i + BATCH);

      // sub-batching embeddings (для стабильности)
      const embs: number[][] = [];
      for (let j = 0; j < batch.length; j += SUB) {
        const sub = batch.slice(j, j + SUB);
        const subEmb = await embedBatch(openai, sub);
        embs.push(...subEmb);
      }

      const rows = batch.map((content, idx) => ({
        document_id: docId,
        chunk_index: i + idx,
        content,
        embedding: embs[idx],
      }));

      const ins = await supabase.from("chunks").insert(rows as any);
      if (ins.error) throw new Error(ins.error.message);

      inserted += rows.length;
    }

    await supabase
      .from("documents")
      .update({ status: "ready", original_text_len: text.length, error: null })
      .eq("id", docId);

    return { statusCode: 200, body: `ok:${inserted}` };
  } catch (e: any) {
    try {
      // best-effort: пометить ошибку
      const body = JSON.parse(event.body || "{}");
      if (body?.docId) {
        await supabase.from("documents").update({ status: "error", error: e?.message || String(e) }).eq("id", body.docId);
      }
    } catch {}
    return { statusCode: 500, body: e?.message || String(e) };
  }
};
```

---

## 7) Команды проверки

```cmd
:: ping
curl -i https://<LAB>.netlify.app/api/ping

:: загрузка txt
curl -X POST -H "Expect:" ^
  -F "files=@C:/test.txt;type=text/plain" ^
  https://<LAB>.netlify.app/api/upload

:: статус
curl -s "https://<LAB>.netlify.app/api/doc-status?docId=<ID>"

:: массовая переиндексация (lab)
curl -i -X POST "https://<LAB>.netlify.app/api/reindex" ^
  -H "Content-Type: application/json" ^
  -d "{\"scope\":\"all\"}"
```

---

## 8) Известные нюансы / решения

* **Netlify 502/504** на синхронной индексации — использовать **background function**.
* Ошибки TS типа `never` в RPC/updates — **свести типы к any** на insert/update селекторах.
* PDF может давать `empty text` — это норм в текущем «лёгком» режиме; для продулучшения тестируем `pdfjs-dist` и/или внешний OCR.
* В «Источниках» пока без публичных URL; для прямых ссылок потребуется подпись ссылок из Storage.

---

## 9) TODO (лаборатория)

* Улучшить PDF extractor (pdfjs без воркера, graceful fallback).
* Добавить OCR-проверку и диагностические события в панель.
* Выдавать временные публичные ссылки на Storage (signed URLs) в цитатах.
* Бэчить upsert’ы в `chunks` через copy/insert для крупных файлов.

---

**Вот и всё.**
Сохрани этот файл в репо как `docs/PROJECT_SNAPSHOT.md`. Когда начнёшь новый чат — просто вставь его сюда целиком, и мы сможем продолжить с точным контекстом.
