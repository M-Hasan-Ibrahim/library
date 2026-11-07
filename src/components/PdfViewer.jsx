import { useContext, useEffect, useRef, useState } from "react";
import { PanelScrollContext } from "./panelScrollContext.js";
import { ErrorState, LoadingState } from "./StatusMessage.jsx";

// Sharp on high-density screens without creating oversized canvases.
const MAX_PIXEL_RATIO = 2;
// Pages within this distance of the viewport are drawn; pages further away
// are cleared, so memory stays flat however long the document is.
const RENDER_MARGIN = "1200px 0px";
const RESIZE_DELAY_MS = 200;
const US_LETTER_RATIO = 612 / 792;

const isRenderCancelled = (error) => error?.name === "RenderingCancelledException";

/**
 * Continuous, fit-to-width PDF pages drawn with pdf.js (the browser's canvas),
 * so a PDF reads inside the same container as an article. A native <iframe>
 * PDF viewer is not used because Android browsers cannot show PDFs inline and
 * iOS Safari shows only the first page; this works the same everywhere.
 */
export default function PdfViewer({ url, title }) {
  const pagesRef = useRef(null);
  // Inside the reading panel, the panel scrolls (not the window).
  const scrollRoot = useContext(PanelScrollContext);
  const [documentState, setDocumentState] = useState({
    status: "loading",
    pdf: null,
    pageCount: 0,
    pageRatio: US_LETTER_RATIO,
  });

  // 1. Load the document (pdf.js is downloaded only when a PDF is opened).
  useEffect(() => {
    let isCancelled = false;
    let loadingTask = null;

    (async () => {
      try {
        const [pdfjs, worker] = await Promise.all([
          import("pdfjs-dist"),
          import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);
        if (isCancelled) return;

        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        loadingTask = pdfjs.getDocument({ url });
        const pdf = await loadingTask.promise;
        const firstPage = await pdf.getPage(1);
        const { width, height } = firstPage.getViewport({ scale: 1 });
        if (isCancelled) return;

        setDocumentState({ status: "ready", pdf, pageCount: pdf.numPages, pageRatio: width / height });
      } catch {
        if (!isCancelled) {
          setDocumentState((previous) => ({ ...previous, status: "error", pdf: null }));
        }
      }
    })();

    return () => {
      isCancelled = true;
      // Stops the download/worker and frees everything pdf.js allocated.
      loadingTask?.destroy();
    };
  }, [url]);

  // 2. Draw pages near the viewport; clear pages far from it.
  const { pdf } = documentState;
  useEffect(() => {
    const container = pagesRef.current;
    if (!pdf || !container) return undefined;

    const sheets = Array.from(container.querySelectorAll("[data-page-number]"));
    const drawn = new Map(); // pageNumber -> { width, task }
    const nearby = new Set();
    let isDisposed = false;
    let resizeTimer = 0;

    const clear = (sheet) => {
      const pageNumber = Number(sheet.dataset.pageNumber);
      const job = drawn.get(pageNumber);
      if (!job) return;
      drawn.delete(pageNumber);
      job.task?.cancel();
      const canvas = sheet.querySelector("canvas");
      // Shrinking the canvas releases its pixel memory immediately.
      canvas.width = 0;
      canvas.height = 0;
    };

    const draw = async (sheet) => {
      const pageNumber = Number(sheet.dataset.pageNumber);
      const cssWidth = sheet.clientWidth;
      if (!cssWidth) return;
      if (drawn.get(pageNumber)?.width === cssWidth) return;

      clear(sheet);
      const job = { width: cssWidth, task: null };
      drawn.set(pageNumber, job);
      delete sheet.dataset.state;

      try {
        const page = await pdf.getPage(pageNumber);
        if (isDisposed || drawn.get(pageNumber) !== job) return;

        const base = page.getViewport({ scale: 1 });
        sheet.style.aspectRatio = `${base.width} / ${base.height}`;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
        const viewport = page.getViewport({ scale: (cssWidth / base.width) * pixelRatio });

        const canvas = sheet.querySelector("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        job.task = page.render({ canvas, viewport });
        await job.task.promise;
      } catch (error) {
        if (isDisposed || isRenderCancelled(error) || drawn.get(pageNumber) !== job) return;
        drawn.delete(pageNumber); // allow a retry when the page scrolls back in
        sheet.dataset.state = "error";
      }
    };

    const visibility = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            nearby.add(entry.target);
            draw(entry.target);
          } else {
            nearby.delete(entry.target);
            clear(entry.target);
          }
        }
      },
      { root: scrollRoot, rootMargin: RENDER_MARGIN },
    );
    sheets.forEach((sheet) => visibility.observe(sheet));

    // Redraw visible pages at the new width once resizing settles.
    const resize = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => nearby.forEach(draw), RESIZE_DELAY_MS);
    });
    resize.observe(container);

    return () => {
      isDisposed = true;
      window.clearTimeout(resizeTimer);
      visibility.disconnect();
      resize.disconnect();
      sheets.forEach(clear);
    };
  }, [pdf, scrollRoot]);

  if (documentState.status === "loading") {
    return <LoadingState label="Loading document…" />;
  }

  if (documentState.status === "error") {
    return (
      <ErrorState
        title="The preview could not be loaded."
        message="You can still get the file with the Download button above."
      />
    );
  }

  const { pageCount, pageRatio } = documentState;

  return (
    <section aria-label={`${title}: document pages`} className="pdf-viewer">
      <ol className="pdf-pages" ref={pagesRef} style={{ "--page-ratio": pageRatio }}>
        {Array.from({ length: pageCount }, (_, index) => {
          const pageNumber = index + 1;
          return (
            <li className="pdf-page" key={pageNumber}>
              <span aria-hidden="true" className="pdf-page__label">
                Page {pageNumber} of {pageCount}
              </span>
              <div className="pdf-page__sheet" data-page-number={pageNumber}>
                <span aria-hidden="true" className="pdf-page__placeholder">
                  Page {pageNumber}
                </span>
                {/* 0×0 until drawn: undrawn pages hold no pixel memory. */}
                <canvas aria-label={`Page ${pageNumber} of ${pageCount}`} height={0} role="img" width={0} />
                <span className="pdf-page__error">This page could not be displayed.</span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
