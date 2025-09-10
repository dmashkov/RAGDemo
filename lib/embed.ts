import OpenAI from "openai";

const PROVIDER = process.env.LLM_PROVIDER || "openai"; // "openai" | "ollama"
const EMB_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small"; // for OpenAI
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 1536);

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (PROVIDER === "ollama") {
    // Ollama embeddings
    const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status}`);
    const data = await res.json();
    // Ollama returns { embeddings: number[][] }
    return data.embeddings;
  } else {
    // OpenAI embeddings
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const r = await client.embeddings.create({
      model: EMB_MODEL,
      input: texts,
    });
    // v4 API: r.data[].embedding
    return r.data.map((d) => d.embedding as number[]);
  }
}
