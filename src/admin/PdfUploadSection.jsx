import { useEffect, useRef, useState } from "react";
import { describeError } from "./api.js";
import { adminApi, adminFileUrl, isUploadedFile, uploadPdfFile } from "./client.js";
import { UploadIcon } from "./icons.jsx";
import { checkPdfFile, formatSize, readPageCount, titleFromFileName } from "./pdfFile.js";
import { ErrorNotice } from "./ui.jsx";

/** A readable name for the current file address. */
function fileLabel(url) {
  const last = decodeURIComponent(String(url).split("?")[0].split("/").pop() ?? "");
  return isUploadedFile(url) ? last.replace(/^[a-z0-9]{16}-/, "") : last;
}

/** Where "Open" goes: uploads through the admin's address (drafts are not public). */
const openHref = (url) => adminFileUrl(url) ?? (/^https?:/.test(url) ? url : `${import.meta.env.BASE_URL}${url.replace(/^\/+/, "")}`);

/**
 * The PDF part of the editor: upload a file from this computer (button or
 * drag and drop), see it checked, its page count read and its upload
 * progress; or replace the current file. A file address (documents/… or
 * https://…) can still be typed instead.
 */
export default function PdfUploadSection({ form, onForm, errors, ids }) {
  const [upload, setUpload] = useState({ status: "idle" });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const controller = useRef(null);
  const current = form.fileUrl.trim();
  const busy = upload.status === "checking" || upload.status === "uploading";

  // A PDF dropped next to the drop area must not open in the browser
  // (leaving the editor).
  useEffect(() => {
    const stop = (event) => {
      if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
      controller.current?.abort();
    };
  }, []);

  async function choose(file) {
    if (!file || busy) return;
    setUpload({ status: "checking", name: file.name, size: file.size });
    const problem = await checkPdfFile(file);
    if (problem) {
      setUpload({ status: "error", message: problem });
      return;
    }
    const pages = await readPageCount(file);
    if (pages === null) {
      setUpload({ status: "error", message: `“${file.name}” could not be opened as a PDF (it may be damaged or password-protected).` });
      return;
    }
    try {
      await adminApi.session(); // an upload cannot notice an expired sign-in by itself
    } catch (error) {
      setUpload({ status: "error", error });
      return;
    }
    controller.current = new AbortController();
    setUpload({ status: "uploading", name: file.name, size: file.size, pages, sent: 0, total: file.size });
    try {
      const { file: stored } = await uploadPdfFile(file, {
        signal: controller.current.signal,
        onProgress: (sent, total) => setUpload((previous) => (previous.status === "uploading" ? { ...previous, sent, total } : previous)),
      });
      onForm((form) => ({
        ...form,
        fileUrl: stored.url,
        pageCount: String(pages),
        title: form.title.trim() ? form.title : titleFromFileName(stored.name),
      }));
      setUpload({ status: "done", name: stored.name, size: stored.size, pages });
    } catch (error) {
      setUpload(error?.kind === "aborted" ? { status: "idle", message: "Upload cancelled." } : { status: "error", error });
    }
  }

  const percent = upload.status === "uploading" && upload.total ? Math.round((upload.sent / upload.total) * 100) : 0;
  const errorText = upload.error && upload.error.kind !== "session" ? upload.error.body?.error ?? describeError(upload.error) : null;

  return (
    <div className="editor-section editor-fields" dir="ltr" lang="en">
      <div className="editor-field">
        <span className="editor-label">PDF file</span>
        <div
          className={`upload-drop${dragging ? " upload-drop--active" : ""}`}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            choose(event.dataTransfer.files?.[0]);
          }}
        >
          {current && upload.status !== "uploading" && (
            <p className="upload-drop__current">
              <span className="upload-drop__name">{fileLabel(current)}</span>
              <a href={openHref(current)} rel="noreferrer" target="_blank">
                Open <span aria-hidden="true">↗</span>
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            </p>
          )}
          {upload.status === "uploading" ? (
            <div className="upload-progress">
              <p>
                Uploading <strong>{upload.name}</strong> · {formatSize(upload.size)} · {upload.pages} {upload.pages === 1 ? "page" : "pages"}
              </p>
              <div aria-label={`Uploading ${upload.name}`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={percent} className="upload-progress__bar" role="progressbar">
                <span style={{ width: `${percent}%` }} />
              </div>
              <p className="upload-progress__numbers">
                {percent}% · {formatSize(upload.sent)} of {formatSize(upload.total)}
                <button className="button button--small" onClick={() => controller.current?.abort()} type="button">
                  Cancel upload
                </button>
              </p>
            </div>
          ) : (
            <div className="upload-drop__actions">
              <button aria-disabled={busy || undefined} className="button button--small button--primary" onClick={() => !busy && inputRef.current?.click()} type="button">
                <UploadIcon />
                {current ? "Replace PDF" : "Upload PDF"}
              </button>
              <span>{upload.status === "checking" ? `Checking ${upload.name}…` : "or drop a PDF here · 25 MB at most"}</span>
            </div>
          )}
          <input
            accept="application/pdf,.pdf"
            aria-label="Choose a PDF file"
            className="visually-hidden"
            onChange={(event) => {
              choose(event.target.files?.[0]);
              event.target.value = "";
            }}
            ref={inputRef}
            tabIndex={-1}
            type="file"
          />
        </div>
        <p className="editor-hint" role="status">
          {upload.status === "done"
            ? `Uploaded ${upload.name} (${formatSize(upload.size)}, ${upload.pages} ${upload.pages === 1 ? "page" : "pages"}). Save within a day to keep it; it becomes public when the item is published, and a replaced file stays in the history.`
            : upload.message ?? ""}
        </p>
        {upload.status === "error" && upload.message && <p className="editor-error">{upload.message}</p>}
        {upload.status === "error" && errorText && <p className="editor-error">{errorText}</p>}
        {upload.status === "error" && upload.error?.kind === "session" && <ErrorNotice error={upload.error} />}
        {errors?.fileUrl && <p className="editor-error">PDF file {errors.fileUrl}</p>}
      </div>

      <div className="editor-field editor-field--short">
        <label className="editor-label" htmlFor={ids.pageCount}>
          Pages <span className="editor-optional">(read from the file)</span>
        </label>
        <input
          aria-invalid={Boolean(errors?.pageCount) || undefined}
          className="editor-input"
          id={ids.pageCount}
          inputMode="numeric"
          onChange={(event) => onForm((form) => ({ ...form, pageCount: event.target.value }))}
          value={form.pageCount}
        />
        {errors?.pageCount && <p className="editor-error">Pages {errors.pageCount}</p>}
      </div>

      <details className="editor-advanced">
        <summary>Use a file address instead</summary>
        <div className="editor-field">
          <label className="editor-label" htmlFor={ids.fileUrl}>
            File address
          </label>
          <input
            aria-describedby={`${ids.fileUrl}-hint`}
            className="editor-input"
            id={ids.fileUrl}
            onChange={(event) => onForm((form) => ({ ...form, fileUrl: event.target.value }))}
            placeholder="documents/name.pdf or https://…"
            spellCheck={false}
            value={form.fileUrl}
          />
          <p className="editor-hint" id={`${ids.fileUrl}-hint`}>
            A file already on this site (documents/…) or at an https:// address.
          </p>
        </div>
      </details>
    </div>
  );
}
