import { escapeScript, escapeStyle, findModuleEntry, injectBeforeBodyEnd, resolveRelative } from "./compose";

export const errorPage = (title: string, lines: string[]) =>
  `<!doctype html><meta charset="utf-8"><body style="font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#1e1e1e;color:#f48771;padding:16px;margin:0">` +
  `<h3 style="font-family:system-ui;color:#fff;margin:0 0 12px">${title}</h3>` +
  lines.map((l) => `<pre style="white-space:pre-wrap;margin:0 0 8px">${l.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`).join("") +
  `</body>`;

/**
 * A React project's page: its index.html with the module entry replaced by
 * the esbuild bundle (or an error page listing the build errors).
 */
export async function composeReactPage(html: string, entry: string, read: (path: string) => Promise<string | null>): Promise<string> {
  const { bundleReact } = await import("./reactBundle");
  const me = findModuleEntry(html);
  const entryPath = (me && resolveRelative(entry, me.src)) || "src/main.jsx";
  if (me) html = html.replace(me.tag, "");
  const b = await bundleReact(entryPath, read);
  if (b.errors.length) return errorPage("Build failed", b.errors);
  return injectBeforeBodyEnd(html, `${b.css ? `<style>${escapeStyle(b.css)}</style>` : ""}<script type="module">${escapeScript(b.js)}</script>`);
}
