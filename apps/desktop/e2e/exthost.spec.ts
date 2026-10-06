import { expect, test, type Page } from "@playwright/test";

/**
 * The Web Worker extension host in the browser build, with a fixture browser
 * extension served by a mocked Open VSX (see extensions.spec.ts for the
 * registry mock; this spec builds its own small one).
 */

import { crc32, deflateRawSync } from "node:zlib";

function vsix(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const entries = Object.fromEntries(Object.entries(files).map(([k, v]) => [`extension/${k}`, Buffer.from(v)]));
  for (const [path, raw] of Object.entries(entries)) {
    const data = deflateRawSync(raw);
    const name = Buffer.from(path);
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
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const EXT_JS = `
const vscode = require("vscode");
exports.activate = (context) => {
  const out = vscode.window.createOutputChannel("Upper Web");
  out.appendLine("Upper Web activated in the " + (typeof process === "undefined" ? "web worker" : "node") + " host, loud=" + vscode.workspace.getConfiguration("upper").get("loud"));
  context.subscriptions.push(
    vscode.commands.registerCommand("upper.uppercase", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return vscode.window.showWarningMessage("Open a file first");
      const line = ed.document.lineAt(0);
      await ed.edit((b) => b.replace(line.range, line.text.toUpperCase()));
      vscode.window.showInformationMessage("Upper: first line uppercased");
    }),
    vscode.languages.registerDocumentFormattingEditProvider("plaintext", {
      provideDocumentFormattingEdits(doc) {
        const edits = [];
        for (let i = 0; i < doc.lineCount; i++) {
          const l = doc.lineAt(i);
          const t = l.text.replace(/\\s+$/, "");
          if (t !== l.text) edits.push(vscode.TextEdit.delete(new vscode.Range(i, t.length, i, l.text.length)));
        }
        return edits;
      },
    }),
    vscode.languages.registerCompletionItemProvider("plaintext", {
      provideCompletionItems() {
        const item = new vscode.CompletionItem("tmcodeGreeting", vscode.CompletionItemKind.Snippet);
        item.insertText = new vscode.SnippetString("Hello from \${1:an extension}");
        item.detail = "Upper Web";
        return [item];
      },
    }),
  );
  const diags = vscode.languages.createDiagnosticCollection("upper");
  const check = (doc) => {
    if (doc.languageId !== "markdown") return;
    const list = [];
    const re = /average/g;
    let m;
    while ((m = re.exec(doc.getText()))) list.push(new vscode.Diagnostic(new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + 7)), "Upper: 'average' found", vscode.DiagnosticSeverity.Warning));
    diags.set(doc.uri, list);
  };
  vscode.workspace.textDocuments.forEach(check);
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(check), vscode.workspace.onDidChangeTextDocument((e) => check(e.document)));
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  item.text = "$(rocket) Upper";
  item.tooltip = "Upper Web is running";
  item.show();
};
`;

const PKG = {
  name: "upper-web",
  publisher: "acme",
  version: "1.0.0",
  displayName: "Upper Web",
  description: "Uppercases things; a browser extension.",
  browser: "./dist/web.js",
  activationEvents: ["onStartupFinished"],
  contributes: {
    commands: [{ command: "upper.uppercase", title: "Uppercase First Line", category: "Upper" }],
    menus: { "editor/context": [{ command: "upper.uppercase", when: "editorLangId == markdown", group: "navigation" }] },
    configuration: { title: "Upper Web", properties: { "upper.loud": { type: "boolean", default: true, description: "Shout when uppercasing." } } },
  },
};

const API = "https://open-vsx.org/api";

async function mockOpenVsx(page: Page) {
  const cors = { "access-control-allow-origin": "*" };
  const v = PKG.version;
  const base = `${API}/acme/upper-web/${v}/file`;
  const gallery = {
    namespace: "acme",
    name: "upper-web",
    version: v,
    displayName: PKG.displayName,
    description: PKG.description,
    downloadCount: 4200,
    timestamp: "2026-09-01T10:00:00Z",
    files: { download: `${base}/acme.upper-web-${v}.vsix`, manifest: `${base}/package.json` },
  };
  await page.route("https://open-vsx.org/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/-/search") {
      const q = url.searchParams.get("query") ?? "";
      const hits = q && "upper web".includes(q.toLowerCase()) ? [gallery] : [];
      return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify({ offset: 0, totalSize: hits.length, extensions: hits }) });
    }
    if (url.pathname.endsWith(".vsix")) return route.fulfill({ headers: cors, contentType: "application/octet-stream", body: vsix({ "package.json": JSON.stringify(PKG), "dist/web.js": EXT_JS }) });
    if (url.pathname.endsWith("/package.json")) return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(PKG) });
    if (url.pathname === "/api/acme/upper-web") return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(gallery) });
    return route.fulfill({ status: 404, headers: cors, contentType: "application/json", body: JSON.stringify({ error: "Extension not found" }) });
  });
}

const view = (page: Page) => page.locator(".tm-sidebar");
const row = (page: Page) => view(page).locator('.tm-ext-row[data-ext-id="acme.upper-web"]');

async function palette(page: Page, text: string) {
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.keyboard.type(text);
  await expect(page.locator(".tm-qi-item").first()).toContainText(text.slice(0, 10));
  await page.keyboard.press("Enter");
}

async function openFile(page: Page, path: string) {
  await page.getByRole("tab", { name: /^Explorer/ }).click();
  await page.locator(`.tm-explorer [data-path="${path}"]`).dblclick();
  await expect(page.locator(".tm-tab.is-active")).toContainText(path.split("/").pop()!);
}

/** Installs the fixture extension, accepting the one-time trust notice. */
async function installUpperWeb(page: Page) {
  await mockOpenVsx(page);
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.getByRole("tab", { name: /^Extensions/ }).click();
  await view(page).getByRole("searchbox", { name: "Search Extensions in Open VSX" }).fill("upper");
  await row(page).getByRole("button", { name: "Install" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Upper Web runs code on your computer.");
  await dialog.getByRole("button", { name: "Trust and Enable" }).click();
  await expect(row(page).locator('[data-testid="ext-runtime"]')).toContainText("Activated", { timeout: 20000 });
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

test("a browser extension runs in the Web Worker host: palette command, diagnostics, status bar, Output", async ({ page }) => {
  await installUpperWeb(page);
  // Status bar item from window.createStatusBarItem.
  await expect(page.locator('.tm-statusbar [data-ext-status]')).toContainText("Upper");

  // Diagnostics feed the Problems panel.
  await openFile(page, "README.md");
  await page.keyboard.press("ControlOrMeta+Shift+m");
  await expect(page.locator(".tm-problems")).toContainText("Upper: 'average' found", { timeout: 15000 });

  // The contributed command is in the palette and edits the active editor.
  await page.locator(".monaco-editor .view-lines").first().click();
  await palette(page, "Upper: Uppercase First Line");
  await expect(page.locator(".monaco-editor .view-line").first()).toContainText("# PRACTICE PROJECT");
  await expect(page.locator(".tm-toast", { hasText: "Upper: first line uppercased" })).toBeVisible();

  // Its Output channel, in the Output panel's channel picker.
  await page.keyboard.press("ControlOrMeta+Shift+u");
  await page.locator(".tm-output-channel-select").selectOption("Upper Web");
  await expect(page.locator(".tm-output")).toContainText("Upper Web activated in the web worker host, loud=true");
});

test("formatting and completion providers from an extension, in Monaco", async ({ page }) => {
  await installUpperWeb(page);
  await page.evaluate(() => (window as unknown as { __TMCODE_DEBUG__: { externalWrite(p: string, c: string): Promise<void> } }).__TMCODE_DEBUG__.externalWrite("notes.txt", "one   \ntwo  \n"));
  await openFile(page, "notes.txt");
  await page.locator(".monaco-editor .view-lines").first().click();
  // Format Document uses the extension's formatter (trailing spaces go).
  await palette(page, "Format Document");
  await expect.poll(() => page.evaluate(() => (document.querySelector(".monaco-editor .view-line") as HTMLElement).textContent?.replace(/ /g, " "))).toBe("one");
  // Completion: the extension's snippet item, inserted with its placeholder.
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("tmc");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".suggest-widget .monaco-list-row", { hasText: "tmcodeGreeting" })).toBeVisible({ timeout: 10000 });
  await page.keyboard.press("Enter");
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("Hello from an extension");
});

test("Extensions UI: runtime status, settings section, restart, and no extension code in exams", async ({ page }) => {
  await installUpperWeb(page);
  await row(page).click();
  const editor = page.locator(".tm-ext-editor");
  await editor.getByRole("tab", { name: "Runtime Status" }).click();
  await expect(editor.locator(".tm-ext-runtime-status")).toContainText("Web Worker");
  await expect(editor.locator(".tm-ext-runtime-status")).toContainText("onStartupFinished");

  // Settings contributed by the extension, in the Settings editor; changes reach the extension.
  await page.keyboard.press("ControlOrMeta+,");
  const section = page.locator('[data-extension="acme.upper-web"]');
  await expect(section).toContainText("Shout when uppercasing.");
  await section.getByRole("checkbox").uncheck();
  await expect(section.locator(".tm-setting-modified")).toBeVisible();

  // Developer: Restart Extension Host reactivates it with the new setting.
  await palette(page, "Developer: Restart Extension Host");
  await page.keyboard.press("ControlOrMeta+Shift+u");
  await page.locator(".tm-output-channel-select").selectOption("Upper Web");
  await expect(page.locator(".tm-output")).toContainText("loud=false", { timeout: 20000 });

  // Show Running Extensions lists it.
  await palette(page, "Developer: Show Running Extensions");
  await expect(page.locator(".tm-qi-item", { hasText: "Upper Web" })).toContainText("Activated");
  await page.keyboard.press("Escape");

  // An exam stops the extension host: the command and status item disappear.
  const TM = `http://localhost:${process.env.MOCK_TM_PORT ?? 5099}`;
  await page.request.post(`${TM}/__test/reset`);
  const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
  await page.goto(`/?launch=${encodeURIComponent(deeplink)}`);
  await expect(page.locator(".tm-taskview-quiz")).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.tm-statusbar [data-ext-status]')).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.keyboard.type("Uppercase First Line");
  await expect(page.locator(".tm-qi-item", { hasText: "Uppercase First Line" })).toHaveCount(0);
});
