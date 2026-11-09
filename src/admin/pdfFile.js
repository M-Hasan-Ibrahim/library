/**
 * Checks a PDF chosen on this computer before it is uploaded, and reads its
 * page count with pdf.js (already used by the reading view; loaded only
 * when needed). The server checks the file again.
 */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

export const formatSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** "lecture_notes-v2.pdf" -> "Lecture notes v2". */
export function titleFromFileName(name) {
  const base = String(name ?? "")
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base ? base.charAt(0).toLocaleUpperCase() + base.slice(1) : "";
}

/** Problems with the file itself (null if it looks like a PDF that can be sent). */
export async function checkPdfFile(file) {
  if (!file) return "Choose a PDF file.";
  const named = /\.pdf$/i.test(file.name ?? "");
  if (!named && file.type !== "application/pdf") return `“${file.name}” is not a PDF file.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (file.size > MAX_PDF_BYTES) return `“${file.name}” is ${formatSize(file.size)}; PDFs can be at most 25 MB.`;
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (!String.fromCharCode(...head).includes("%PDF-")) return `“${file.name}” is not a PDF file (its content is something else).`;
  return null;
}

/** The number of pages, or null if pdf.js cannot read the file. */
export async function readPageCount(file) {
  try {
    const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const pdf = await task.promise;
    const pages = pdf.numPages;
    await task.destroy();
    return pages;
  } catch {
    return null;
  }
}
