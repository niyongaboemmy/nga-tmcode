import { crc32, deflateRawSync } from "node:zlib";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * VS Code extensions from Open VSX, in the browser build (memory platform).
 * open-vsx.org is mocked here: the registry API and the .vsix files are
 * fixtures built below, so the tests never reach the real marketplace.
 */

const TM = `http://localhost:${process.env.MOCK_TM_PORT ?? 5099}`;
const API = "https://open-vsx.org/api";

/** A minimal zip writer: a .vsix is a zip with the extension under extension/. */
function vsix(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const entries = { "[Content_Types].xml": "<Types/>", "extension.vsixmanifest": "<PackageManifest/>", ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`extension/${k}`, v])) };
  for (const [path, content] of Object.entries(entries)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);
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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPhfDwAEMgHPX2Q1EwAAAABJRU5ErkJggg==", "base64");
const SVG = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${fill}"/></svg>`;

interface Fixture {
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  downloads: number;
  rating?: number;
  files: Record<string, string | Buffer>;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

const OWL_THEME: Fixture = {
  namespace: "owlco",
  name: "owl-midnight",
  displayName: "Owl Midnight",
  description: "A dark theme for night owls, with the Owl language.",
  downloads: 12_345,
  rating: 4.5,
  files: {
    "package.json": json({
      name: "owl-midnight",
      publisher: "owlco",
      version: "1.0.0",
      displayName: "Owl Midnight",
      description: "A dark theme for night owls, with the Owl language.",
      icon: "icon.png",
      categories: ["Themes", "Programming Languages"],
      contributes: {
        themes: [{ label: "Owl Midnight", uiTheme: "vs-dark", path: "./themes/owl.json" }],
        languages: [{ id: "owl", aliases: ["Owl", "owl"], extensions: [".owl"], configuration: "./language-configuration.json" }],
        grammars: [{ language: "owl", scopeName: "source.owl", path: "./syntaxes/owl.tmLanguage.json" }],
        snippets: [{ language: "owl", path: "./snippets/owl.json" }],
      },
    }),
    "icon.png": PNG,
    "README.md": "# Owl Midnight\n\nA **dark** theme.\n\n![screenshot](images/shot.png)\n",
    "images/shot.png": PNG,
    // JSONC, like most VS Code themes.
    "themes/owl.json": `{
      // Owl Midnight
      "type": "dark",
      "colors": {
        "editor.background": "#011627",
        "editor.foreground": "#d6deeb",
        "activityBar.background": "#0b2942",
        "sideBar.background": "#011628",
        "statusBar.background": "#011629",
      },
      "tokenColors": [
        { "scope": "keyword.control", "settings": { "foreground": "#c792ea" } },
        { "scope": "comment", "settings": { "foreground": "#637777", "fontStyle": "italic" } },
      ],
    }`,
    "language-configuration.json": json({ comments: { lineComment: "#" }, brackets: [["(", ")"]] }),
    "syntaxes/owl.tmLanguage.json": json({
      scopeName: "source.owl",
      patterns: [
        { match: "\\b(hoot|fly)\\b", name: "keyword.control.owl" },
        { match: "#.*$", name: "comment.line.number-sign.owl" },
      ],
    }),
    "snippets/owl.json": json({ "Night flight": { prefix: "nightflight", body: ["fly ${1:far}", "hoot"], description: "Fly at night" } }),
  },
};

const OWL_ICONS: Fixture = {
  namespace: "owlco",
  name: "owl-icons",
  displayName: "Owl Icons",
  description: "File icons with owls.",
  downloads: 800,
  files: {
    "package.json": json({ name: "owl-icons", publisher: "owlco", version: "0.3.0", displayName: "Owl Icons", contributes: { iconThemes: [{ id: "owl-icons", label: "Owl Icons", path: "./icons/owl-icons.json" }] } }),
    "icons/owl-icons.json": json({
      iconDefinitions: { _owl: { iconPath: "./owl.svg" }, _file: { iconPath: "./file.svg" } },
      file: "_file",
      fileExtensions: { owl: "_owl" },
    }),
    "icons/owl.svg": SVG("#c792ea"),
    "icons/file.svg": SVG("#888888"),
  },
};

const RUNNER: Fixture = {
  namespace: "runnerco",
  name: "code-runner-lite",
  displayName: "Code Runner Lite",
  description: "Runs code with a command and adds Python snippets.",
  downloads: 2_500_000,
  rating: 4,
  files: {
    "package.json": json({
      name: "code-runner-lite",
      publisher: "runnerco",
      version: "2.1.0",
      displayName: "Code Runner Lite",
      main: "./out/extension.js",
      contributes: { commands: [{ command: "runner.run", title: "Run Code" }], snippets: [{ language: "python", path: "./snippets/py.json" }] },
    }),
    "out/extension.js": "exports.activate = () => {};",
    "snippets/py.json": json({ Main: { prefix: "ifmain", body: 'if __name__ == "__main__":\n    $0' } }),
  },
};

/** Stand-ins for the view's recommended list (declarative colour themes). */
const RECOMMENDED = ["github.github-vscode-theme", "dracula-theme.theme-dracula", "akamud.vscode-theme-onedark", "pkief.material-icon-theme", "vscode-icons-team.vscode-icons", "catppuccin.catppuccin-vsc-icons"].map(
  (id): Fixture => {
    const [namespace, name] = id.split(".");
    return { namespace, name, displayName: `Recommended ${name}`, description: "A recommended extension.", downloads: 1000, files: { "package.json": json({ name, publisher: namespace, version: "1.0.0" }) } };
  },
);

const FIXTURES = [OWL_THEME, OWL_ICONS, RUNNER, ...RECOMMENDED];

function version(f: Fixture) {
  return (JSON.parse(f.files["package.json"] as string) as { version: string }).version;
}

function galleryJson(f: Fixture) {
  const v = version(f);
  const base = `${API}/${f.namespace}/${f.name}/${v}/file`;
  return {
    namespace: f.namespace,
    name: f.name,
    version: v,
    displayName: f.displayName,
    description: f.description,
    downloadCount: f.downloads,
    averageRating: f.rating,
    reviewCount: f.rating ? 10 : 0,
    verified: f.namespace === "owlco",
    namespaceDisplayName: f.namespace === "owlco" ? "Owl Co" : f.namespace,
    timestamp: "2026-09-01T10:00:00Z",
    categories: ["Themes"],
    license: "MIT",
    files: {
      download: `${base}/${f.namespace}.${f.name}-${v}.vsix`,
      manifest: `${base}/package.json`,
      ...(f.files["README.md"] ? { readme: `${base}/README.md` } : {}),
      ...(f.files["icon.png"] ? { icon: `${base}/icon.png` } : {}),
    },
  };
}

/** Requests the page made to the mocked registry (to prove nothing else was contacted). */
async function mockOpenVsx(page: Page) {
  const seen: string[] = [];
  await page.route("https://open-vsx.org/**", async (route: Route) => {
    const url = new URL(route.request().url());
    seen.push(url.pathname + url.search);
    const cors = { "access-control-allow-origin": "*" };
    if (url.pathname === "/api/-/search") {
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      const hits = FIXTURES.filter((f) => q && `${f.displayName} ${f.name} ${f.description}`.toLowerCase().includes(q));
      return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify({ offset: 0, totalSize: hits.length, extensions: hits.map(galleryJson) }) });
    }
    const file = /^\/api\/([^/]+)\/([^/]+)\/([^/]+)\/file\/(.+)$/.exec(url.pathname);
    if (file) {
      const f = FIXTURES.find((x) => x.namespace === file[1] && x.name === file[2]);
      if (f && file[4].endsWith(".vsix")) return route.fulfill({ headers: cors, contentType: "application/octet-stream", body: vsix(f.files) });
      const content = f?.files[decodeURIComponent(file[4])];
      if (content !== undefined) return route.fulfill({ headers: cors, body: typeof content === "string" ? content : content });
      return route.fulfill({ status: 404, headers: cors, body: "not found" });
    }
    const details = /^\/api\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const f = details && FIXTURES.find((x) => x.namespace === details[1] && x.name === details[2]);
    if (f) return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(galleryJson(f)) });
    return route.fulfill({ status: 404, headers: cors, contentType: "application/json", body: JSON.stringify({ error: "Extension not found" }) });
  });
  return seen;
}

const view = (page: Page) => page.locator(".tm-sidebar");
const row = (page: Page, id: string) => view(page).locator(`.tm-ext-row[data-ext-id="${id}"]`);
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

async function search(page: Page, q: string) {
  const box = view(page).getByRole("searchbox", { name: "Search Extensions in Open VSX" });
  await box.fill(q);
}

async function install(page: Page, q: string, id: string) {
  await search(page, q);
  await row(page, id).getByRole("button", { name: "Install" }).click();
  await expect(row(page, id).getByRole("button", { name: "Manage" })).toBeVisible({ timeout: 15000 });
}

/** Opens the Extensions view once the workbench is up. */
async function openExtensions(page: Page) {
  await page.getByRole("tab", { name: /^Extensions/ }).click();
  await expect(view(page).getByRole("searchbox")).toBeVisible();
}

async function pickTheme(page: Page, label: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("ControlOrMeta+t");
  await page.keyboard.type(label);
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  // Clear once per test, not on every navigation (the exam test reloads the page).
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("tm-e2e-cleared")) {
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem("tm-e2e-cleared", "1");
    }
  });
});

test("Extensions view: installed and recommended, marketplace search with stats", async ({ page }) => {
  const seen = await mockOpenVsx(page);
  await page.goto("/");
  await page.getByRole("tab", { name: /^Extensions/ }).click();
  await expect(view(page).locator("h2")).toHaveText("Extensions");
  const installed = view(page).getByRole("region", { name: "Installed" });
  await expect(installed).toContainText("No extensions installed");
  const recommended = view(page).getByRole("list", { name: "Recommended" });
  await expect(recommended.locator(".tm-ext-row")).toHaveCount(6);

  await search(page, "owl");
  await expect(view(page).locator(".tm-ext-row")).toHaveCount(2);
  const owl = row(page, "owlco.owl-midnight");
  await expect(owl.locator(".tm-ext-name")).toHaveText("Owl Midnight");
  await expect(owl.locator(".tm-ext-publisher")).toHaveText("Owl Co");
  await expect(owl.locator(".tm-ext-verified")).toBeVisible();
  await expect(owl.locator(".tm-ext-stat").first()).toHaveText("12K");
  await expect(owl.locator(".tm-ext-stat").nth(1)).toHaveText("4.5");
  await expect(owl.locator("img.tm-ext-icon")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await search(page, "nothing-matches-this");
  await expect(view(page)).toContainText("No extensions found.");
  // Only the (mocked) registry was contacted, through its API.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((p) => p.startsWith("/api/"))).toBe(true);

  // ⇧⌘X focuses the view's search box.
  await page.keyboard.press("ControlOrMeta+Shift+x");
  await expect(view(page).getByRole("searchbox")).toBeFocused();
});

test("installs a theme + language extension: colour theme picker, TextMate grammar, snippets, details editor", async ({ page }) => {
  await mockOpenVsx(page);
  await page.goto("/");
  await openExtensions(page);
  await install(page, "owl", "owlco.owl-midnight");
  await expect(page.locator(".tm-toast", { hasText: "Owl Midnight contributes a color theme." })).toBeVisible();

  // The theme is in Preferences: Color Theme, among the dark themes, and recolours the workbench.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("ControlOrMeta+t");
  await page.keyboard.type("Owl");
  await expect(page.locator(".tm-qi-item", { hasText: "Owl Midnight" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-root")).toHaveAttribute("data-color-theme", "ext:owlco.owl-midnight:Owl Midnight");
  await expect(page.locator(".tm-activitybar")).toHaveCSS("background-color", rgb("#0B2942"));
  await expect(page.locator(".tm-sidebar")).toHaveCSS("background-color", rgb("#011628"));

  // A .owl file gets the Owl language and grammar, coloured by the theme.
  await page.evaluate(() => (window as unknown as { __TMCODE_DEBUG__: { externalWrite(p: string, c: string): Promise<void> } }).__TMCODE_DEBUG__.externalWrite("night.owl", "hoot softly # the moon\n"));
  await page.getByRole("tab", { name: /^Explorer/ }).click();
  await page.locator('.tm-explorer [data-path="night.owl"]').dblclick();
  await expect(page.locator(".tm-statusbar")).toContainText("Owl");
  const hoot = page.locator(".monaco-editor .view-lines span span", { hasText: /^hoot$/ }).first();
  await expect.poll(() => hoot.evaluate((el) => getComputedStyle(el).color), { timeout: 15000 }).toBe(rgb("#C792EA"));
  await expect(page.locator(".monaco-editor .monaco-editor-background").first()).toHaveCSS("background-color", rgb("#011627"));

  // Snippets from the extension.
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("nightfl");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".monaco-editor .suggest-widget")).toContainText("nightflight");

  // Details editor: README (with its image), features, buttons.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Shift+x");
  await search(page, "@installed");
  await row(page, "owlco.owl-midnight").click();
  await expect(page.locator(".tm-tab.is-active")).toContainText("Extension: Owl Midnight");
  const editor = page.locator(".tm-ext-editor");
  await expect(editor.locator(".tm-ext-title")).toHaveText("Owl Midnight");
  await expect(editor.locator(".tm-ext-readme h1")).toHaveText("Owl Midnight");
  await expect(editor.locator(".tm-ext-readme img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(editor.getByRole("button", { name: "Uninstall" })).toBeVisible();
  await expect(editor.locator(".tm-ext-notice.is-warning")).toHaveCount(0);
  await editor.getByRole("tab", { name: "Features" }).click();
  await expect(editor.locator(".tm-ext-features")).toContainText("Color Themes");
  await expect(editor.locator(".tm-ext-features")).toContainText("owl: source.owl");

  // Disable: the theme goes away (Dark Modern), the grammar too; Enable brings them back.
  await editor.getByRole("button", { name: "Disable" }).click();
  await expect(page.locator(".tm-root")).toHaveAttribute("data-color-theme", "dark-modern");
  await editor.getByRole("button", { name: "Enable" }).click();
  await expect(page.locator(".tm-root")).toHaveAttribute("data-color-theme", "ext:owlco.owl-midnight:Owl Midnight");

  // Uninstall removes it from the picker.
  await editor.getByRole("button", { name: "Uninstall" }).click();
  await expect(editor.getByRole("button", { name: "Install" })).toBeVisible();
  await expect(page.locator(".tm-root")).toHaveAttribute("data-color-theme", "dark-modern");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("ControlOrMeta+t");
  await page.keyboard.type("Owl");
  await expect(page.locator(".tm-qi-item", { hasText: "Owl Midnight" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("file icon themes from extensions", async ({ page }) => {
  await mockOpenVsx(page);
  await page.goto("/");
  await openExtensions(page);
  await install(page, "owl", "owlco.owl-icons");
  await page.evaluate(() => (window as unknown as { __TMCODE_DEBUG__: { externalWrite(p: string, c: string): Promise<void> } }).__TMCODE_DEBUG__.externalWrite("night.owl", "hoot\n"));
  await page.keyboard.press("F1");
  await page.keyboard.type("File Icon Theme");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Owl Icons");
  await page.keyboard.press("Enter");
  await page.getByRole("tab", { name: /^Explorer/ }).click();
  const icon = page.locator('.tm-explorer [data-path="night.owl"] img.tm-themed-icon');
  await expect(icon).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
  // Another file gets the theme's default file icon.
  await expect(page.locator('.tm-explorer [data-path="main.py"] img.tm-themed-icon')).toBeVisible();
});

test("a Node-only extension in the browser build: installs for its declarative parts, says why its code cannot run", async ({ page }) => {
  await mockOpenVsx(page);
  await page.goto("/");
  await openExtensions(page);
  await search(page, "runner");
  await row(page, "runnerco.code-runner-lite").click();
  const editor = page.locator(".tm-ext-editor");
  // Known before installing, from the manifest on Open VSX.
  await expect(editor.locator(".tm-ext-notice.is-warning")).toContainText("needs Node.js, which only the TMCode desktop app provides");
  await editor.getByRole("button", { name: "Install" }).click();
  // Extension code runs as the user: a one-time notice on the first install of an extension with code.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("runs code on your computer");
  await dialog.getByRole("button", { name: "Trust and Enable" }).click();
  await expect(editor.getByRole("button", { name: "Uninstall" })).toBeVisible({ timeout: 15000 });
  await expect(editor.locator(".tm-ext-notice.is-warning")).toContainText("cannot run here");
  await expect(row(page, "runnerco.code-runner-lite").locator(".tm-ext-code-warning")).toBeVisible();
});

test("extensions are disabled in exam mode", async ({ page }) => {
  await mockOpenVsx(page);
  await page.goto("/");
  await openExtensions(page);
  await install(page, "owl", "owlco.owl-midnight");
  await pickTheme(page, "Owl Midnight");
  await expect(page.locator(".tm-root")).toHaveAttribute("data-color-theme", "ext:owlco.owl-midnight:Owl Midnight");
  // The install survives a reload of the tab (browser build: session storage).
  await page.reload();
  await expect(page.locator(".tm-root")).toHaveAttribute("data-color-theme", "ext:owlco.owl-midnight:Owl Midnight");

  // Start an exam (mock Task Mentor).
  await page.request.post(`${TM}/__test/reset`);
  const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
  await page.goto(`/?launch=${encodeURIComponent(deeplink)}`);
  await expect(page.locator(".tm-taskview-quiz")).toBeVisible({ timeout: 15000 });
  // No Extensions view, no ⇧⌘X, and the extension's theme is gone.
  await expect(page.getByRole("tab", { name: /^Extensions/ })).toHaveCount(0);
  await expect(page.locator(".tm-root")).not.toHaveAttribute("data-color-theme", /^ext:/);
  await page.keyboard.press("ControlOrMeta+Shift+x");
  await expect(page.locator(".tm-sidebar h2")).not.toHaveText("Extensions");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("ControlOrMeta+t");
  await page.keyboard.type("Owl");
  await expect(page.locator(".tm-qi-item", { hasText: "Owl Midnight" })).toHaveCount(0);
});
