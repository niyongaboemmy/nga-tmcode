import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { getPlatform } from "../../state/store";
import { ActionButton, Codicon } from "../../widgets/icons";
import { SkeletonCard } from "../../widgets/Skeleton";
import { documentKind } from "./documentPreview";

/**
 * PDF and Word (.docx) files, read-only. PDF pages are drawn by pdf.js on
 * canvases (the window's security policy allows no PDF frames); Word
 * documents become sanitised HTML on a page.
 */

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let pdfjsLoad: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs() {
  pdfjsLoad ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return pdfjsLoad;
}

export function DocumentEditor({ path }: { path: string }) {
  const kind = documentKind(path);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const platform = getPlatform();

  useEffect(() => {
    let alive = true;
    setBytes(null);
    if (!platform.fs.readBase64) {
      setError("Previewing documents needs the TMCode desktop app.");
      return;
    }
    platform.fs.readBase64(path).then(
      (b64) => alive && setBytes(base64ToBytes(b64)),
      (e) => alive && setError(String((e as Error)?.message ?? e)),
    );
    return () => {
      alive = false;
    };
  }, [path, platform]);

  return (
    <div className="tm-document" data-testid="document-viewer" data-kind={kind ?? ""}>
      {error ? (
        <DocumentError path={path} message={error} />
      ) : !bytes ? (
        <div className="tm-document-stage">
          <SkeletonCard />
        </div>
      ) : kind === "pdf" ? (
        <PdfView path={path} bytes={bytes} onError={setError} />
      ) : (
        <DocxView path={path} bytes={bytes} onError={setError} />
      )}
    </div>
  );
}

function DocumentError({ path, message }: { path: string; message: string }) {
  const reveal = getPlatform().reveal;
  return (
    <div className="tm-panel-empty tm-document-error">
      <Codicon name="warning" /> <span>{message}</span>
      {reveal && (
        <button type="button" className="tm-button tm-button--secondary" onClick={() => void reveal(path)}>
          Show in Folder
        </button>
      )}
    </div>
  );
}

// ───────────── PDF ─────────────

function PdfView({ path, bytes, onError }: { path: string; bytes: Uint8Array; onError: (m: string) => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [scale, setScale] = useState(1.25);
  const [page, setPage] = useState(1);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let loaded: PDFDocumentProxy | null = null;
    void loadPdfjs()
      .then((pdfjs) => pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise)
      .then(
        (d) => {
          loaded = d;
          if (alive) setDoc(d);
          else void d.destroy();
        },
        (e) => alive && onError(`This PDF could not be opened: ${String((e as Error)?.message ?? e)}`),
      );
    return () => {
      alive = false;
      void loaded?.destroy();
    };
  }, [bytes, onError]);

  const zoom = (dir: 1 | -1) => setScale((s) => Math.max(0.5, Math.min(4, +(dir > 0 ? s * 1.2 : s / 1.2).toFixed(2))));
  const goTo = (n: number) => stage.current?.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block: "start" });

  return (
    <>
      <div className="tm-preview-toolbar">
        <Codicon name="file-pdf" />
        <span className="tm-media-name">{path}</span>
        {doc && (
          <span className="tm-document-pages" data-testid="pdf-pages">
            Page {page} of {doc.numPages}
          </span>
        )}
        <ActionButton icon="zoom-out" label="Zoom Out" onClick={() => zoom(-1)} />
        <span className="tm-media-zoom">{Math.round(scale * 100)}%</span>
        <ActionButton icon="zoom-in" label="Zoom In" onClick={() => zoom(1)} />
      </div>
      <div
        ref={stage}
        className="tm-document-stage tm-scroll is-pdf"
        tabIndex={0}
        onScroll={(e) => {
          // The page whose top is nearest above the middle of the view.
          const mid = e.currentTarget.scrollTop + e.currentTarget.clientHeight / 3;
          let current = 1;
          for (const el of e.currentTarget.querySelectorAll<HTMLElement>("[data-page]")) if (el.offsetTop <= mid) current = Number(el.dataset.page);
          if (current !== page) setPage(current);
        }}
        onKeyDown={(e) => {
          if (!doc) return;
          if (e.key === "PageDown" || e.key === "ArrowRight") goTo(Math.min(doc.numPages, page + 1));
          else if (e.key === "PageUp" || e.key === "ArrowLeft") goTo(Math.max(1, page - 1));
          else return;
          e.preventDefault();
        }}
      >
        {!doc ? <SkeletonCard /> : Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i} doc={doc} n={i + 1} scale={scale} root={stage} />)}
      </div>
    </>
  );
}

/** One page, drawn when it comes near the view (long PDFs open at once). */
function PdfPage({ doc, n, scale, root }: { doc: PDFDocumentProxy; n: number; scale: number; root: React.RefObject<HTMLDivElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [near, setNear] = useState(n <= 2);

  useEffect(() => {
    let alive = true;
    void doc.getPage(n).then((p) => {
      const v = p.getViewport({ scale });
      if (alive) setSize({ w: v.width, h: v.height });
    });
    return () => {
      alive = false;
    };
  }, [doc, n, scale]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || near) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { root: root.current, rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near, root]);

  useEffect(() => {
    if (!near || !size) return;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    let alive = true;
    void doc.getPage(n).then((p) => {
      const el = canvas.current;
      if (!alive || !el) return;
      const dpr = window.devicePixelRatio || 1;
      const v = p.getViewport({ scale: scale * dpr });
      el.width = Math.floor(v.width);
      el.height = Math.floor(v.height);
      const ctx = el.getContext("2d");
      if (!ctx) return;
      task = p.render({ canvasContext: ctx, viewport: v });
      task.promise.then(
        () => el.setAttribute("data-rendered", "true"),
        () => undefined,
      );
    });
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [doc, n, scale, near, size]);

  return (
    <div className="tm-pdf-page" data-page={n} style={size ? { width: size.w, height: size.h } : undefined}>
      <canvas ref={canvas} aria-label={`Page ${n}`} style={size ? { width: size.w, height: size.h } : undefined} />
    </div>
  );
}

// ───────────── Word ─────────────

function DocxView({ path, bytes, onError }: { path: string; bytes: Uint8Array; onError: (m: string) => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [notes, setNotes] = useState(0);

  useEffect(() => {
    let alive = true;
    void import("mammoth")
      .then((m) => m.default.convertToHtml({ arrayBuffer: bytes.slice().buffer }))
      .then(
        (r) => {
          if (!alive) return;
          setHtml(DOMPurify.sanitize(r.value, { FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "link", "meta", "base"] }));
          setNotes(r.messages.filter((m) => m.type === "warning").length);
        },
        (e) => alive && onError(`This Word document could not be opened: ${String((e as Error)?.message ?? e)}`),
      );
    return () => {
      alive = false;
    };
  }, [bytes, onError]);

  return (
    <>
      <div className="tm-preview-toolbar">
        <Codicon name="file" />
        <span className="tm-media-name">{path}</span>
        <span className="tm-muted" title="Fonts, colours and page layout aren't shown; the text, headings, lists, tables and pictures are.">
          Preview{notes ? ` · ${notes} part${notes === 1 ? "" : "s"} not shown` : ""}
        </span>
      </div>
      <div className="tm-document-stage tm-scroll is-docx">
        {html === null ? <SkeletonCard /> : <article className="tm-docx-page tm-markdown-body" data-testid="docx-page" dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </>
  );
}
