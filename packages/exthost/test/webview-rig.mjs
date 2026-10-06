// Real extensions' webviews in a real browser, without the app: the bundled
// Node host runs the extension (test/harness.mjs); a local HTTP server plays
// the part of webview.rs (pages with TMCode's prelude and the same CSP,
// localResourceRoots files) and of the workbench (a host page that frames
// each webview in a sandboxed iframe and relays postMessage to the host).
// Playwright (Chromium or WebKit) loads it and takes a screenshot.
//
//   node packages/exthost/test/webview-rig.mjs <extension dir> <workspace> <command[@file] | view:<id>> <screenshot.png> [chromium|webkit] [wait ms]
import { createServer } from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { FakeWorkbench, describeExtension } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [extDir, root, what, shot, browserName = "chromium", waitMs = "6000"] = process.argv.slice(2);
if (!extDir || !root || !what || !shot) {
  console.error("usage: node webview-rig.mjs <extension dir> <workspace> <command | view:<id>> <screenshot.png> [chromium|webkit] [wait ms]");
  process.exit(2);
}

// The workbench's prelude (acquireVsCodeApi, theme, links…), compiled from its source.
const preludeOut = await build({ entryPoints: [resolve(here, "../../workbench/src/exthost/views/prelude.ts")], bundle: true, format: "esm", platform: "neutral", write: false });
const { webviewDocument } = await import(`data:text/javascript;base64,${Buffer.from(preludeOut.outputFiles[0].text).toString("base64")}`);
const THEME = {
  kind: "vscode-dark",
  themeId: "dark-modern",
  colorScheme: "dark",
  vars: {
    "--vscode-font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
    "--vscode-font-size": "13px",
    "--vscode-font-weight": "normal",
    "--vscode-editor-font-family": "Menlo, monospace",
    "--vscode-editor-font-size": "14px",
    "--vscode-foreground": "#cccccc",
    "--vscode-editor-background": "#1f1f1f",
    "--vscode-editor-foreground": "#cccccc",
    "--vscode-sideBar-background": "#181818",
    "--vscode-button-background": "#0078d4",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-input-background": "#313131",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-focusBorder": "#0078d4",
    "--vscode-textLink-foreground": "#4daafc",
    "--vscode-scrollbarSlider-background": "#79797966",
    "--vscode-list-hoverBackground": "#2a2d2e",
    "--vscode-list-activeSelectionBackground": "#04395e",
    "--vscode-widget-shadow": "#0000005c",
    "--vscode-menu-background": "#1f1f1f",
    "--vscode-panel-border": "#2b2b2b",
    "--vscode-editorGroup-border": "#ffffff17",
  },
};

const pages = new Map(); // handle → { html, roots, state }
const events = []; // pending messages to the browser
let waiters = [];
const push = (e) => {
  events.push(e);
  for (const w of waiters.splice(0)) w();
};

let base = "";
let wb;

const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>webview rig</title>
<style>html,body{margin:0;height:100%;background:#1f1f1f;color:#ccc;font:13px sans-serif} #tabs{height:28px;display:flex;gap:8px;align-items:center;padding:0 8px;background:#181818} iframe{border:0;width:100%;height:calc(100% - 28px);display:none} iframe.on{display:block}</style></head>
<body><div id="tabs"></div><script>
const frames = new Map();
function frame(handle, scripts) {
  let f = frames.get(handle);
  if (!f) {
    f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-forms allow-downloads allow-pointer-lock" + (scripts ? " allow-scripts" : ""));
    f.dataset.webview = handle;
    document.body.appendChild(f);
    frames.set(handle, f);
    for (const x of frames.values()) x.classList.toggle("on", x === f);
  }
  return f;
}
const ready = new Set();
const queue = [];
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.__tmwebview !== 1) return;
  const handle = [...frames].find(([, f]) => f.contentWindow === e.source)?.[0];
  if (!handle) return;
  if (d.type === "ready") { ready.add(handle); for (const m of queue.splice(0)) if (m.handle === handle) frames.get(handle).contentWindow.postMessage({ __tmwebview: 1, type: "message", data: m.data }, "*"); else queue.push(m); }
  else fetch("/__msg", { method: "POST", body: JSON.stringify({ handle, ...d }) });
});
(async function poll() {
  for (;;) {
    const list = await (await fetch("/__events")).json();
    for (const e of list) {
      if (e.type === "create") { frame(e.handle, e.scripts); document.getElementById("tabs").textContent = e.title; }
      if (e.type === "load") { ready.delete(e.handle); const f = frame(e.handle, e.scripts); f.setAttribute("sandbox", "allow-forms allow-downloads allow-pointer-lock" + (e.scripts ? " allow-scripts" : "")); f.src = "/" + e.handle + "/index.html?" + Date.now(); }
      if (e.type === "message") {
        const f = frames.get(e.handle);
        if (f && ready.has(e.handle)) f.contentWindow.postMessage({ __tmwebview: 1, type: "message", data: e.data }, "*"); else queue.push(e);
      }
    }
  }
})();
</script></body></html>`;

const MIME = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", json: "application/json", map: "application/json" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, base);
  if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(HOST_PAGE);
  if (url.pathname === "/__events") {
    if (!events.length) await new Promise((r) => waiters.push(r));
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(events.splice(0)));
  }
  if (url.pathname === "/__msg") {
    let body = "";
    for await (const c of req) body += c;
    const m = JSON.parse(body);
    if (process.env.RIG_TRACE) console.log(`page → host: ${body.slice(0, 300)}`);
    if (m.type === "message") await wb.request("$webviewMessage", [m.handle, m.data]).catch(() => {});
    if (m.type === "setState") pages.get(m.handle).state = m.data;
    if (m.type === "link") console.log(`link: ${m.href}`);
    return res.writeHead(204).end();
  }
  const [, handle, kind, ...rest] = url.pathname.split("/");
  const page = pages.get(handle);
  if (!page) return res.writeHead(404).end();
  // The same CSP as webview.rs, with this server as the webview origin.
  const csp = `default-src 'none'; script-src ${base} 'unsafe-inline' 'unsafe-eval' https: blob: data:; style-src ${base} 'unsafe-inline' https: data:; img-src ${base} https: http: data: blob:; font-src ${base} https: data:; media-src ${base} https: data: blob:; connect-src ${base} https: wss: ws: http://localhost:* http://127.0.0.1:* data: blob:; frame-src ${base} https: http://localhost:* http://127.0.0.1:*; worker-src ${base} blob: data:; form-action 'none'`;
  if (kind === "index.html") return res.writeHead(200, { "content-type": MIME.html, "content-security-policy": csp }).end(webviewDocument(page.html, { state: page.state, theme: THEME }));
  if (kind === "file") {
    const path = "/" + decodeURIComponent(rest.join("/"));
    let real;
    try {
      real = realpathSync(path);
    } catch {
      return res.writeHead(404).end();
    }
    if (!page.roots.some((r) => real.startsWith(realpathSync(r))) || !statSync(real).isFile()) return res.writeHead(404).end("outside localResourceRoots");
    return res.writeHead(200, { "content-type": MIME[real.split(".").pop()] ?? "application/octet-stream", "access-control-allow-origin": "*" }).end(readFileSync(real));
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}`;
// "command@file": the file is open in the editor and passed as the command's Uri argument.
const [cmdName, cmdFile] = what.split("@");
wb = new FakeWorkbench({
  env: { webviewBase: base, webviewCspSource: base },
  documents: cmdFile ? { [cmdFile]: { text: readFileSync(resolve(root, cmdFile), "utf8"), languageId: cmdFile.endsWith(".html") ? "html" : "plaintext" } } : {},
  root: resolve(root),
  extensions: [describeExtension(resolve(extDir))],
  onRequest(method, params) {
    if (method === "$main.webview") {
      const [op, handle, data] = params;
      const p = pages.get(handle) ?? { html: "", roots: [], state: undefined };
      pages.set(handle, p);
      if (op === "create") {
        p.roots = data.options.localResourceRoots;
        p.scripts = data.options.enableScripts;
        p.title = data.title ?? data.viewType;
        push({ type: "create", handle, title: p.title, scripts: data.options.enableScripts });
      } else if (op === "options") {
        p.roots = data.localResourceRoots;
        p.scripts = data.enableScripts;
      } else if (op === "html") {
        p.html = data;
        push({ type: "load", handle, scripts: p.scripts });
      } else if (op === "title") push({ type: "title", handle, title: data });
      return null;
    }
    if (method === "$main.webviewPost") {
      if (process.env.RIG_TRACE) console.log(`host → page: ${JSON.stringify(params)}`);
      push({ type: "message", handle: params[0], data: params[1] });
      return true;
    }
    return undefined;
  },
});


const ext = describeExtension(resolve(extDir));
let failed = false;
try {
  await wb.init;
  await wb.request("$startup");
  if (what.startsWith("view:")) {
    const id = what.slice(5);
    await wb.request("$activateByEvent", [`onView:${id}`]);
    await wb.waitFor(() => wb.ui.some((u) => u[0] === "$main.webviewView" && u[2] === id), `a provider for ${id}`, 60000);
    await wb.request("$resolveWebviewView", [id]);
  } else {
    await wb.waitFor(() => ["activated", "failed"].includes(wb.states.get(ext.id)?.state) || !ext.manifest.activationEvents?.includes("*"), "activation", 60000).catch(() => {});
    console.log(`${what} → ${JSON.stringify((await wb.request("$executeCommand", [cmdName, cmdFile ? [{ $path: cmdFile }] : []]).catch((e) => `error: ${e.message}`)) ?? null)}`);
  }
  const { chromium, webkit } = await import(pathToFileURL(resolve(here, "../../../node_modules/playwright/index.mjs")).href);
  const browser = await (browserName === "webkit" ? webkit : chromium).launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base);
  await page.waitForTimeout(Number(waitMs));
  // The first webview (the view or panel asked for; extensions may open more, such as release notes).
  const shown = Number(process.env.RIG_FRAME ?? 0);
  await page.evaluate((n) => document.querySelectorAll("iframe").forEach((f, i) => f.classList.toggle("on", i === n)), shown);
  if (what.startsWith("view:") && !process.env.RIG_WIDE) await page.setViewportSize({ width: 380, height: 760 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: shot });
  const frame = page.frames().filter((f) => f.url().includes("/index.html"))[shown];
  const text = frame ? await frame.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 400)).catch((e) => `(${e.message})`) : "(no webview frame)";
  console.log(`webview text: ${text}`);
  if (errors.length) console.log(`console errors:\n  ${errors.slice(0, 10).join("\n  ")}`);
  await browser.close();
} catch (e) {
  failed = true;
  console.error(e);
  console.error(wb.logs.join("").slice(-2000));
} finally {
  const notes = wb.output.join("").split("\n").filter((l) => /not supported|error|failed/i.test(l)).slice(0, 12);
  if (notes.length) console.log(`extension log:\n  ${notes.join("\n  ")}`);
  await wb.close().catch(() => {});
  server.close();
  server.closeAllConnections?.();
  process.exit(failed ? 1 : 0);
}
