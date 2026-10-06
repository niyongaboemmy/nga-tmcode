import type { WebviewTheme } from "./themeVars";

/**
 * The script TMCode puts first in every webview page (before the extension's
 * own CSP <meta>, which only governs what follows it), as VS Code's webview
 * host does:
 * - `acquireVsCodeApi()` → { postMessage, getState, setState } (once per page);
 * - messages from the workbench arrive as plain `message` events whose `data`
 *   is what the extension posted (the envelope never reaches page scripts);
 * - the theme's `--vscode-*` variables on <html>, `vscode-dark|light|high-contrast`
 *   on <body>, and VS Code's default webview styles in a low-priority layer;
 * - link clicks (http, https, mailto, command:) go to the workbench;
 * - keyboard shortcuts with ⌘/Ctrl are forwarded so workbench keybindings work;
 * - an in-memory localStorage/sessionStorage (the page has an opaque origin).
 */

export interface PreludeConfig {
  state: unknown;
  theme: WebviewTheme;
}

const DEFAULT_STYLES = `@layer tmcode-webview-defaults {
html { scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }
body { background-color: transparent; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-weight: var(--vscode-font-weight); font-size: var(--vscode-font-size); margin: 0; padding: 0 20px; }
img, video { max-width: 100%; max-height: 100%; }
a, a code { color: var(--vscode-textLink-foreground); }
a:hover { color: var(--vscode-textLink-activeForeground); }
a:focus, input:focus, select:focus, textarea:focus { outline: 1px solid -webkit-focus-ring-color; outline-offset: -1px; }
code { font-family: var(--monaco-monospace-font); color: var(--vscode-textPreformat-foreground); background-color: var(--vscode-textPreformat-background); padding: 1px 3px; border-radius: 4px; }
pre code { padding: 0; }
blockquote { background: var(--vscode-textBlockQuote-background); border-color: var(--vscode-textBlockQuote-border); }
kbd { background-color: var(--vscode-keybindingLabel-background); color: var(--vscode-keybindingLabel-foreground); border: 1px solid var(--vscode-keybindingLabel-border); border-radius: 3px; padding: 1px 4px; font-size: 11px; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-corner { background-color: var(--vscode-editor-background); }
::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); }
::-webkit-scrollbar-thumb:hover { background-color: var(--vscode-scrollbarSlider-hoverBackground); }
::-webkit-scrollbar-thumb:active { background-color: var(--vscode-scrollbarSlider-activeBackground); }
}`;

const SCRIPT = `(function (cfg, defaultStyles) {
  "use strict";
  var host = window.parent;
  var post = function (m) { host.postMessage(Object.assign({ __tmwebview: 1 }, m), "*"); };
  // ArrayBuffers and typed arrays cross the (JSON) extension host link as {$$tmbuf: base64, t: type}.
  function encode(v, depth) {
    depth = depth || 0;
    if (v instanceof ArrayBuffer) return { $$tmbuf: b64(new Uint8Array(v)), t: "ArrayBuffer" };
    if (ArrayBuffer.isView(v)) return { $$tmbuf: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), t: v.constructor.name };
    if (depth > 64 || !v || typeof v !== "object" || typeof v.toJSON === "function") return v;
    if (Array.isArray(v)) return v.map(function (x) { return encode(x, depth + 1); });
    var out = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = encode(v[k], depth + 1);
    return out;
  }
  function decode(v, depth) {
    depth = depth || 0;
    if (depth > 64 || !v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(function (x) { return decode(x, depth + 1); });
    if (typeof v.$$tmbuf === "string" && typeof v.t === "string") {
      var s = atob(v.$$tmbuf), bytes = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
      if (v.t === "ArrayBuffer") return bytes.buffer;
      var Ctor = typeof window[v.t] === "function" ? window[v.t] : Uint8Array;
      return new Ctor(bytes.buffer);
    }
    var out = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = decode(v[k], depth + 1);
    return out;
  }
  function b64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  var state = cfg.state;
  var acquired = false;
  var api = Object.freeze({
    postMessage: function (message) { post({ type: "message", data: encode(message) }); },
    setState: function (s) { state = s; post({ type: "setState", data: s }); return s; },
    getState: function () { return state; },
  });
  Object.defineProperty(window, "acquireVsCodeApi", {
    value: function () {
      if (acquired) throw new Error("An instance of the VS Code API has already been acquired");
      acquired = true;
      return api;
    },
  });
  // Messages from the workbench: unwrap, and keep the envelope away from the page's listeners.
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== host || !d || d.__tmwebview !== 1) return;
    e.stopImmediatePropagation();
    if (d.type === "message") window.dispatchEvent(new MessageEvent("message", { data: decode(d.data) }));
    else if (d.type === "theme") applyTheme(d.theme);
  }, true);
  function applyTheme(t) {
    var root = document.documentElement;
    for (var k in t.vars) root.style.setProperty(k, t.vars[k]);
    root.style.colorScheme = t.colorScheme;
    var body = document.body;
    if (!body) return;
    body.classList.remove("vscode-dark", "vscode-light", "vscode-high-contrast");
    body.classList.add(t.kind);
    body.setAttribute("data-vscode-theme-kind", t.kind);
    body.setAttribute("data-vscode-theme-id", t.themeId);
  }
  applyTheme(cfg.theme);
  document.addEventListener("DOMContentLoaded", function () {
    applyTheme(cfg.theme);
    cfg.theme = null;
    post({ type: "ready" });
  });
  // VS Code's default styles, under every style of the page (a cascade layer), outside the page's CSP.
  try {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(defaultStyles);
    document.adoptedStyleSheets = [sheet].concat(document.adoptedStyleSheets);
  } catch (e) {}
  // Storage: the page's origin is opaque, so the real ones throw.
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try { window[name].length; return; } catch (e) {}
    var data = new Map();
    var store = {
      getItem: function (k) { return data.has(String(k)) ? data.get(String(k)) : null; },
      setItem: function (k, v) { data.set(String(k), String(v)); },
      removeItem: function (k) { data.delete(String(k)); },
      clear: function () { data.clear(); },
      key: function (i) { return Array.from(data.keys())[i] ?? null; },
      get length() { return data.size; },
    };
    try { Object.defineProperty(window, name, { value: store, configurable: true }); } catch (e) {}
  });
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button > 1) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (/^(https?:|mailto:|command:)/i.test(href)) {
      e.preventDefault();
      post({ type: "link", href: href });
    }
  }, true);
  window.addEventListener("keydown", function (e) {
    if (!(e.metaKey || e.ctrlKey) && !/^F\\d+$/.test(e.key)) return;
    // Editing keys stay in the page.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && /^[acvxzy]$/i.test(e.key)) return;
    post({ type: "keydown", key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, repeat: e.repeat });
  });
  window.addEventListener("focus", function () { post({ type: "focus" }); });
})`;

/** JSON safe inside a <script> element. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v ?? null)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function preludeScript(cfg: PreludeConfig): string {
  return `<script>${SCRIPT}(${scriptJson(cfg)}, ${scriptJson(DEFAULT_STYLES)});</script>`;
}

/** `<body …>` with the theme kind (class and data attributes), so the page's first scripts see it. */
function themedBody(html: string, cfg: PreludeConfig): string {
  const t = cfg.theme;
  return html.replace(/<body(\s[^>]*)?>/i, (_m, attrs: string | undefined) => {
    let a = attrs ?? "";
    const cls = /\sclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(a);
    if (cls) a = a.replace(cls[0], ` class="${t.kind} ${cls[2] ?? cls[3] ?? ""}"`);
    else a += ` class="${t.kind}"`;
    return `<body${a} data-vscode-theme-kind="${t.kind}" data-vscode-theme-id="${t.themeId.replace(/[^\w.-]/g, "")}">`;
  });
}

/** The page the iframe loads: the extension's HTML with the prelude first in <head>. */
export function webviewDocument(source: string, cfg: PreludeConfig): string {
  const html = themedBody(source, cfg);
  const prelude = preludeScript(cfg);
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + prelude + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + `<head>${prelude}</head>` + html.slice(root.index + root[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + `<head>${prelude}</head>` + html.slice(doctype[0].length);
  return `<!DOCTYPE html><html><head>${prelude}</head><body>${html}</body></html>`;
}
