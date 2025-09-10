"use client";

import React, { createContext, useContext, useMemo, useRef, useState } from "react";

export type DiagLevel = "info" | "warn" | "error";
export type DiagSource = "Upload" | "Chat" | "System";

export type DiagEvent = {
  id: string;
  ts: number;             // Date.now()
  level: DiagLevel;
  source: DiagSource;
  message: string;
  details?: any;
};

type Ctx = {
  logs: DiagEvent[];
  addLog: (e: Omit<DiagEvent, "id" | "ts"> & { details?: any }) => void;
  clear: () => void;
};

const DiagContext = createContext<Ctx | null>(null);

export function DiagProvider({ children }: { children: React.ReactNode }) {
  const [logs, setLogs] = useState<DiagEvent[]>([]);
  const counter = useRef(0);

  const addLog: Ctx["addLog"] = (e) => {
    const id = `log-${counter.current++}`;
    const ev: DiagEvent = { id, ts: Date.now(), ...e };
    setLogs((prev) => {
      const next = [...prev, ev];
      // ограничим историю, чтобы не разрасталась
      if (next.length > 500) next.shift();
      return next;
    });
  };

  const clear = () => setLogs([]);

  const value = useMemo(() => ({ logs, addLog, clear }), [logs]);
  return <DiagContext.Provider value={value}>{children}</DiagContext.Provider>;
}

export function useDiag() {
  const ctx = useContext(DiagContext);
  if (!ctx) throw new Error("useDiag must be used within DiagProvider");
  return ctx;
}
