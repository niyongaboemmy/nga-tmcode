import { normalizeExtensionPath } from "./manifest";

/**
 * A .vsix is a zip whose `extension/` folder is the extension. This reader is
 * for the browser build (the desktop unpacks in Rust): stored and deflated
 * entries, inflated with the platform's DecompressionStream, no dependency.
 */

const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
  const reader = input.pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Files under `extension/` (paths relative to it). Entries that would escape
 * the folder ("..", absolute) are skipped.
 */
export async function unpackVsix(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a .vsix (zip) file");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) throw new Error("The .vsix has too many files");
  const out = new Map<string, Uint8Array>();
  let total = 0;
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt .vsix (central directory)");
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.startsWith("extension/") || name.endsWith("/")) continue;
    const rel = normalizeExtensionPath(name.slice("extension/".length));
    if (!rel) continue;
    total += size;
    if (total > MAX_TOTAL) throw new Error("The .vsix is too large");
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error("Corrupt .vsix (local header)");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compSize);
    if (method === 0) out.set(rel, data.slice());
    else if (method === 8) out.set(rel, await inflateRaw(data));
    else throw new Error(`Unsupported compression in ${name}`);
  }
  if (!out.has("package.json")) throw new Error("The .vsix has no extension/package.json");
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
