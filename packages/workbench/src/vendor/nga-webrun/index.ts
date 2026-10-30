// VENDORED from nga_central_mis/packages/webrun/src/index.ts -- do not edit.
// Re-sync with: node nga_central_mis/packages/webrun/sync.mjs <this dir>
// sha256:3a2a1dddd7220d0fb1f736d8707d902cdfbe59811221d9277bc0d0ca31e008be
/**
 * nga-webrun: how the NGA apps run web code and PHP pages the way the MIS Code Playground does,
 * shared by the playground, Task Mentor (grading, code workspace) and TMCode. Dependency-free and
 * framework-agnostic: each app vendors an exact copy with
 * `node nga_central_mis/packages/webrun/sync.mjs <dir>` and never edits it.
 *
 * PHP pages: run PHP_ROUTER as the entry, next to the project's files, with
 * phpRequestInput(script, method, query, fields) on stdin (a php/single run on the code runner);
 * what it prints is the page. buildPageDocument() turns that output (or an .html file) into a
 * sandboxed-frame document whose links and forms come back through listenToRun's onNav, for the
 * app to serve the next page the same way.
 */

/** A file of a project (path relative to the project root). */
export interface PlayFile {
  path: string;
  content: string;
}

/** Files plus the main one: what runs, or the first page shown. */
export interface PlayProject {
  files: PlayFile[];
  entry: string;
}

/**
 * Web code runs in a sandboxed frame on this page: `sandbox="allow-scripts allow-modals …"`
 * without allow-same-origin, so it gets an opaque origin — no MIS cookies, storage or
 * DOM, and it can't navigate the page. Its console (and errors) come back by postMessage,
 * tagged with the run's id so an older run's late output is ignored.
 *
 * Projects of several files are linked here the way a browser would link them from a web
 * server: a page's <link rel="stylesheet"> and <script src> load the project's files, a link
 * to another page opens that page, a form posting to a .php file runs it on the code runner
 * (see PHP_ROUTER), and ES modules import each other (plus "react" for React projects) —
 * each module becomes a blob URL inside the frame with its relative imports rewritten.
 */

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "result";
  text: string;
}

/** A link followed or a form sent inside the preview, for the playground to serve. */
export interface NavRequest {
  href: string;
  method: "GET" | "POST";
  fields: [string, string][];
}

const REACT = "https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js";
const REACT_DOM = "https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js";
const BABEL = "https://cdn.jsdelivr.net/npm/@babel/standalone@7.26.10/babel.min.js";

/** `</script>` inside user code would end our script tag early. */
const scriptSafe = (code: string) => code.replace(/<\/(script)/gi, "<\\/$1");
/** JSON that is safe inside a <script> element. */
const jsonInScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** Console capture, prompt() fed from the Input panel, errors — and, for pages, link/form hand-off. */
function bridge(runId: string, stdin: string, page: string | null): string {
  return `<script>(function(){
var RUN=${JSON.stringify(runId)};var lines=${JSON.stringify(stdin ? stdin.replace(/\n$/, "").split("\n") : [])};var at=0;var PAGE=${JSON.stringify(page)};
function fmt(v,d){d=d||0;try{if(typeof v==="string")return d?JSON.stringify(v):v;if(typeof v==="function")return "[Function "+(v.name||"anonymous")+"]";if(v instanceof Error)return v.name+": "+v.message;if(typeof v==="undefined")return "undefined";if(typeof v==="symbol"||typeof v==="bigint")return String(v);if(v&&typeof v==="object"){if(d>3)return Array.isArray(v)?"[Array]":"[Object]";if(Array.isArray(v))return "["+v.map(function(x){return fmt(x,d+1)}).join(", ")+"]";if(typeof Node!=="undefined"&&v instanceof Node)return "<"+(v.nodeName||"node").toLowerCase()+">";var ks=Object.keys(v);return (v.constructor&&v.constructor.name&&v.constructor.name!=="Object"?v.constructor.name+" ":"")+"{ "+ks.map(function(k){return k+": "+fmt(v[k],d+1)}).join(", ")+(ks.length?" ":"")+"}";}return String(v);}catch(e){return String(v);}}
function post(m){m.__ngaPlayground=RUN;try{parent.postMessage(m,"*");}catch(e){}}
function send(level,args){post({level:level,text:Array.prototype.map.call(args,function(a){return fmt(a,0)}).join(" ")});}
["log","info","warn","error","debug"].forEach(function(k){var o=console[k];console[k]=function(){send(k==="debug"?"log":k,arguments);try{o&&o.apply(console,arguments);}catch(e){}};});
console.table=function(d){send("log",[d]);};
var nativePrompt=window.prompt,nativeConfirm=window.confirm,nativeAlert=window.alert;
function ask(fn,args,fallback){try{return fn.apply(window,args);}catch(e){return fallback;}}
// prompt(): the Input panel's answers first, then the browser's own input box — the program waits for it.
window.prompt=function(q,d){var asked=q==null?"":String(q);var v=at<lines.length?lines[at++]:ask(nativePrompt,[asked,d==null?"":String(d)],null);send("info",[(asked?asked+" ":"")+"\\u21b3 "+(v===null?"(cancelled)":v)]);return v;};
window.alert=function(m){send("info",["alert: "+fmt(m)]);ask(nativeAlert,[m==null?"":String(m)],undefined);};
window.confirm=function(m){var ok=ask(nativeConfirm,[m==null?"":String(m)],true)!==false;send("info",["confirm: "+fmt(m)+" \\u21b3 "+(ok?"OK":"Cancel")]);return ok;};
window.addEventListener("error",function(e){send("error",[(e.error&&e.error.name?e.error.name+": ":"")+(e.message||"Error").replace(/^Uncaught /,"")+(e.lineno?" (line "+e.lineno+")":"")]);});
window.addEventListener("unhandledrejection",function(e){send("error",["Unhandled promise rejection: "+fmt(e.reason)]);});
window.__ngaDone=function(){setTimeout(function(){post({done:true});},0);};
if(PAGE!==null){
// Links and forms open the project's pages here. Listened to last (window, bubbling), so a page
// that handles them itself (preventDefault in its own listener, onsubmit="return false") keeps them.
var external=function(h){return !h||/^[a-z][a-z0-9+.-]*:/i.test(h)||h.indexOf("//")===0;};
window.addEventListener("click",function(e){if(e.defaultPrevented)return;var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href");if(!h||h.charAt(0)==="#"||a.target==="_blank"&&external(h))return;if(external(h)){e.preventDefault();send("info",["Links to other sites don't open from the preview: "+h]);return;}e.preventDefault();post({nav:{href:h,method:"GET",fields:[]}});});
window.addEventListener("submit",function(e){if(e.defaultPrevented)return;var f=e.target;if(!f||f.tagName!=="FORM")return;var act=f.getAttribute("action")||"";if(external(act)&&act)return;e.preventDefault();var fd;try{fd=new FormData(f,e.submitter||undefined);}catch(x){fd=new FormData(f);}var fields=[];fd.forEach(function(v,k){if(typeof v==="string")fields.push([k,v]);});var m=(f.getAttribute("method")||"GET").toUpperCase()==="POST"?"POST":"GET";post({nav:{href:act||PAGE,method:m,fields:fields}});});
}
})();</script>`;
}

const REACT_NAMES =
  "useState,useEffect,useRef,useMemo,useCallback,useReducer,useContext,useLayoutEffect,useId,useTransition,useDeferredValue,createContext,createElement,cloneElement,Fragment,StrictMode,Suspense,Children,memo,forwardRef,lazy";

/**
 * The module loader, run inside the frame: each project module becomes a blob URL with its
 * relative imports pointing at the other modules' blob URLs (built depth-first), "react" /
 * "react-dom" point at the UMD globals, .css imports add a <style>, .json imports a value.
 * JSX and TypeScript go through Babel first when it is loaded.
 */
function moduleLoader(files: PlayFile[], entries: string[], react: boolean): string {
  const map: Record<string, string> = {};
  for (const f of files) map[f.path] = f.content;
  return `<script>(function(){
var FILES=${jsonInScript(map)};var ENTRIES=${jsonInScript(entries)};var REACT=${react};
var urls={},building={},shims={};
function blob(src){return URL.createObjectURL(new Blob([src],{type:"text/javascript"}));}
function dirOf(p){var i=p.lastIndexOf("/");return i<0?"":p.slice(0,i+1);}
function resolve(from,spec){var raw=(spec.charAt(0)==="/"?spec.slice(1):dirOf(from)+spec).split("?")[0].split("/");var out=[];raw.forEach(function(s){if(s===""||s===".")return;if(s==="..")out.pop();else out.push(s);});var p=out.join("/");if(FILES[p]!=null)return p;var ex=[".js",".jsx",".ts",".tsx",".mjs","/index.js","/index.jsx","/index.ts"];for(var i=0;i<ex.length;i++)if(FILES[p+ex[i]]!=null)return p+ex[i];return null;}
function shim(name){if(shims[name])return shims[name];var src=null;if(name==="react"&&window.React)src="const R=window.React;export default R;export const {${REACT_NAMES}}=R;";else if((name==="react-dom"||name==="react-dom/client")&&window.ReactDOM)src="const D=window.ReactDOM;export default D;export const {createRoot,hydrateRoot,render,createPortal,flushSync}=D;";if(src===null)return null;return shims[name]=blob(src);}
function transform(path,src){var ext=(path.split(".").pop()||"").toLowerCase();if(ext==="json")return "export default "+src+";";if(ext==="css")return "const s=document.createElement('style');s.setAttribute('data-file',"+JSON.stringify(path)+");s.textContent="+JSON.stringify(src)+";document.head.appendChild(s);export default s;";var jsx=REACT||ext==="jsx"||ext==="tsx";var ts=ext==="ts"||ext==="tsx";if(jsx||ts){if(!window.Babel)throw new Error("The JSX/TypeScript compiler could not be loaded (check the internet connection).");var presets=[];if(jsx)presets.push(["react",{runtime:"classic"}]);if(ts)presets.push(["typescript",{isTSX:ext==="tsx",allExtensions:true}]);src=Babel.transform(src,{presets:presets,filename:path,sourceType:"module"}).code;}if(REACT&&!/from\\s*['"]react['"]/.test(src))src="const {${REACT_NAMES}}=window.React;\\n"+src;return src;}
var RE=/(\\bimport\\s*(?:[\\w$*{}\\s,]+?\\s*from\\s*)?|\\bexport\\s*(?:\\*(?:\\s*as\\s+[\\w$]+)?|\\{[^}]*\\})\\s*from\\s*|\\bimport\\s*\\(\\s*)(['"])([^'"\\n]+)\\2/g;
function rewrite(path,src){return src.replace(RE,function(m,pre,q,spec){var u=null;if(spec.charAt(0)==="."||spec.charAt(0)==="/"){var r=resolve(path,spec);if(!r){console.error("Can't find '"+spec+"' (imported by "+path+")");return m;}u=urlOf(r);}else{u=shim(spec);if(!u){console.error("'"+spec+"' isn't available in the playground (only your own files"+(REACT?", react and react-dom":"")+").");return m;}}return pre+q+u+q;});}
function urlOf(p){if(urls[p])return urls[p];if(building[p]){console.warn("Circular import of "+p+": it is skipped.");return blob("");}building[p]=1;var src=FILES[p];try{src=transform(p,src);}catch(e){console.error(p+": "+String(e&&e.message||e).split("\\n").slice(0,6).join("\\n"));src="";}src=rewrite(p,src);return urls[p]=blob(src+"\\n//# sourceURL="+p);}
window.__ngaModules=async function(after){for(var i=0;i<ENTRIES.length;i++){try{var mod=await import(urlOf(ENTRIES[i]));if(after)after(mod,ENTRIES[i]);}catch(e){console.error((e&&e.name?e.name+": ":"")+(e&&e.message||e));}}window.__ngaDone();};
})();</script>`;
}

const BASE_STYLE = `<style>html{color-scheme:light}body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;margin:16px;line-height:1.5;color:#1f2328}</style>`;
const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`;

/** Sample page for a CSS-only snippet, so the rules have something to style. */
export const CSS_SAMPLE_HTML = `<h1>Heading</h1>
<p>A paragraph of text with a <a href="#">link</a> and <strong>bold words</strong>.</p>
<button class="btn">Button</button>
<div class="card">
    <h2>Card title</h2>
    <p>Some text inside a card.</p>
</div>
<ul>
    <li>First item</li>
    <li>Second item</li>
</ul>
`;

// ------------------------------------------------------------------ paths

const isExternal = (ref: string) => !ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || ref.startsWith("#");

/** A reference from a page/module to a project path ("css/site.css" from "pages/a.html" → "pages/css/site.css"). */
export function resolvePath(from: string, ref: string): { path: string; query: string } {
  const [beforeHash] = ref.split("#");
  const q = beforeHash.indexOf("?");
  const pathPart = q < 0 ? beforeHash : beforeHash.slice(0, q);
  const query = q < 0 ? "" : beforeHash.slice(q + 1);
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  const parts = (pathPart.startsWith("/") ? pathPart.slice(1) : dir + pathPart).split("/");
  const out: string[] = [];
  for (const s of parts) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return { path: out.join("/"), query };
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((x) => x !== undefined) ?? null;

export interface ComposedPage {
  html: string;
  /** Module scripts to load (project paths, incl. inline ones turned into files). */
  modules: string[];
  /** Inline module scripts, as files next to the page. */
  extraFiles: PlayFile[];
  /** References to project files that don't exist (shown as warnings). */
  missing: string[];
}

/** A page with its linked CSS and classic scripts inlined; module scripts listed for the loader. */
export function composePage(html: string, pagePath: string, files: PlayFile[]): ComposedPage {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const modules: string[] = [];
  const extraFiles: PlayFile[] = [];
  const missing: string[] = [];
  let inline = 0;

  let out = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    const href = attr(tag, "href");
    if (!rel.split(/\s+/).includes("stylesheet") || !href || isExternal(href)) return tag;
    const { path } = resolvePath(pagePath, href);
    const css = byPath.get(path);
    if (css === undefined) {
      missing.push(href);
      return tag;
    }
    return `<style data-file="${path}">${css.replace(/<\/style/gi, "<\\/style")}</style>`;
  });

  out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (whole, attrs: string, body: string) => {
    const open = `<script${attrs}>`;
    const type = (attr(open, "type") ?? "").toLowerCase();
    const src = attr(open, "src");
    if (type === "module") {
      if (src) {
        if (isExternal(src)) return whole;
        const { path } = resolvePath(pagePath, src);
        if (!byPath.has(path)) {
          missing.push(src);
          return "";
        }
        modules.push(path);
        return "";
      }
      const dir = pagePath.includes("/") ? pagePath.slice(0, pagePath.lastIndexOf("/") + 1) : "";
      const virtual = `${dir}_nga_inline_${++inline}.js`;
      extraFiles.push({ path: virtual, content: body });
      modules.push(virtual);
      return "";
    }
    if (!src || isExternal(src)) return whole;
    const { path } = resolvePath(pagePath, src);
    const js = byPath.get(path);
    if (js === undefined) {
      missing.push(src);
      return "";
    }
    return `<script data-file="${path}">${scriptSafe(js)}</script>`;
  });

  return { html: out, modules, extraFiles, missing };
}

/** Put our head bits (and a light base style for fragments) into a page or fragment. */
function wrapPage(html: string, headExtra: string, bodyEnd: string): string {
  const trimmed = html.trim();
  if (/<html[\s>]/i.test(trimmed) || /<body[\s>]/i.test(trimmed) || /<head[\s>]/i.test(trimmed)) {
    let doc = trimmed;
    if (/<head[^>]*>/i.test(doc)) doc = doc.replace(/<head([^>]*)>/i, `<head$1>${HEAD}${headExtra}`);
    else if (/<html[^>]*>/i.test(doc)) doc = doc.replace(/<html([^>]*)>/i, `<html$1><head>${HEAD}${headExtra}</head>`);
    else doc = `${HEAD}${headExtra}${doc}`;
    return /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${bodyEnd}</body>`) : doc + bodyEnd;
  }
  return `<!doctype html><html><head>${HEAD}${BASE_STYLE}${headExtra}</head><body>${trimmed}${bodyEnd}</body></html>`;
}

/**
 * A page of a web project (or a page a .php file printed): linked files inlined, links and
 * forms handed to the playground (`page` = its project path), module scripts loaded.
 */
export function buildPageDocument(html: string, pagePath: string, files: PlayFile[], runId: string, stdin: string): { doc: string; missing: string[] } {
  const page = composePage(html, pagePath, files);
  const all = [...files, ...page.extraFiles];
  const loader = page.modules.length ? moduleLoader(all, page.modules, false) : "";
  const run = page.modules.length ? `<script>window.__ngaModules()</script>` : `<script>window.addEventListener("load",function(){window.__ngaDone()})</script>`;
  return { doc: wrapPage(page.html, bridge(runId, stdin, pagePath) + loader, run), missing: page.missing };
}

const usesModules = (src: string) => /^\s*(import\s[\s\S]*?from\s*['"]|import\s*['"]|export\s)/m.test(src);

/** Browser JavaScript: the main file as a classic script, or as a module when it imports/exports. */
export function buildScriptDocument(project: PlayProject, runId: string, stdin: string): string {
  const main = project.files.find((f) => f.path === project.entry)?.content ?? "";
  if (usesModules(main)) {
    return `<!doctype html><html><head>${HEAD}${bridge(runId, stdin, null)}${moduleLoader(project.files, [project.entry], false)}</head><body><script>window.__ngaModules()</script></body></html>`;
  }
  return `<!doctype html><html><head>${HEAD}${bridge(runId, stdin, null)}</head><body><script>
try{${"\n"}${scriptSafe(main)}${"\n"}}catch(e){console.error((e&&e.name?e.name+": ":"")+(e&&e.message||e));}
</script><script>__ngaDone()</script></body></html>`;
}

/** React: every file a module (JSX through Babel), the main component rendered into #root. */
export function buildReactDocument(project: PlayProject, runId: string): string {
  const files = project.files.map((f) => {
    if (f.path !== project.entry) return f;
    let src = f.content;
    // Lesson snippets: `function App() {…}` with no export — render it all the same.
    if (!/\bexport\s+default\b/.test(src) && /(function|class|const|let|var)\s+App\b/.test(src)) src += "\nexport default App;\n";
    return { ...f, content: src };
  });
  const styles = project.files
    .filter((f) => /\.css$/i.test(f.path))
    .map((f) => `<style data-file="${f.path}">${f.content.replace(/<\/style/gi, "<\\/style")}</style>`)
    .join("");
  const entry = files.find((f) => f.path === project.entry)?.content ?? "";
  const rendersItself = /ReactDOM\.(createRoot|render)\s*\(|\bcreateRoot\s*\(/.test(entry);
  return `<!doctype html><html><head>${HEAD}${BASE_STYLE}${styles}${bridge(runId, "", null)}</head><body><div id="root"></div>
<script src="${REACT}"></script><script src="${REACT_DOM}"></script><script src="${BABEL}"></script>
${moduleLoader(files, [project.entry], true)}
<script>
if(!window.React||!window.Babel){console.error("React could not be loaded — check the internet connection.");window.__ngaDone();}
else window.__ngaModules(${
    rendersItself
      ? "null"
      : `function(mod){var C=mod&&(mod.default||mod.App);var root=document.getElementById("root");if(typeof C==="function"&&root&&!root.hasChildNodes()){ReactDOM.createRoot(root).render(React.createElement(C));}}`
  });
</script></body></html>`;
}

/** CSS on its own: the rules applied to a sample page. */
export function buildCssDocument(css: string, runId: string): string {
  return buildPageDocument(`<style>${css.replace(/<\/style/gi, "<\\/style")}</style>${CSS_SAMPLE_HTML}`, "index.html", [], runId, "").doc;
}

// ------------------------------------------------------------------ PHP pages

/**
 * Runs one PHP page the way a web server would, on the code runner's PHP CLI: the request
 * comes in on stdin (method, script, GET and POST fields) and fills $_GET, $_POST, $_REQUEST
 * and $_SERVER before the script runs in its own folder; what it prints is the page.
 */
export const PHP_ROUTER_PATH = "_nga_router.php";
export const PHP_ROUTER = `<?php
// Code Playground: one web request, emulated for the PHP CLI (the request arrives on stdin).
$__req = json_decode(stream_get_contents(STDIN), true) ?: [];
$_GET = is_array($__req['get'] ?? null) ? $__req['get'] : [];
$_POST = is_array($__req['post'] ?? null) ? $__req['post'] : [];
$_REQUEST = array_merge($_GET, $_POST);
$__script = (string) ($__req['script'] ?? 'index.php');
$_SERVER['REQUEST_METHOD'] = ($__req['method'] ?? 'GET') === 'POST' ? 'POST' : 'GET';
$_SERVER['SCRIPT_NAME'] = $_SERVER['PHP_SELF'] = '/' . $__script;
$_SERVER['QUERY_STRING'] = http_build_query($_GET);
$_SERVER['REQUEST_URI'] = '/' . $__script . ($_SERVER['QUERY_STRING'] !== '' ? '?' . $_SERVER['QUERY_STRING'] : '');
$_SERVER['HTTP_HOST'] = $_SERVER['SERVER_NAME'] = 'playground.local';
unset($__req);
chdir(dirname(__DIR__ . '/' . $__script));
require __DIR__ . '/' . $__script;
`;

/** Form fields as PHP builds its arrays: "tags[]" collects a list, "a[b]" a keyed entry. */
export function phpFields(pairs: [string, string][]): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const [name, value] of pairs) {
    const m = name.match(/^([^[\]]+)((?:\[[^\]]*\])+)$/);
    if (!m) {
      out[name] = value;
      continue;
    }
    const keys = [...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1]);
    let node = (out[m[1]] = typeof out[m[1]] === "object" && out[m[1]] !== null ? out[m[1]] : {});
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      const key = k === "" ? String(Object.keys(node).length) : k;
      if (last) node[key] = value;
      else node = node[key] = typeof node[key] === "object" && node[key] !== null ? node[key] : {};
    });
  }
  return out;
}

const parseQuery = (q: string): [string, string][] =>
  q
    ? q.split("&").filter(Boolean).map((kv) => {
        const [k, v = ""] = kv.split("=");
        const dec = (s: string) => {
          try {
            return decodeURIComponent(s.replace(/\+/g, " "));
          } catch {
            return s;
          }
        };
        return [dec(k), dec(v)] as [string, string];
      })
    : [];

/** The stdin for PHP_ROUTER: the request to `script` (a project path) with its fields. */
export function phpRequestInput(script: string, method: "GET" | "POST", query: string, fields: [string, string][]): string {
  const get = phpFields(method === "GET" ? [...parseQuery(query), ...fields] : parseQuery(query));
  const post = method === "POST" ? phpFields(fields) : {};
  return JSON.stringify({ script, method, get, post });
}

/** Whether a program's output is a web page (PHP printing HTML): then it is shown in the Preview. */
export const looksLikeHtml = (s: string) => /^\s*(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(s) || /<(form|div|h1|h2|p|table|ul|section|main|nav)\b[^>]*>[\s\S]*<\/\1>/i.test(s);

// ------------------------------------------------------------------ messages

/** Listen for one run's console output, links/forms followed in its page, and its end. */
export function listenToRun(runId: string, onEntry: (e: ConsoleEntry) => void, onDone: () => void, onNav?: (nav: NavRequest) => void): () => void {
  const handler = (ev: MessageEvent) => {
    const d = ev.data;
    if (!d || typeof d !== "object" || d.__ngaPlayground !== runId) return;
    if (d.done) return onDone();
    if (d.nav && typeof d.nav === "object") {
      const n = d.nav;
      const fields = Array.isArray(n.fields) ? n.fields.filter((p: unknown) => Array.isArray(p) && p.length === 2).map((p: unknown[]) => [String(p[0]).slice(0, 200), String(p[1]).slice(0, 10000)] as [string, string]).slice(0, 200) : [];
      onNav?.({ href: String(n.href ?? "").slice(0, 500), method: n.method === "POST" ? "POST" : "GET", fields });
      return;
    }
    const level = ["log", "info", "warn", "error"].includes(d.level) ? d.level : "log";
    onEntry({ level, text: String(d.text ?? "").slice(0, 20000) });
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

export const newRunId = () => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
