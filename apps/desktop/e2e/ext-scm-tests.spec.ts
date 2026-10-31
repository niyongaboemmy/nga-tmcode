import { expect, test, type Page } from "@playwright/test";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * Phase 9: an extension's source control (scm.createSourceControl) in Source
 * Control, its tests (tests.createTestController) in Testing, run from there
 * with results back, and the APIs TMCode doesn't show (lm, chat) not failing.
 */

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
exports.activate = async (context) => {
  const root = vscode.workspace.workspaceFolders[0].uri;
  const sc = vscode.scm.createSourceControl("fakevcs", "Fake VCS", root);
  sc.inputBox.placeholder = "Describe your change";
  const changes = sc.createResourceGroup("changes", "Changes");
  changes.resourceStates = [
    { resourceUri: vscode.Uri.joinPath(root, "main.py"), decorations: { tooltip: "Modified" }, command: { command: "fakevcs.open", title: "Open", arguments: ["main.py"] } },
    { resourceUri: vscode.Uri.joinPath(root, "old.txt"), decorations: { strikeThrough: true, tooltip: "Deleted" } },
  ];
  sc.count = 2;
  sc.acceptInputCommand = { command: "fakevcs.commit", title: "Commit" };
  context.subscriptions.push(
    vscode.commands.registerCommand("fakevcs.commit", () => vscode.window.showInformationMessage("Fake VCS committed: " + sc.inputBox.value)),
    vscode.commands.registerCommand("fakevcs.open", (p) => vscode.window.showInformationMessage("Fake VCS opened " + p)),
  );

  const ctrl = vscode.tests.createTestController("fakeTests", "Fake Tests");
  const file = ctrl.createTestItem("suite", "math suite", vscode.Uri.joinPath(root, "main.py"));
  const good = ctrl.createTestItem("good", "adds numbers", vscode.Uri.joinPath(root, "main.py"));
  const bad = ctrl.createTestItem("bad", "divides numbers", vscode.Uri.joinPath(root, "main.py"));
  bad.range = new vscode.Range(2, 0, 2, 4);
  file.children.add(good);
  file.children.add(bad);
  ctrl.items.add(file);
  ctrl.createRunProfile("Run", vscode.TestRunProfileKind.Run, async (request) => {
    const run = ctrl.createTestRun(request);
    const items = request.include ? request.include : [file];
    const leaves = [];
    for (const i of items) i.children.size ? i.children.forEach((c) => leaves.push(c)) : leaves.push(i);
    for (const t of leaves) {
      run.started(t);
      if (t.id === "bad") run.failed(t, vscode.TestMessage.diff("division is wrong", "2", "3"), 5);
      else run.passed(t, 3);
    }
    run.end();
  }, true);

  // Not shown in TMCode, but they must not fail.
  const models = await vscode.lm.selectChatModels({});
  vscode.chat.createChatParticipant("fake.chat", () => undefined);
  const out = vscode.window.createOutputChannel("Fake VCS");
  out.appendLine("models: " + models.length);
};
`;

const PKG = {
  name: "fake-vcs",
  publisher: "acme",
  version: "1.0.0",
  displayName: "Fake VCS",
  description: "A source control and tests for e2e.",
  browser: "./dist/web.js",
  activationEvents: ["onStartupFinished"],
  contributes: { commands: [{ command: "fakevcs.commit", title: "Commit", category: "Fake VCS" }] },
};

const API = "https://open-vsx.org/api";

async function mockOpenVsx(page: Page) {
  const cors = { "access-control-allow-origin": "*" };
  const v = PKG.version;
  const base = `${API}/acme/fake-vcs/${v}/file`;
  const gallery = { namespace: "acme", name: "fake-vcs", version: v, displayName: PKG.displayName, description: PKG.description, downloadCount: 1, timestamp: "2026-09-01T10:00:00Z", files: { download: `${base}/acme.fake-vcs-${v}.vsix`, manifest: `${base}/package.json` } };
  await page.route("https://open-vsx.org/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/-/search") {
      const q = url.searchParams.get("query") ?? "";
      const hits = q && "fake vcs".includes(q.toLowerCase()) ? [gallery] : [];
      return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify({ offset: 0, totalSize: hits.length, extensions: hits }) });
    }
    if (url.pathname.endsWith(".vsix")) return route.fulfill({ headers: cors, contentType: "application/octet-stream", body: vsix({ "package.json": JSON.stringify(PKG), "dist/web.js": EXT_JS }) });
    if (url.pathname.endsWith("/package.json")) return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(PKG) });
    if (url.pathname === "/api/acme/fake-vcs") return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(gallery) });
    return route.fulfill({ status: 404, headers: cors, contentType: "application/json", body: "{}" });
  });
}

const view = (page: Page) => page.locator(".tm-sidebar");
const extRow = (page: Page) => view(page).locator('.tm-ext-row[data-ext-id="acme.fake-vcs"]');

async function install(page: Page) {
  await mockOpenVsx(page);
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.getByRole("tab", { name: /^Extensions/ }).click();
  await view(page).getByRole("searchbox", { name: "Search Extensions in Open VSX" }).fill("fake");
  await extRow(page).getByRole("button", { name: "Install" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Trust and Enable" }).click();
  await expect(extRow(page).locator('[data-testid="ext-runtime"]')).toContainText("Activated", { timeout: 20000 });
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

test("an extension's source control shows its changes, input and commands", async ({ page }) => {
  await install(page);
  await page.getByRole("tab", { name: /^Source Control/ }).click();
  const scm = page.getByTestId("ext-scm");
  await expect(scm).toContainText("Fake VCS");
  await expect(scm).toContainText("Changes");
  await expect(scm.locator(".tm-scm-row")).toHaveCount(2);
  await expect(scm.locator(".tm-scm-name.is-deleted")).toHaveText("old.txt");
  await scm.locator(".tm-scm-row", { hasText: "main.py" }).click();
  await expect(page.locator(".tm-toast").filter({ hasText: "Fake VCS opened main.py" })).toBeVisible();
  await scm.getByRole("textbox", { name: "Fake VCS message" }).fill("first commit");
  await scm.getByRole("button", { name: "Commit" }).click();
  await expect(page.locator(".tm-toast").filter({ hasText: "Fake VCS committed: first commit" })).toBeVisible();
});

test("an extension's tests run from Testing, with results and the failure's message", async ({ page }) => {
  await install(page);
  await page.getByRole("tab", { name: /^Testing/ }).click();
  const tests = page.getByTestId("ext-tests");
  await expect(tests).toContainText("Fake Tests");
  await expect(tests).toContainText("math suite");
  // The section's actions show on hover, as in VS Code.
  await tests.locator(".tm-scm-section-header").hover();
  await tests.getByRole("button", { name: "Run All Tests (Fake Tests)" }).click();
  await expect(tests.locator(".tm-ext-test.is-passed")).toContainText("adds numbers");
  await expect(tests.locator(".tm-ext-test.is-failed")).toContainText("divides numbers");
  await expect(tests.locator(".tm-ext-test-message")).toContainText("Expected: 2");
});
