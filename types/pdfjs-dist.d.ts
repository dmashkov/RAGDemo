// Грубая декларация, чтобы TS не ругался при импорте pdfjs в Node/SSR
declare module 'pdfjs-dist/build/pdf.js' {
  export const getDocument: any;
  export const GlobalWorkerOptions: any;
  const _default: any;
  export default _default;
}

// (на будущее, если вдруг перейдём на legacy-вход)
declare module 'pdfjs-dist/legacy/build/pdf.js' {
  export const getDocument: any;
  export const GlobalWorkerOptions: any;
  const _default: any;
  export default _default;
}
