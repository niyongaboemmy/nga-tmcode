import { parseManifest } from "../extensions/manifest";
import { toBase64, unpackVsix } from "../extensions/vsix";
import type { ExtensionHost, StoredExtension } from "./types";

/** Only the Open VSX registry is reachable (the desktop enforces the same in Rust). */
export const GALLERY_ORIGIN = "https://open-vsx.org/";

export function assertGalleryUrl(url: string) {
  if (!url.startsWith(GALLERY_ORIGIN)) throw new Error(`Not an Open VSX URL: ${url}`);
}

const SESSION_KEY = "tmcode:extensions";

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

type Installed = Map<string, { record: StoredExtension; files: Map<string, Uint8Array> }>;

/** Installed extensions survive reloads of this tab (sessionStorage); too-large ones live for this page only. */
function restore(): Installed {
  const out: Installed = new Map();
  try {
    const raw = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "{}") as Record<string, { record: StoredExtension; files: Record<string, string> }>;
    for (const [id, e] of Object.entries(raw)) out.set(id, { record: e.record, files: new Map(Object.entries(e.files).map(([p, b]) => [p, fromBase64(b)])) });
  } catch {
    /* unavailable or corrupt: start empty */
  }
  return out;
}

function save(installed: Installed) {
  try {
    const raw: Record<string, { record: StoredExtension; files: Record<string, string> }> = {};
    for (const [id, e] of installed) raw[id] = { record: e.record, files: Object.fromEntries([...e.files].map(([p, d]) => [p, toBase64(d)])) };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(raw));
  } catch {
    /* over quota: kept in memory only */
  }
}

/**
 * Extensions for the browser build (dev server, e2e, TMCode Web): the .vsix
 * is downloaded with fetch and unpacked in memory (kept for this tab's session).
 * Playwright mocks open-vsx.org, so e2e never reaches the real registry.
 */
export function createMemoryExtensionHost(): ExtensionHost {
  const installed = restore();
  const decoder = new TextDecoder();

  async function get(url: string) {
    assertGalleryUrl(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open VSX answered ${res.status} for ${url}`);
    return res;
  }

  return {
    async fetch(url, as) {
      const res = await get(url);
      return as === "text" ? res.text() : toBase64(new Uint8Array(await res.arrayBuffer()));
    },
    async list() {
      return [...installed.values()].map((e) => e.record);
    },
    async install(id, downloadUrl) {
      const res = await get(downloadUrl);
      const files = await unpackVsix(new Uint8Array(await res.arrayBuffer()));
      const manifest = decoder.decode(files.get("package.json")!);
      const parsed = parseManifest(manifest);
      if (parsed.id !== id.toLowerCase()) throw new Error(`The downloaded extension is ${parsed.id}, not ${id}`);
      const nls = files.get("package.nls.json");
      const record: StoredExtension = { id: parsed.id, version: parsed.version, manifest, ...(nls ? { nls: decoder.decode(nls) } : {}) };
      installed.set(parsed.id, { record, files });
      save(installed);
      return record;
    },
    async uninstall(id) {
      installed.delete(id.toLowerCase());
      save(installed);
    },
    async readFile(id, path, as) {
      const data = installed.get(id.toLowerCase())?.files.get(path);
      if (!data) throw new Error(`${id} has no file ${path}`);
      return as === "text" ? decoder.decode(data) : toBase64(data);
    },
  };
}
