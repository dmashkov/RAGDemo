import "./globals.css";
import type { Metadata } from "next";
import { DiagProvider } from "@/components/DiagContext";
import DiagnosticsPanel from "@/components/DiagnosticsPanel";

export const metadata: Metadata = {
  title: "RAG Demo (Next.js + Supabase)",
  description: "RAG: ответы по вашим документам (Next.js + Supabase/pgvector)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <DiagProvider>
          <div className="container-narrow py-8">
            <header className="mb-6">
              <h1 className="text-2xl font-semibold">RAG Demo</h1>
              <p className="text-sm text-gray-600">
                Загрузите документы и задайте вопрос — ответы формируются только на их основе.
              </p>
            </header>
            {children}
            <footer className="mt-10 text-xs text-gray-500">
              Demo • Next.js + Supabase (pgvector) • OpenAI
            </footer>
          </div>
          <DiagnosticsPanel />
        </DiagProvider>
      </body>
    </html>
  );
}
