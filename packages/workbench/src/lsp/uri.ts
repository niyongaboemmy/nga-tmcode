/**
 * Workspace-relative paths (TMCode's documents) ↔ the `file:` URIs language
 * servers use. `root` is the folder's absolute path ("/Users/a/proj",
 * "C:\\Users\\a\\proj").
 */

const encodeSeg = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The absolute path as "/c:/Users/a" or "/Users/a" (forward slashes, leading slash). */
function normalRoot(root: string) {
  let r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:/.test(r)) r = `/${r[0].toLowerCase()}${r.slice(1)}`;
  // The browser build's folders ("memory://practice-project") become a plain path.
  else if (!r.startsWith("/")) r = `/${r.replace(/^([a-z][a-z0-9+.-]*):\/+/i, "$1/")}`;
  return r;
}

export function rootUri(root: string) {
  return `file://${normalRoot(root)
    .split("/")
    .map((seg, i) => (i === 1 && /^[a-z]:$/.test(seg) ? `${seg[0]}%3A` : encodeSeg(seg)))
    .join("/")}`;
}

export function fileUri(root: string, path: string) {
  const base = rootUri(root);
  return path ? `${base}/${path.split("/").map(encodeSeg).join("/")}` : base;
}

/** The workspace-relative path of a server URI, or null when it is outside the folder (a stub, a library). */
export function pathOfFileUri(root: string, uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let p: string;
  try {
    p = decodeURIComponent(uri.slice("file://".length).replace(/^[^/]*/, ""));
  } catch {
    return null;
  }
  if (/^\/[a-zA-Z]:/.test(p)) p = `/${p[1].toLowerCase()}${p.slice(2)}`;
  const r = normalRoot(root);
  const windows = /^\/[a-z]:/.test(r);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(p, r)) return "";
  if (p.length > r.length && same(p.slice(0, r.length), r) && p[r.length] === "/") return p.slice(r.length + 1);
  return null;
}
