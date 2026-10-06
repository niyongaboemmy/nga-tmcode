import { useEffect, useRef, useState } from "react";
import { getDocument, onDocumentChanged } from "../../monaco/documents";
import { getPlatform } from "../../state/store";
import { extname } from "../../util/paths";
import { ActionButton, Codicon } from "../../widgets/icons";
import { SkeletonCard } from "../../widgets/Skeleton";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

export function mimeFor(path: string): string | null {
  return MIME[extname(path).toLowerCase()] ?? null;
}

/** Files shown by the media viewer instead of the text editor (SVG stays text, with a preview beside it). */
export function isMediaFile(path: string): boolean {
  const m = mimeFor(path);
  return !!m && m !== "image/svg+xml";
}

function utf8ToBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
}

type Zoom = "fit" | number;

/** VS Code's image/media preview: checkerboard, fit / zoom, dimensions and size. */
export function MediaEditor({ path }: { path: string }) {
  const [src, setSrc] = useState<{ url: string; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const mime = mimeFor(path) ?? "application/octet-stream";
  const kind = mime.split("/")[0];
  const platform = getPlatform();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        // SVG previews follow unsaved edits in the source editor.
        const live = mime === "image/svg+xml" ? getDocument(path)?.getValue() : undefined;
        const b64 =
          live !== undefined
            ? utf8ToBase64(live)
            : platform.fs.readBase64
              ? await platform.fs.readBase64(path)
              : mime === "image/svg+xml"
                ? utf8ToBase64(await platform.fs.readFile(path))
                : null;
        if (!alive) return;
        if (b64 === null) return setError("Previewing binary files needs the TMCode desktop app.");
        setSrc({ url: `data:${mime};base64,${b64}`, bytes: Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0) });
        setError(null);
      } catch (e) {
        if (alive) setError(String((e as Error)?.message ?? e));
      }
    };
    void load();
    const off = onDocumentChanged((p) => p === path && void load());
    return () => {
      alive = false;
      off();
    };
  }, [path, mime, platform]);

  const step = (dir: 1 | -1) => {
    const cur = zoom === "fit" ? 1 : zoom;
    setZoom(Math.max(0.1, Math.min(16, +(dir > 0 ? cur * 1.25 : cur / 1.25).toFixed(3))));
  };

  return (
    <div className="tm-media" data-testid="media-viewer">
      <div className="tm-preview-toolbar">
        <Codicon name={kind === "image" ? "file-media" : kind === "video" ? "device-camera-video" : "unmute"} />
        <span className="tm-media-name">{path}</span>
        {kind === "image" && (
          <>
            <ActionButton icon="zoom-out" label="Zoom Out" onClick={() => step(-1)} />
            <button type="button" className="tm-media-zoom" onClick={() => setZoom(zoom === "fit" ? 1 : "fit")} title="Toggle between fit and 100%">
              {zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`}
            </button>
            <ActionButton icon="zoom-in" label="Zoom In" onClick={() => step(1)} />
          </>
        )}
      </div>
      <div
        ref={stage}
        className={`tm-media-stage tm-scroll ${kind === "image" ? "is-checker" : ""} ${zoom === "fit" ? "is-fit" : ""}`}
        onWheel={(e) => {
          if (kind !== "image" || !(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          step(e.deltaY < 0 ? 1 : -1);
        }}
      >
        {error ? (
          <div className="tm-panel-empty">
            <Codicon name="warning" /> {error}
          </div>
        ) : !src ? (
          <SkeletonCard />
        ) : kind === "image" ? (
          <img
            src={src.url}
            alt={path}
            draggable={false}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={zoom === "fit" ? undefined : { width: size ? size.w * zoom : undefined, maxWidth: "none", maxHeight: "none", imageRendering: zoom >= 3 ? "pixelated" : undefined }}
            onClick={() => setZoom(zoom === "fit" ? 1 : "fit")}
          />
        ) : kind === "video" ? (
          <video src={src.url} controls />
        ) : (
          <audio src={src.url} controls />
        )}
      </div>
      {src && (
        <div className="tm-media-footer">
          {size && kind === "image" && <span>{`${size.w} × ${size.h}`}</span>}
          <span>{formatBytes(src.bytes)}</span>
          <span>{mime}</span>
        </div>
      )}
    </div>
  );
}
