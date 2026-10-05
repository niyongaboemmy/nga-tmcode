/** Workspace paths are "/"-separated, relative, with no leading slash ("" is the root). */

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function extname(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** True when `path` is `ancestor` itself or inside it. */
export function isWithin(path: string, ancestor: string): boolean {
  return ancestor === "" || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Rewrites `path` after `from` was renamed to `to` (no-op if unrelated). */
export function rebase(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return path;
}

/** Validates a single file/folder name typed by the user; returns an error message or null. */
export function validateName(name: string, siblings: string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A file or folder name must be provided.";
  // "/" is allowed: "src/new.ts" creates the folder too, as in VS Code.
  if (/[\\:*?"<>|]/.test(trimmed)) return "The name contains characters that are not allowed.";
  if (trimmed.split("/").some((p) => p === "." || p === ".." || !p)) return `The name '${trimmed}' is not valid.`;
  if (siblings.includes(trimmed.split("/")[0])) {
    return `A file or folder **${trimmed.split("/")[0]}** already exists at this location. Please choose a different name.`;
  }
  return null;
}
