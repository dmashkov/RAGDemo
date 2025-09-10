import OpenAI from "openai";

const PROVIDER = process.env.LLM_PROVIDER || "openai"; // "openai" | "ollama"
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4o-mini";
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || "llama3.1:8b";

export async function chatWithModel(system: string, user: string): Promise<string> {
  if (PROVIDER === "ollama") {
    // Simple generate endpoint
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_CHAT_MODEL,
        prompt: `${system}\n\nUser: ${user}\nAssistant:`,
        stream: false
      }),
    });
    if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`);
    const data = await res.json();
    return data.response || "";
  } else {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const r = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    });
    return r.choices[0]?.message?.content || "";
  }
}
