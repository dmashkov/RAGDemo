"use client";

import React, { useMemo, useState } from "react";
import { useDiag, DiagEvent } from "./DiagContext";

function fmt(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

export default function DiagnosticsPanel() {
  const { logs, clear } = useDiag();
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState<"all" | "Upload" | "Chat" | "System">("all");
  const [level, setLevel] = useState<"all" | "info" | "warn" | "error">("all");

  const filtered = useMemo(() => {
    return logs.filter((l) => (filter === "all" || l.source === filter) && (level === "all" || l.level === level));
  }, [logs, filter, level]);

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[380px]">
      <div className="flex justify-end mb-2">
        <button
          className="px-3 py-2 rounded-xl bg-gray-900 text-white text-sm"
          onClick={() => setOpen((v) => !v)}
          title="Показать/скрыть панель диагностики"
        >
          {open ? "Скрыть диагностику" : "Показать диагностику"}
        </button>
      </div>

      {open && (
        <div className="bg-white rounded-2xl shadow-xl border p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-sm font-medium">Диагностика</div>
            <div className="flex gap-2">
              <select className="border rounded-lg px-2 py-1 text-xs" value={filter} onChange={(e) => setFilter(e.target.value as any)}>
                <option value="all">Источник: все</option>
                <option value="Upload">Upload</option>
                <option value="Chat">Chat</option>
                <option value="System">System</option>
              </select>
              <select className="border rounded-lg px-2 py-1 text-xs" value={level} onChange={(e) => setLevel(e.target.value as any)}>
                <option value="all">Уровень: все</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
              <button className="text-xs px-2 py-1 rounded-lg bg-gray-100" onClick={clear}>Очистить</button>
            </div>
          </div>

          <div className="h-[280px] overflow-y-auto text-xs space-y-2">
            {filtered.length === 0 && <div className="text-gray-500">Нет событий</div>}
            {filtered.map((l: DiagEvent) => (
              <div key={l.id} className="p-2 rounded-lg border">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-gray-500">{fmt(l.ts)}</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100">{l.source}</span>
                </div>
                <div className={`mt-1 ${l.level === "error" ? "text-red-600" : l.level === "warn" ? "text-amber-700" : "text-gray-800"}`}>
                  {l.message}
                </div>
                {l.details && (
                  <pre className="mt-1 bg-gray-50 rounded p-2 overflow-x-auto">{JSON.stringify(l.details, null, 2)}</pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
