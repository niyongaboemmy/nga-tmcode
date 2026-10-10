/**
 * Markdown links for files dropped or pasted into a Markdown editor (VS
 * Code's markdown.editor.drop): a path relative to the Markdown file, images
 * as `![name](path)`. Workspace-relative paths with "/" separators. Pure.
 */

const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i;

/** `target` relative to the folder of `from` ("docs/a.md", "img/x.png" → "../img/x.png"). */
export function relativePath(from: string, target: string): string {
  const fromDir = from.split("/").slice(0, -1);
  const to = target.split("/");
  let i = 0;
  while (i < fromDir.length && i < to.length - 1 && fromDir[i] === to[i]) i++;
  const up = fromDir.length - i;
  return [...Array<string>(up).fill(".."), ...to.slice(i)].join("/") || ".";
}

/** Angle brackets keep spaces and parentheses in a path working, as VS Code does. */
function encodeTarget(p: string) {
  return /[\s()<>]/.test(p) ? `<${p.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : p;
}

export function markdownLinkFor(from: string, target: string): string {
  const rel = relativePath(from, target);
  const name = target.split("/").pop() ?? target;
  const label = name.replace(/[[\]]/g, "\\$&");
  return IMAGE.test(name) ? `![${label.replace(/\.[^.]+$/, "")}](${encodeTarget(rel)})` : `[${label}](${encodeTarget(rel)})`;
}

/** Links for several dropped files, one per line (VS Code separates them with spaces; lines read better). */
export function markdownLinksFor(from: string, targets: string[]): string {
  return targets.map((t) => markdownLinkFor(from, t)).join("\n");
}
