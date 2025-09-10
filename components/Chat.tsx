"use client";

import React, { useState } from "react";
import { useDiag } from "@/components/DiagContext";
type Msg = { role: "user" | "assistant"; content: string };

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Здравствуйте! Загрузите документы и задайте вопрос. Я отвечаю только по их содержанию." }
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const { addLog } = useDiag();

  const ask = async () => {
    if (!input.trim()) return;
    const newMsgs = [...messages, { role: "user", content: input } as Msg];
    setMessages(newMsgs);
    setInput("");
    setBusy(true);
    addLog({ source: "Chat", level: "info", message: `Вопрос: ${newMsgs[newMsgs.length-1].content}` });

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMsgs }),
      });
      const ct = res.headers.get("content-type") || "";
      const data = ct.includes("application/json") ? await res.json() : { error: await res.text() };
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      if (data?.debug) {
        addLog({ source: "Chat", level: "info", message: `RAG: used=${data.debug.used}, bestSim=${data.debug.bestSim}`, details: data.debug });
      }
      setMessages([...newMsgs, { role: "assistant", content: data?.answer || "(пустой ответ)" }]);
    } catch (e:any) {
      addLog({ source: "Chat", level: "error", message: "Ошибка ответа чата", details: e.message });
      setMessages([...newMsgs, { role: "assistant", content: `Ошибка: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="space-y-3 max-h-[60vh] overflow-y-auto">
        {messages.map((m, i) => (
          <div key={i} className="p-3 rounded-xl" style={{ background: m.role === "assistant" ? "#f8fafc" : "#eef2ff" }}>
            <div className="badge mb-1">{m.role === "assistant" ? "Помощник" : "Вы"}</div>
            <div className="whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <input className="flex-1 border rounded-xl p-3" placeholder="Сформулируйте вопрос по загруженным файлам..."
               value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? ask() : null)} />
        <button className="px-4 py-2 rounded-xl bg-indigo-600 text-white disabled:opacity-60" onClick={ask} disabled={busy}>Спросить</button>
      </div>
    </div>
  );
}
