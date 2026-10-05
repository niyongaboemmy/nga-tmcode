/**
 * Builds the document a preview shows (plan §9.1): the student's HTML plus a
 * console shim that reports console output, errors and link clicks to the
 * editor. Pure functions, unit-tested.
 */
import { dirname } from "../util/paths";

export const PREVIEW_MESSAGE_KEY = "__tmcodePreview";

/** Injected first in <head>: forwards console/errors and keeps navigation inside the preview. */
export const CONSOLE_SHIM = `(function(){
var K=${JSON.stringify(PREVIEW_MESSAGE_KEY)};
function str(a){try{if(typeof a==="string")return a;if(a instanceof Error)return a.stack||String(a);if(a===undefined)return "undefined";if(typeof a==="function")return String(a);return JSON.stringify(a);}catch(e){return String(a);}}
function send(m){try{m[K]=1;parent.postMessage(m,"*");}catch(e){}}
["log","info","warn","error","debug"].forEach(function(l){var o=console[l];console[l]=function(){send({kind:"console",level:l,text:[].slice.call(arguments).map(str).join(" ")});return o&&o.apply(console,arguments);};});
addEventListener("error",function(e){send({kind:"console",level:"error",text:"Uncaught "+(e.message||"error")+(e.lineno?" ("+String(e.filename||"").split("/").pop()+":"+e.lineno+")":"")});});
addEventListener("unhandledrejection",function(e){var r=e.reason;send({kind:"console",level:"error",text:"Uncaught (in promise) "+(r&&r.message||str(r))});});
document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;var h=a.getAttribute("href");if(!h||h.charAt(0)==="#")return;if(/^[a-z][a-z0-9+.-]*:/i.test(h)){e.preventDefault();send({kind:"external",href:h});return;}e.preventDefault();send({kind:"navigate",href:h});},true);
addEventListener("load",function(){send({kind:"loaded",title:document.title});});
})();`;

/** Inserts `snippet` as the first thing in <head> (or the document). */
export function injectIntoHead(html: string, snippet: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + snippet + html.slice(head.index + head[0].length);
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + `<head>${snippet}</head>` + html.slice(htmlTag.index + htmlTag[0].length);
  return snippet + html;
}

/** Appends `snippet` before </body> (or at the end). */
export function injectBeforeBodyEnd(html: string, snippet: string): string {
  const i = html.search(/<\/body\s*>/i);
  return i < 0 ? html + snippet : html.slice(0, i) + snippet + html.slice(i);
}

export function shimTag() {
  return `<script>${CONSOLE_SHIM}</script>`;
}

const isRelative = (url: string) => !!url && !/^([a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(url);

/** Resolves a URL used inside `fromFile` to a path relative to the preview root. */
export function resolveRelative(fromFile: string, url: string): string | null {
  const clean = url.split(/[?#]/)[0];
  if (!isRelative(clean)) return null;
  const base = clean.startsWith("/") ? [] : dirname(fromFile).split("/").filter(Boolean);
  for (const part of clean.replace(/^\//, "").split("/")) {
    if (part === "..") {
      if (!base.length) return null;
      base.pop();
    } else if (part && part !== ".") base.push(part);
  }
  return base.join("/");
}

const escapeScript = (code: string) => code.replace(/<\/script/gi, "<\\/script");
const escapeStyle = (css: string) => css.replace(/<\/style/gi, "<\\/style");

/**
 * Browser preview (no preview origin): inline relative stylesheets and
 * scripts so the page works from an iframe srcdoc. Missing files are left
 * as-is and reported.
 */
export async function inlineAssets(
  html: string,
  entry: string,
  read: (relPath: string) => Promise<string | null>,
): Promise<{ html: string; missing: string[] }> {
  const missing: string[] = [];
  const replaceAsync = async (re: RegExp, fn: (m: RegExpExecArray) => Promise<string>) => {
    let out = "";
    let last = 0;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      out += html.slice(last, m.index) + (await fn(m));
      last = m.index + m[0].length;
    }
    html = out + html.slice(last);
  };
  await replaceAsync(/<link\b[^>]*>/gi, async (m) => {
    const tag = m[0];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const path = href ? resolveRelative(entry, href) : null;
    if (!path) return tag;
    const css = await read(path);
    if (css === null) {
      missing.push(path);
      return tag;
    }
    return `<style data-source="${path}">\n${escapeStyle(css)}\n</style>`;
  });
  await replaceAsync(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, async (m) => {
    const path = resolveRelative(entry, m[2]);
    if (!path) return m[0];
    const js = await read(path);
    if (js === null) {
      missing.push(path);
      return m[0];
    }
    const attrs = `${m[1]} ${m[3]}`.replace(/\s+/g, " ").trim();
    return `<script${attrs ? ` ${attrs}` : ""} data-source="${path}">\n${escapeScript(js)}\n</script>`;
  });
  return { html, missing };
}

/** Finds the module entry a Vite-style index.html loads (e.g. "/src/main.jsx"). */
export function findModuleEntry(html: string): { src: string; tag: string } | null {
  const m = /<script\b[^>]*type\s*=\s*["']module["'][^>]*src\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/i.exec(html) ??
    /<script\b[^>]*src\s*=\s*["']([^"']+\.(?:jsx|tsx))["'][^>]*>\s*<\/script>/i.exec(html);
  return m ? { src: m[1], tag: m[0] } : null;
}

export { escapeScript, escapeStyle };
