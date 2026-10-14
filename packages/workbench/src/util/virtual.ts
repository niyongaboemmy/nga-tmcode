/**
 * Documents served by extensions (content and file system providers): their path in the
 * workbench is their URI ("_claude_fs_right:/app.js", "blackbox-diff:app.js?…"). The
 * extension host bridge (exthost/virtualDocs.ts) fills `virtualIO`; this module has no
 * imports so the document layer can use it without cycles.
 */

export interface VirtualIO {
  /** Schemes extensions serve right now. */
  schemes: Set<string>;
  read(path: string): Promise<{ text: string; readonly: boolean }>;
  write(path: string, text: string): Promise<boolean>;
}

export const virtualIO: VirtualIO = {
  schemes: new Set(),
  read: async () => {
    throw new Error("No extension serves this document.");
  },
  write: async () => false,
};

/** Read-only virtual documents (content providers, read-only file systems). */
export const readonlyVirtual = new Set<string>();

export function schemeOf(path: string): string | null {
  const m = /^([a-zA-Z][\w+.-]*):/.exec(path);
  return m && m[1].length > 1 ? m[1] : null;
}

export function isVirtualPath(path: string): boolean {
  const s = schemeOf(path);
  return !!s && s !== "untitled";
}

/** The name a tab shows for a virtual document: the last segment of its URI path. */
export function virtualName(path: string): string {
  const rest = path.slice(path.indexOf(":") + 1).replace(/[?#].*$/, "");
  const seg = decodeURIComponent(rest.split("/").filter(Boolean).pop() ?? rest);
  return seg || path;
}
