import { useEffect, useMemo, useRef, useState } from "react";
import { getPlatform } from "../../state/store";
import { SkeletonLines } from "../../widgets/Skeleton";

/**
 * A read-only hex view of a binary file: offset, 16 bytes in hex, and their
 * printable characters. Only the rows on screen are drawn, so large files
 * scroll smoothly.
 */

const ROW = 16;
const ROW_HEIGHT = 20;
/** Bigger files would hold too much in memory for a viewer. */
export const MAX_HEX_BYTES = 16 * 1024 * 1024;

export function hexRow(bytes: Uint8Array, offset: number): { offset: string; hex: string; ascii: string } {
  const slice = bytes.subarray(offset, offset + ROW);
  const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0"));
  // A gap after the 8th byte, as hex editors show it.
  const padded = [...hex, ...Array<string>(ROW - hex.length).fill("  ")];
  return {
    offset: offset.toString(16).padStart(8, "0"),
    hex: `${padded.slice(0, 8).join(" ")}  ${padded.slice(8).join(" ")}`,
    ascii: Array.from(slice, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join(""),
  };
}

export async function readBytes(path: string): Promise<Uint8Array> {
  const fs = getPlatform().fs;
  if (fs.readBase64) {
    const b64 = await fs.readBase64(path);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // The browser build keeps files as text: each character is one byte.
  const text = await (fs.readFileAnyway ? fs.readFileAnyway(path) : fs.readFile(path));
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

export function HexView({ path }: { path: string }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setError(null);
    readBytes(path)
      .then((b) => {
        if (cancelled) return;
        if (b.length > MAX_HEX_BYTES) setError(`This file is larger than ${MAX_HEX_BYTES / 1024 / 1024} MB, too large for the hex viewer.`);
        else setBytes(b);
      })
      .catch((e) => !cancelled && setError(String((e as Error)?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [bytes]);

  const rows = bytes ? Math.ceil(bytes.length / ROW) : 0;
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 5);
  const last = Math.min(rows, Math.ceil((top + height) / ROW_HEIGHT) + 5);
  const shown = useMemo(() => (bytes ? Array.from({ length: Math.max(0, last - first) }, (_, i) => hexRow(bytes, (first + i) * ROW)) : []), [bytes, first, last]);

  if (error) return <div className="tm-hex-error" role="alert">{error}</div>;
  if (!bytes) return <SkeletonLines lines={10} label="Reading the file" />;
  return (
    <div className="tm-hex" data-testid="hex-view">
      <div className="tm-hex-head">
        <span>{bytes.length.toLocaleString()} bytes · read-only</span>
      </div>
      <div ref={box} className="tm-hex-body tm-scroll" onScroll={(e) => setTop(e.currentTarget.scrollTop)} role="table" aria-label={`Hex view of ${path}`}>
        <div style={{ height: rows * ROW_HEIGHT, position: "relative" }}>
          {shown.map((r, i) => (
            <div key={r.offset} className="tm-hex-row" role="row" style={{ top: (first + i) * ROW_HEIGHT, height: ROW_HEIGHT }}>
              <span className="tm-hex-offset">{r.offset}</span>
              <span className="tm-hex-bytes">{r.hex}</span>
              <span className="tm-hex-ascii">{r.ascii}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
