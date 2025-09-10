-- Enable pgvector
create extension if not exists vector;

-- Adjust dimension to match your EMBEDDING_DIM (.env)
-- Default is 1536 for text-embedding-3-small
create table if not exists public.documents (
  id uuid primary key,
  filename text not null,
  mime_type text,
  size_bytes bigint,
  original_text_len int,
  created_at timestamp with time zone default now()
);

create table if not exists public.chunks (
  id uuid primary key,
  document_id uuid references public.documents(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1536),
  created_at timestamp with time zone default now()
);

-- Speed up similarity search
create index if not exists idx_chunks_doc on public.chunks(document_id);
create index if not exists idx_chunks_embedding on public.chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- RPC for similarity search
create or replace function public.match_chunks(
  query_embedding vector(1536),
  match_count int default 5,
  filter_doc uuid default null
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float
)
language sql stable as $$
  select c.id, c.document_id, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.chunks c
  where filter_doc is null or c.document_id = filter_doc
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
