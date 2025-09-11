import React from "react";
import ReactMarkdown from "react-markdown";

type Citation = {
  n: number;
  docId: string;
  filename: string;
  url: string | null;
  preview?: string;
};

type Props = {
  /** От сервера лучше передавать answer_linked (уже с кликабельными [#n]) */
  textMarkdown: string;
  citations?: Citation[];
  className?: string;
};

export default function AssistantMessage({
  textMarkdown,
  citations = [],
  className = "",
}: Props) {
  return (
    <div className={`space-y-3 ${className}`}>
      {/* Тело ответа ассистента */}
      <div className="prose prose-sm max-w-none break-words [&_a]:text-blue-600">
        <ReactMarkdown
          components={{
            a: (props) => (
              <a
                {...props}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              />
            ),
            p: (props) => <p {...props} className="mb-2 last:mb-0" />,
            ul: (props) => <ul {...props} className="list-disc pl-5 my-2" />,
            ol: (props) => <ol {...props} className="list-decimal pl-5 my-2" />,
            code: (props) => (
              <code
                {...props}
                className="rounded bg-gray-100 px-1 py-0.5 text-[0.85em]"
              />
            ),
          }}
        >
          {textMarkdown}
        </ReactMarkdown>
      </div>

      {/* Блок источников */}
      {citations.length > 0 && (
        <div className="rounded-xl border bg-gray-50 p-3">
          <div className="mb-2 flex items-center gap-2">
            <div className="text-xs font-semibold text-gray-700">
              Источники
            </div>
            <div className="text-[10px] text-gray-400">
              ссылки действуют ~1 час
            </div>
          </div>

          <ul className="space-y-1">
            {citations
              .sort((a, b) => a.n - b.n)
              .map((c) => (
                <li key={c.n} className="text-xs">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gray-800 text-white mr-2 text-[10px]">
                    {c.n}
                  </span>
                  {c.url ? (
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium underline"
                      title={c.filename}
                    >
                      {c.filename}
                    </a>
                  ) : (
                    <span className="font-medium text-gray-700">
                      {c.filename}
                    </span>
                  )}
                  {c.preview && (
                    <span className="text-gray-500"> — {c.preview}</span>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
