import { getPlatform } from "../../state/store";

/**
 * The schema diagram as a file (SqlDiagram.tsx): its SVG drawn on a canvas for PNG, that picture in a one-page PDF
 * (a JPEG, which PDF embeds as it is), or the SVG itself. Saved with the desktop's Save dialog (Platform.saveFileAs),
 * or downloaded in the browser build.
 */

/** Canvas limits: WebKit refuses canvases over about 16.7 million pixels. */
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 16_000;

/** How much to scale a w×h drawing for export: 2× for sharpness, less when that would pass the canvas limits. */
export function exportScale(w: number, h: number, wanted = 2): number {
  return Math.min(wanted, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)), MAX_SIDE / Math.max(1, w), MAX_SIDE / Math.max(1, h));
}

/** Draws an SVG document (with its own width/height) on a canvas `scale` times larger, over `background`. */
export async function svgToCanvas(svg: string, w: number, h: number, scale: number, background: string): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.decoding = "async";
  const loaded = new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("The diagram couldn't be drawn as an image."));
  });
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This diagram is too big to export as a picture.");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function canvasBytes(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg", quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, type, quality));
  if (!blob) throw new Error("This diagram is too big to export as a picture.");
  return new Uint8Array(await blob.arrayBuffer());
}

const ascii = (s: string) => new TextEncoder().encode(s);

/** PDF text string: ASCII, with ( ) \ escaped. */
const pdfString = (s: string) => `(${s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, (c) => `\\${c}`)})`;

/**
 * A one-page PDF showing a JPEG: the page is `widthPt` × `heightPt` points (PDF caps a page side at 14 400),
 * the image `pxW` × `pxH` pixels stretched over it.
 */
export function pdfWithJpeg(jpeg: Uint8Array, pxW: number, pxH: number, widthPt: number, heightPt: number, title = "Diagram"): Uint8Array {
  const k = Math.min(1, 14_400 / Math.max(widthPt, heightPt));
  const W = +(widthPt * k).toFixed(2);
  const H = +(heightPt * k).toFixed(2);
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
  const objects: (string | Uint8Array)[][] = [
    ["<< /Type /Catalog /Pages 2 0 R >>"],
    ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`],
    [`<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream"],
    [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`],
    [`<< /Title ${pdfString(title)} /Producer (TMCode) >>`],
  ];
  const parts: Uint8Array[] = [];
  let size = 0;
  const push = (p: string | Uint8Array) => {
    const b = typeof p === "string" ? ascii(p) : p;
    parts.push(b);
    size += b.length;
  };
  // The binary comment line tells readers the file holds binary data.
  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(size);
    push(`${i + 1} 0 obj\n`);
    obj.forEach(push);
    push("\nendobj\n");
  });
  const xref = size;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const FILTERS: Record<string, { name: string; mime: string }> = {
  png: { name: "PNG Image", mime: "image/png" },
  pdf: { name: "PDF Document", mime: "application/pdf" },
  svg: { name: "SVG Image", mime: "image/svg+xml" },
};

/** Saves `bytes` where the user chooses (desktop) or as a download (browser). The saved path, "download", or null if cancelled. */
export async function saveExport(fileName: string, bytes: Uint8Array): Promise<string | null> {
  const ext = fileName.split(".").pop()!.toLowerCase();
  const f = FILTERS[ext] ?? { name: ext.toUpperCase(), mime: "application/octet-stream" };
  const platform = getPlatform();
  if (platform.saveFileAs) return platform.saveFileAs(fileName, bytes, { name: f.name, extensions: [ext] });
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: f.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return "download";
}
