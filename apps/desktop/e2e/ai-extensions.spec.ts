import { expect, test, type Page } from "@playwright/test";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * AI extensions as they work in VS Code (docs/AI_AND_ACTIVITY_PLAN.md): a fixture "AI" extension
 * (Open VSX mocked) with ghost-text suggestions, a proposed edit shown as a diff of two virtual
 * documents (a content provider and a file system provider, as Claude Code and Blackbox do),
 * found and closed through window.tabGroups, and a chat in the secondary side bar. Everything it
 * does lands in the Activity panel, named as AI use.
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
  // Ghost text: "function greet(" is completed.
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ language: "javascript" }, {
      provideInlineCompletionItems(doc, pos) {
        const before = doc.lineAt(pos.line).text.slice(0, pos.character);
        if (!before.endsWith("function greet(")) return [];
        const end = doc.lineAt(pos.line).range.end;
        return [new vscode.InlineCompletionItem("name) {\\n  return 'Hello, ' + name;\\n}", new vscode.Range(pos, end))];
      },
    }),
  );

  // Proposed edits: the original (read-only) and the proposal (writable), as virtual documents.
  const original = new Map();
  const proposed = new Map();
  let saved = 0;
  const changed = new vscode.EventEmitter();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("fixture-orig", { provideTextDocumentContent: (uri) => original.get(uri.path) || "" }),
    vscode.workspace.registerFileSystemProvider("fixture-new", {
      onDidChangeFile: changed.event,
      watch: () => new vscode.Disposable(() => {}),
      stat: (uri) => ({ type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: (proposed.get(uri.path) || "").length }),
      readFile: (uri) => new TextEncoder().encode(proposed.get(uri.path) || ""),
      writeFile: (uri, content) => { proposed.set(uri.path, new TextDecoder().decode(content)); saved++; },
      readDirectory: () => [],
      createDirectory() {},
      delete() {},
      rename() {},
    }),
  );
  let target = null;
  const right = vscode.Uri.parse("fixture-new:/app.js");
  const findTab = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === right.toString());
  context.subscriptions.push(
    vscode.commands.registerCommand("fixture.propose", async () => {
      const doc = vscode.window.activeTextEditor.document;
      target = doc.uri;
      original.set("/app.js", doc.getText());
      proposed.set("/app.js", doc.getText().replace("console.log", "console.info"));
      await vscode.commands.executeCommand("vscode.diff", vscode.Uri.parse("fixture-orig:/app.js"), right, "✻ [Fixture AI] app.js", { preview: false });
      for (let i = 0; i < 20; i++) {
        const tab = findTab();
        if (tab) return vscode.window.showInformationMessage("Diff tab: " + tab.label);
        await new Promise((r) => setTimeout(r, 100));
      }
      vscode.window.showErrorMessage("No diff tab");
    }),
    vscode.commands.registerCommand("fixture.accept", async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (!tab || !(tab.input instanceof vscode.TabInputTextDiff)) return vscode.window.showErrorMessage("Not on a proposed edit");
      const doc = await vscode.workspace.openTextDocument(tab.input.modified);
      const text = doc.getText();
      const file = await vscode.workspace.openTextDocument(target);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(target, new vscode.Range(0, 0, file.lineCount, 0), text);
      await vscode.workspace.applyEdit(edit);
      await vscode.window.tabGroups.close(tab);
      vscode.window.showInformationMessage("Accepted (" + (findTab() ? "tab still open" : "tab closed") + ", saved " + saved + ")");
    }),
    // An agent view in the activity bar whose page posts nothing: TMCode shows "Starting…" until it has loaded.
    vscode.window.registerWebviewViewProvider("fixture.agent", {
      resolveWebviewView(view) {
        view.webview.options = { enableScripts: true };
        view.webview.html = "<!doctype html><html><body><h1 id='agent'>Fixture agent</h1></body></html>";
      },
    }),
    vscode.window.registerWebviewViewProvider("fixture.chat", {
      resolveWebviewView(view) {
        view.webview.options = { enableScripts: true };
        view.webview.html = "<!doctype html><html><body><h1 id='hello'>Fixture AI chat</h1></body></html>";
      },
    }),
  );
};
`;

const PKG = {
  name: "ai-fixture",
  publisher: "acme",
  version: "1.0.0",
  displayName: "Fixture AI",
  description: "An AI coding assistant (test fixture).",
  categories: ["AI", "Chat"],
  browser: "./dist/web.js",
  activationEvents: ["onStartupFinished"],
  contributes: {
    viewsContainers: { secondarySidebar: [{ id: "fixture-ai", title: "Fixture AI", icon: "$(hubot)" }], activitybar: [{ id: "fixture-agent", title: "Fixture Agent", icon: "$(robot)" }] },
    views: { "fixture-ai": [{ id: "fixture.chat", name: "Chat", type: "webview" }], "fixture-agent": [{ id: "fixture.agent", name: "Agent", type: "webview" }] },
    commands: [
      { command: "fixture.propose", title: "Propose Edit", category: "Fixture AI" },
      { command: "fixture.accept", title: "Accept Proposed Edit", category: "Fixture AI" },
    ],
  },
};

const API = "https://open-vsx.org/api";

async function mockOpenVsx(page: Page) {
  const cors = { "access-control-allow-origin": "*" };
  const v = PKG.version;
  const base = `${API}/acme/ai-fixture/${v}/file`;
  const gallery = { namespace: "acme", name: "ai-fixture", version: v, displayName: PKG.displayName, description: PKG.description, downloadCount: 1, timestamp: "2026-10-01T10:00:00Z", files: { download: `${base}/acme.ai-fixture-${v}.vsix`, manifest: `${base}/package.json` } };
  await page.route("https://open-vsx.org/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/-/search") {
      const q = url.searchParams.get("query") ?? "";
      const hits = q && "fixture ai".includes(q.toLowerCase()) ? [gallery] : [];
      return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify({ offset: 0, totalSize: hits.length, extensions: hits }) });
    }
    if (url.pathname.endsWith(".vsix")) return route.fulfill({ headers: cors, contentType: "application/octet-stream", body: vsix({ "package.json": JSON.stringify(PKG), "dist/web.js": EXT_JS }) });
    if (url.pathname.endsWith("/package.json")) return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(PKG) });
    if (url.pathname === "/api/acme/ai-fixture") return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(gallery) });
    return route.fulfill({ status: 404, headers: cors, contentType: "application/json", body: "{}" });
  });
}

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);
const sidebar = (page: Page) => page.locator(".tm-sidebar");
const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const editorText = (page: Page) => page.locator(".tm-editor-area .monaco-editor .view-lines").first();

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
  await sidebar(page).getByRole("searchbox", { name: "Search Extensions in Open VSX" }).fill("fixture");
  const r = sidebar(page).locator('.tm-ext-row[data-ext-id="acme.ai-fixture"]');
  await r.getByRole("button", { name: "Install" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Trust and Enable" }).click();
  await expect(r).toContainText(/Activated/, { timeout: 20000 });
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

test("an AI extension: ghost-text suggestions, a proposed edit as a diff, tabGroups, the secondary side bar, all in the Activity log", async ({ page }) => {
  await install(page);
  await externalWrite(page, "app.js", "console.log('hi');\n");
  await page.getByRole("tab", { name: /^Explorer/ }).click();
  await row(page, "app.js").click();
  await expect(editorText(page)).toContainText("console.log('hi');");

  // Ghost text: typing "function greet(" shows the suggestion; Tab accepts it.
  await editorText(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("function greet(");
  await expect(page.locator(".tm-editor-area .ghost-text-decoration, .tm-editor-area .ghost-text").first()).toBeVisible({ timeout: 10000 });
  await page.keyboard.press("Tab");
  await expect(editorText(page)).toContainText("return 'Hello, ' + name;");

  // A proposed edit: vscode.diff of a content provider document and a file system provider document.
  await palette(page, "Fixture AI: Propose Edit");
  await expect(page.locator(".tm-toast", { hasText: "Diff tab: ✻ [Fixture AI] app.js" })).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".tm-tab", { hasText: "✻ [Fixture AI] app.js" })).toBeVisible();
  const diff = page.getByTestId("extension-diff");
  await expect(diff).toBeVisible();
  await expect(page.locator(".tm-editor-area .monaco-diff-editor")).toContainText("console.info");

  // Accept: the extension reads tabGroups.activeTabGroup.activeTab, applies the edit and closes the tab.
  await palette(page, "Fixture AI: Accept Proposed Edit");
  await expect(page.locator(".tm-toast", { hasText: "Accepted (tab closed" })).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".tm-tab", { hasText: "✻ [Fixture AI] app.js" })).toHaveCount(0);
  await expect(editorText(page)).toContainText("console.info('hi');");

  // The secondary side bar holds the extension's chat (viewsContainers.secondarySidebar).
  await page.keyboard.press("ControlOrMeta+Alt+b");
  const aux = page.getByTestId("auxiliary-bar");
  await expect(aux).toBeVisible();
  // AI tools share one switcher (workbench.activityBar.groupAiTools, on by default).
  await aux.getByTestId("auxbar-ai-switcher").click();
  await page.getByTestId("ai-tools-menu").getByRole("menuitemradio", { name: /Fixture AI/ }).click();
  const frame = page.frameLocator('iframe[data-view-type="fixture.chat"]');
  await expect(frame.locator("#hello")).toHaveText("Fixture AI chat", { timeout: 15000 });

  // Everything above is in the Activity log, the AI parts named.
  await page.keyboard.press("ControlOrMeta+j");
  await page.locator(".tm-panel-tab", { hasText: "Activity" }).click();
  const log = page.getByTestId("activity-view");
  await expect(log).toContainText("Installed the extension Fixture AI (an AI tool)");
  await expect(log).toContainText("Accepted a suggestion from Fixture AI");
  await expect(log).toContainText("Fixture AI edited app.js");
  await expect(log.locator(".tm-actlog-row.is-ai").first()).toBeVisible();
  await expect(page.getByTestId("activity-ai-count")).toContainText(/[1-9]\d* with AI · Fixture AI/);
  await page.getByTestId("activity-filter-ai").click();
  await expect(log.locator(".tm-actlog-row:not(.is-ai)")).toHaveCount(0);
});

test("all AI tools under one AI icon: the open one highlighted, Starting… while a view loads, right-click to hide or split them", async ({ page }) => {
  await install(page);
  const bar = page.locator(".tm-activitybar");
  // One AI icon instead of one per AI extension.
  await expect(page.getByTestId("activity-ai-tools")).toBeVisible();
  await expect(page.getByTestId("activity-ext:fixture-agent")).toHaveCount(0);

  await page.getByTestId("activity-ai-tools").click();
  const menu = page.getByTestId("ai-tools-menu");
  await expect(menu.getByRole("menuitemradio")).toHaveText([/TMCode AI/, /Fixture Agent/, /Fixture AI/]);
  await menu.getByRole("menuitemradio", { name: /Fixture Agent/ }).click();
  // The page hasn't started yet: the view says so, then shows the page.
  await expect(sidebar(page).getByTestId("webview-starting")).toContainText("Starting Fixture AI…");
  await expect(page.frameLocator('iframe[data-view-type="fixture.agent"]').locator("#agent")).toHaveText("Fixture agent", { timeout: 15000 });
  await expect(sidebar(page).getByTestId("webview-starting")).toHaveCount(0);
  // The AI icon is highlighted while an AI tool is open, and the menu highlights that one only.
  await expect(page.getByTestId("activity-ai-tools")).toHaveClass(/is-active/);
  await page.getByTestId("activity-ai-tools").click();
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText(/Fixture Agent/);
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Right-click: one icon each instead, then hide one of them, then reset.
  await page.getByTestId("activity-ai-tools").click({ button: "right" });
  const ctx = page.locator(".tm-menu");
  await expect(ctx.getByRole("menuitemcheckbox", { name: "One AI Icon for All AI Tools" })).toHaveAttribute("aria-checked", "true");
  await ctx.getByRole("menuitemcheckbox", { name: "One AI Icon for All AI Tools" }).click();
  await expect(page.getByTestId("activity-ai-tools")).toHaveCount(0);
  await expect(page.getByTestId("activity-ext:fixture-agent")).toBeVisible();
  // Hiding the open view's icon keeps it until another view opens.
  await page.getByRole("tab", { name: /^Explorer/ }).click();
  await page.getByTestId("activity-ext:fixture-agent").click({ button: "right" });
  await ctx.getByRole("menuitem", { name: "Hide 'Fixture Agent'" }).click();
  await expect(page.getByTestId("activity-ext:fixture-agent")).toHaveCount(0);
  await bar.click({ button: "right", position: { x: 20, y: 5 } });
  await expect(ctx.getByRole("menuitemcheckbox", { name: "Fixture Agent" })).toHaveAttribute("aria-checked", "false");
  await ctx.getByRole("menuitem", { name: "Reset Activity Bar" }).click();
  await expect(page.getByTestId("activity-ai-tools")).toBeVisible();
  await expect(page.getByTestId("activity-ext:fixture-agent")).toHaveCount(0);

  // The secondary side bar: one switcher showing the AI tool that is open there.
  await page.keyboard.press("ControlOrMeta+Alt+b");
  const aux = page.getByTestId("auxiliary-bar");
  await expect(aux.getByTestId("auxbar-ai-switcher")).toContainText("TMCode AI");
  await aux.getByTestId("auxbar-ai-switcher").click();
  await menu.getByRole("menuitemradio", { name: /Fixture AI/ }).click();
  await expect(aux.getByTestId("auxbar-ai-switcher")).toContainText("Fixture AI");
  await expect(page.frameLocator('iframe[data-view-type="fixture.chat"]').locator("#hello")).toHaveText("Fixture AI chat", { timeout: 15000 });
});
