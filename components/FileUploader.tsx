"use client";

import React, { useState } from "react";
import { useDiag } from "@/components/DiagContext";

type UploadStep = { t: string; level?: "info" | "warn" | "error"; data?: any };
type FileReport = {
  name: string;
  mime?: string;
  size?: number;
  docId?: string;
  textLen?: number;
  chunks?: number;
  parser?: string;
  steps?: UploadStep[];
};

export default function FileUploader() {
  const [files, setFiles] = useState<FileList | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reports, setReports] = useState<FileReport[]>([]);
  const { addLog } = useDiag();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!files || files.length === 0) return;

    const form = new FormData();
    Array.from(files).forEach((f) => form.append("files", f));

    setUploading(true);
    setReports([]);
    addLog({ source: "Upload", level: "info", message: `Начинаю загрузку: ${files.length} файл(ов)` });

    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const ct = res.headers.get("content-type") || "";
      const payload = ct.includes("application/json") ? await res.json() : { error: await res.text() };

      if (!res.ok) {
        const msg = payload?.error || (typeof payload === "string" ? payload : `HTTP ${res.status}`);
        addLog({ source: "Upload", level: "error", message: `Ошибка загрузки`, details: msg });
        throw new Error(msg);
      }

      const filesReport: FileReport[] = payload?.files || [];
      setReports(filesReport);

      for (const r of filesReport) {
        addLog({ source: "Upload", level: "info", message: `Обработан файл: ${r.name}`, details: r });
        (r.steps || []).forEach((s) =>
          addLog({ source: "Upload", level: s.level || "info", message: s.t, details: s.data })
        );
      }

      addLog({ source: "Upload", level: "info", message: `Готово: документов — ${payload?.ingested ?? 0}` });
    } catch (err: any) {
      addLog({ source: "Upload", level: "error", message: "Исключение при загрузке", details: err?.message || String(err) });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="card">
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">Загрузить файлы (PDF, DOCX, XLSX, TXT)</label>
          <input type="file" multiple accept=".pdf,.docx,.xlsx,.txt" onChange={(e) => setFiles(e.target.files)} className="block w-full" />
          {files && files.length > 0 && (
            <ul className="mt-2 text-xs text-gray-600 list-disc list-inside">
              {Array.from(files).map((f) => (<li key={f.name}>{f.name}</li>))}
            </ul>
          )}
        </div>
        <div className="flex gap-2">
          <button className="px-4 py-2 rounded-xl bg-gray-900 text-white disabled:opacity-60" disabled={uploading || !files || files.length === 0} type="submit">
            {uploading ? "Загрузка..." : "Загрузить и проиндексировать"}
          </button>
        </div>
      </form>

      {reports.length > 0 && (
        <div className="mt-4">
          <div className="text-sm font-medium mb-2">Итог обработки</div>
          <div className="space-y-3">
            {reports.map((r) => (
              <div key={r.name} className="border rounded-xl p-3">
                <div className="text-sm font-semibold">{r.name}</div>
                <div className="text-xs text-gray-600">
                  {r.mime} • {r.size ?? 0} байт • docId: {r.docId || "—"}
                </div>
                <div className="text-xs mt-1">
                  Текста: {r.textLen ?? 0} симв. • Чанков: {r.chunks ?? 0} • Парсер: {r.parser || "—"}
                </div>
                {r.steps && r.steps.length > 0 && (
                  <ul className="mt-2 list-disc list-inside text-xs">
                    {r.steps.map((s, i) => (
                      <li key={i} className={s.level === "error" ? "text-red-600" : s.level === "warn" ? "text-amber-700" : ""}>
                        {s.t}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
