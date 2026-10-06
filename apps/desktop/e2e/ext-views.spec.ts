import { expect, test, type Page } from "@playwright/test";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * Extension UI contributions in the browser build (Web Worker host): a view
 * container in the activity bar with a tree view (menus, welcome content,
 * badge, refresh) and a webview view, a view in the Explorer, and a webview
 * panel in the editor area (two-way messages, state, theme variables,
 * resources, sandbox). The fixture extension comes from a mocked Open VSX.
 */

function vsix(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const name = Buffer.from(`extension/${path}`);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const EXT_JS = `
const vscode = require("vscode");
exports.activate = (context) => {
  const names = ["Alpha", "Beta"];
  const kids = { Alpha: ["Alpha One", "Alpha Two"] };
  const emitter = new vscode.EventEmitter();
  const provider = {
    onDidChangeTreeData: emitter.event,
    getChildren: (el) => (el ? kids[el] || [] : names),
    getParent: (el) => Object.keys(kids).find((k) => kids[k].includes(el)),
    getTreeItem: (el) => {
      const item = new vscode.TreeItem(el, kids[el] ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.contextValue = kids[el] ? "group" : "leaf";
      item.description = kids[el] ? kids[el].length + " children" : undefined;
      item.iconPath = new vscode.ThemeIcon(kids[el] ? "folder" : "symbol-field");
      if (!kids[el]) item.command = { command: "fixture.clicked", title: "Open", arguments: [el] };
      item.tooltip = new vscode.MarkdownString("**" + el + "** item");
      return item;
    },
  };
  const tree = vscode.window.createTreeView("fixture.items", { treeDataProvider: provider, showCollapseAll: true });
  tree.badge = { value: 2, tooltip: "two items" };
  const empty = [];
  const emptyEmitter = new vscode.EventEmitter();
  context.subscriptions.push(
    tree,
    vscode.window.registerTreeDataProvider("fixture.empty", { onDidChangeTreeData: emptyEmitter.event, getChildren: () => empty, getTreeItem: (e) => new vscode.TreeItem(e) }),
    vscode.window.registerTreeDataProvider("fixture.explorer", { getChildren: () => ["In the Explorer"], getTreeItem: (e) => new vscode.TreeItem(e) }),
    vscode.commands.registerCommand("fixture.clicked", (name) => vscode.window.showInformationMessage("Clicked " + name)),
    vscode.commands.registerCommand("fixture.itemAction", (el) => vscode.window.showInformationMessage("Item action on " + el)),
    vscode.commands.registerCommand("fixture.addItem", () => { names.push("Gamma"); tree.badge = { value: names.length }; emitter.fire(); }),
    vscode.commands.registerCommand("fixture.fillEmpty", () => { empty.push("Filled"); emptyEmitter.fire(); }),
    vscode.commands.registerCommand("fixture.reveal", () => tree.reveal("Alpha Two", { select: true })),
    vscode.window.registerWebviewViewProvider("fixture.side", {
      resolveWebviewView(view) {
        view.webview.options = { enableScripts: true };
        view.webview.html = '<!DOCTYPE html><html><head></head><body><h1>Side view</h1><p id="out">waiting</p><script>const api = acquireVsCodeApi(); window.addEventListener("message", (e) => { document.getElementById("out").textContent = e.data.text; }); api.postMessage("side-ready");</script></body></html>';
        view.webview.onDidReceiveMessage((m) => { if (m === "side-ready") view.webview.postMessage({ text: "side got " + m }); });
        view.description = "side description";
      },
    }),
    vscode.commands.registerCommand("fixture.openPanel", () => {
      const panel = vscode.window.createWebviewPanel("fixture.panel", "Fixture Panel", vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [context.extensionUri] });
      const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "panel.css"));
      const nonce = "n0nce" + Date.now();
      panel.webview.html = \`<!DOCTYPE html><html><head>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src \${panel.webview.cspSource}; script-src 'nonce-\${nonce}';">
        <link rel="stylesheet" href="\${css}">
        </head><body>
        <h1 id="title">Fixture Panel</h1><p id="reply">no reply</p><p id="count"></p><p id="theme"></p><p id="sandbox"></p><p id="inline">inline ok</p>
        <script nonce="\${nonce}">
          const api = acquireVsCodeApi();
          const state = api.getState() || { opened: 0 };
          state.opened++;
          api.setState(state);
          document.getElementById("count").textContent = "opened " + state.opened;
          document.getElementById("theme").textContent = getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-background").trim() ? "theme vars" : "no theme vars";
          let parentAccess;
          try { parentAccess = window.parent.document ? "parent reachable" : "?"; } catch (e) { parentAccess = "parent blocked"; }
          document.getElementById("sandbox").textContent = parentAccess + ", tauri " + (typeof window.__TAURI_INTERNALS__) + ", body " + document.body.className;
          window.addEventListener("message", (e) => { document.getElementById("reply").textContent = e.data.text; });
          api.postMessage({ type: "hello" });
        </script>
        <script>document.getElementById("inline").textContent = "inline script ran";</script>
        </body></html>\`;
      panel.webview.onDidReceiveMessage((m) => panel.webview.postMessage({ text: "pong for " + m.type }));
      panel.onDidDispose(() => vscode.window.showInformationMessage("Fixture panel disposed"));
    }),
  );
};
`;

const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='9' fill='black'/></svg>";

const PKG = {
  name: "views-fixture",
  publisher: "acme",
  version: "1.0.0",
  displayName: "Views Fixture",
  description: "Tree views and webviews.",
  browser: "./dist/web.js",
  contributes: {
    viewsContainers: { activitybar: [{ id: "fixture-views", title: "Fixture Views", icon: "media/icon.svg" }] },
    views: {
      "fixture-views": [
        { id: "fixture.items", name: "Items" },
        { id: "fixture.empty", name: "Empty" },
        { id: "fixture.side", name: "Side", type: "webview" },
      ],
      explorer: [{ id: "fixture.explorer", name: "Fixture Explorer View" }],
    },
    viewsWelcome: [{ view: "fixture.empty", contents: "Nothing here yet.\n[Fill It](command:fixture.fillEmpty)" }],
    commands: [
      { command: "fixture.addItem", title: "Add Item", category: "Fixture", icon: "$(add)" },
      { command: "fixture.itemAction", title: "Run Item Action", category: "Fixture" },
      { command: "fixture.inlineAction", title: "Inline Action", icon: "$(play)" },
      { command: "fixture.openPanel", title: "Open Panel", category: "Fixture" },
      { command: "fixture.reveal", title: "Reveal Alpha Two", category: "Fixture" },
    ],
    menus: {
      "view/title": [{ command: "fixture.addItem", when: "view == fixture.items", group: "navigation" }],
      "view/item/context": [
        { command: "fixture.itemAction", when: "view == fixture.items && viewItem == leaf" },
        { command: "fixture.inlineAction", when: "view == fixture.items && viewItem == group", group: "inline" },
      ],
    },
  },
};

const API = "https://open-vsx.org/api";

async function mockOpenVsx(page: Page) {
  const cors = { "access-control-allow-origin": "*" };
  const v = PKG.version;
  const base = `${API}/acme/views-fixture/${v}/file`;
  const gallery = { namespace: "acme", name: "views-fixture", version: v, displayName: PKG.displayName, description: PKG.description, downloadCount: 1, timestamp: "2026-10-01T10:00:00Z", files: { download: `${base}/acme.views-fixture-${v}.vsix`, manifest: `${base}/package.json` } };
  await page.route("https://open-vsx.org/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/-/search") {
      const q = url.searchParams.get("query") ?? "";
      const hits = q && "views fixture".includes(q.toLowerCase()) ? [gallery] : [];
      return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify({ offset: 0, totalSize: hits.length, extensions: hits }) });
    }
    if (url.pathname.endsWith(".vsix")) {
      return route.fulfill({ headers: cors, contentType: "application/octet-stream", body: vsix({ "package.json": JSON.stringify(PKG), "dist/web.js": EXT_JS, "media/icon.svg": SVG, "media/panel.css": "#title { color: rgb(255, 0, 0); }" }) });
    }
    if (url.pathname.endsWith("/package.json")) return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(PKG) });
    if (url.pathname === "/api/acme/views-fixture") return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(gallery) });
    return route.fulfill({ status: 404, headers: cors, contentType: "application/json", body: "{}" });
  });
}

const sidebar = (page: Page) => page.locator(".tm-sidebar");

async function palette(page: Page, text: string) {
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.keyboard.type(text);
  await expect(page.locator(".tm-qi-item").first()).toContainText(text.slice(0, 10));
  await page.keyboard.press("Enter");
}

async function install(page: Page) {
  await mockOpenVsx(page);
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.getByRole("tab", { name: /^Extensions/ }).click();
  await sidebar(page).getByRole("searchbox", { name: "Search Extensions in Open VSX" }).fill("views");
  const row = sidebar(page).locator('.tm-ext-row[data-ext-id="acme.views-fixture"]');
  await row.getByRole("button", { name: "Install" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Trust and Enable" }).click();
  await expect(page.getByRole("tab", { name: "Fixture Views" })).toBeVisible({ timeout: 20000 });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("tm-e2e-cleared")) {
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem("tm-e2e-cleared", "1");
    }
  });
});

test("a view container with a tree view: items, commands, menus, badge, refresh, welcome, reveal", async ({ page }) => {
  await install(page);
  const container = page.getByRole("tab", { name: "Fixture Views" });
  // The badge of the tree view, on the container's icon (onView activates the extension).
  await container.click();
  await expect(sidebar(page).locator(".tm-sidebar-title")).toContainText("Fixture Views");
  const items = page.getByTestId("ext-view-fixture.items");
  const tree = items.getByRole("tree");
  await expect(tree.getByRole("treeitem", { name: "Alpha 2 children" })).toBeVisible({ timeout: 15000 });
  await expect(tree.getByRole("treeitem", { name: "Alpha 2 children" })).toContainText("2 children");
  await expect(container.locator(".tm-activity-badge")).toHaveText("2");

  // Expanding loads children lazily; a click runs the item's command.
  await tree.getByRole("treeitem", { name: "Alpha 2 children" }).click();
  await tree.getByRole("treeitem", { name: "Alpha One" }).click();
  await expect(page.locator(".tm-toast", { hasText: "Clicked Alpha One" })).toBeVisible();

  // view/item/context: the context menu for leaves; inline actions on groups.
  await tree.getByRole("treeitem", { name: "Beta" }).click({ button: "right" });
  await page.locator(".tm-menu").getByText("Run Item Action").click();
  await expect(page.locator(".tm-toast", { hasText: "Item action on Beta" })).toBeVisible();
  await tree.getByRole("treeitem", { name: "Alpha 2 children" }).hover();
  await expect(tree.getByRole("treeitem", { name: "Alpha 2 children" }).getByRole("button", { name: "Inline Action" })).toBeVisible();

  // view/title: the navigation action refreshes the tree (onDidChangeTreeData) and the badge.
  await items.locator(".tm-pane-header").hover();
  await items.getByRole("button", { name: "Add Item", exact: true }).click();
  await expect(tree.getByRole("treeitem", { name: "Gamma" })).toBeVisible();
  await expect(container.locator(".tm-activity-badge")).toHaveText("3");

  // viewsWelcome while a view is empty; its command button fills it.
  const empty = page.getByTestId("ext-view-fixture.empty");
  await expect(empty).toContainText("Nothing here yet.");
  await empty.getByRole("button", { name: "Fill It" }).click();
  await expect(empty.getByRole("treeitem", { name: "Filled" })).toBeVisible();

  // TreeView.reveal expands the parents and selects the element.
  await tree.getByRole("treeitem", { name: "Alpha 2 children" }).click();
  await expect(tree.getByRole("treeitem", { name: "Alpha Two" })).toHaveCount(0);
  await palette(page, "Fixture: Reveal Alpha Two");
  await expect(tree.getByRole("treeitem", { name: "Alpha Two" })).toHaveAttribute("aria-selected", "true");

  // A view contributed to the Explorer.
  await page.getByRole("tab", { name: /^Explorer/ }).click();
  const explorerView = page.getByTestId("ext-view-fixture.explorer");
  await expect(explorerView.getByRole("treeitem", { name: "In the Explorer" })).toBeVisible();
});

test("webview view and webview panel: sandboxed iframes, messages both ways, state, theme, resources", async ({ page }) => {
  await install(page);
  await page.getByRole("tab", { name: "Fixture Views" }).click();
  // The webview view, resolved when shown, with its description.
  const side = page.getByTestId("ext-view-fixture.side");
  await expect(side).toContainText("side description", { timeout: 15000 });
  const sideFrame = page.frameLocator('iframe[data-view-type="fixture.side"]');
  await expect(sideFrame.locator("h1")).toHaveText("Side view");
  await expect(sideFrame.locator("#out")).toHaveText("side got side-ready");

  // The panel: an editor tab with the extension's page.
  await palette(page, "Fixture: Open Panel");
  await expect(page.locator(".tm-tab.is-active")).toContainText("Fixture Panel");
  const frame = page.frameLocator('iframe[data-view-type="fixture.panel"]');
  await expect(frame.locator("#reply")).toHaveText("pong for hello");
  await expect(frame.locator("#count")).toHaveText("opened 1");
  await expect(frame.locator("#theme")).toHaveText("theme vars");
  // asWebviewUri resources (with the extension's own CSP, which also blocks its nonce-less inline script).
  await expect(frame.locator("#title")).toHaveCSS("color", "rgb(255, 0, 0)");
  await expect(frame.locator("#inline")).toHaveText("inline ok");
  // Sandboxed: no access to the workbench, no Tauri IPC; the theme kind is on <body>.
  await expect(frame.locator("#sandbox")).toHaveText(/^parent blocked, tauri undefined, body vscode-(dark|light)$/);
  await expect(page.locator('iframe[data-view-type="fixture.panel"]')).toHaveAttribute("sandbox", /allow-scripts/);
  await expect(page.locator('iframe[data-view-type="fixture.panel"]')).not.toHaveAttribute("sandbox", /allow-same-origin/);

  // Hidden (another tab) and shown again: the page is re-created, its state kept (getState).
  await page.getByRole("tab", { name: /^Explorer/ }).click();
  await page.locator('.tm-explorer [data-path="README.md"]').dblclick();
  await expect(page.locator(".tm-tab.is-active")).toContainText("README.md");
  await page.locator(".tm-tab", { hasText: "Fixture Panel" }).click();
  await expect(frame.locator("#count")).toHaveText("opened 2");

  // Closing the tab disposes the panel (onDidDispose).
  await page.locator(".tm-tab", { hasText: "Fixture Panel" }).hover();
  await page.locator(".tm-tab", { hasText: "Fixture Panel" }).getByRole("button", { name: /Close/ }).click();
  await expect(page.locator(".tm-toast", { hasText: "Fixture panel disposed" })).toBeVisible();
  await expect(page.locator('iframe[data-view-type="fixture.panel"]')).toHaveCount(0);
});

test("no extension views or webviews in exams", async ({ page }) => {
  await install(page);
  await page.getByRole("tab", { name: "Fixture Views" }).click();
  await expect(page.frameLocator('iframe[data-view-type="fixture.side"]').locator("h1")).toHaveText("Side view", { timeout: 15000 });
  const TM = `http://localhost:${process.env.MOCK_TM_PORT ?? 5099}`;
  await page.request.post(`${TM}/__test/reset`);
  const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
  await page.goto(`/?launch=${encodeURIComponent(deeplink)}`);
  await expect(page.locator(".tm-taskview-quiz")).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("tab", { name: "Fixture Views" })).toHaveCount(0);
  await expect(page.locator(".tm-webview-frame")).toHaveCount(0);
});
