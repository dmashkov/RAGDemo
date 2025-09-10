/**
 * Простая нарезка текста на фрагменты ~1200 символов с overlap=200.
 * Для демо — без точной токенизации.
 */
export function chunkText(input: string, maxLen = 1200, overlap = 200): string[] {
  const text = input.replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxLen, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
    if (start < 0) start = 0;
  }
  return chunks;
}
