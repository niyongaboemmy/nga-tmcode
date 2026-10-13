import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * The JavaScript Console under the desktop app's real Content Security Policy.
 * The browser build has no CSP, so the console worked there while the packaged app
 * refused it ("'unsafe-eval' is not an allowed source", importScripts NetworkError).
 * Here the page gets the CSP from tauri.conf.json, and the console's host page is
 * served (by the mock server) exactly as src-tauri/src/console.rs serves it.
 */

const MOCK_PORT = Number(process.env.MOCK_TM_PORT ?? 5099);
const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const appCsp = conf.app.security.csp as Record<string, string>;
// The dev server adds an inline React refresh preamble and a HMR socket; neither allows eval or blob: scripts.
const devExtra: Record<string, string> = { "script-src": "'unsafe-inline'", "connect-src": "ws: http://localhost:*" };
const csp = Object.entries(appCsp)
  .map(([k, v]) => `${k} ${v}${devExtra[k] ? ` ${devExtra[k]}` : ""}`)
  .join("; ");

// A page Playwright fulfils has no address space, so Chromium treats it as public and blocks its
// frames on localhost (Local Network Access); the app's own pages are local.
test.use({ launchOptions: async ({ browserName }, use) => use(browserName === "chromium" ? { args: ["--disable-features=LocalNetworkAccessChecks"] } : {}) });

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

async function desktopLike(page: Page, withHost: boolean) {
  await page.route(/^http:\/\/localhost:\d+\/(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": csp } });
  });
  await page.addInitScript(
    ([base, seeded]) => {
      if (window !== window.top) return;
      if (base) (window as unknown as { __TMCODE_CONSOLE_BASE__: string }).__TMCODE_CONSOLE_BASE__ = base;
      if (sessionStorage.getItem(seeded)) return;
      sessionStorage.setItem(seeded, "1");
      localStorage.clear();
    },
    [withHost ? `http://localhost:${MOCK_PORT}/__console` : "", "tmcode:e2e-seeded"] as const,
  );
  const violations: string[] = [];
  page.on("console", (m) => /Content Security Policy|unsafe-eval|NetworkError/.test(m.text()) && violations.push(m.text()));
  await page.goto("/");
  await expect(page.locator(".tm-explorer")).toBeVisible();
  return violations;
}

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
async function run(page: Page, path: string, content: string) {
  await externalWrite(page, path, content);
  if (!(await row(page, path).isVisible())) await row(page, path.split("/")[0]).click();
  await row(page, path).click();
  await expect(page.getByTestId("editor-run-button")).toHaveAttribute("aria-label", "Run in JavaScript Console");
  await page.getByTestId("editor-run-button").click();
  return page.getByTestId("js-console");
}

test("the app's CSP refuses a console worker started in the workbench itself (why the console has its own host)", async ({ page }) => {
  await desktopLike(page, false);
  const jsc = await run(page, "js/hello.js", "console.log('hi from the program');\n");
  await expect(jsc.locator(".tm-jsc-entry.is-system.is-error")).toContainText("Failed after");
  await expect(jsc).not.toContainText("hi from the program");
});

test("under the desktop CSP, programs run, the REPL evaluates, errors map to the file, and Stop works", async ({ page }) => {
  const violations = await desktopLike(page, true);
  const jsc = await run(
    page,
    "js/shapes.js",
    ["const circle = { name: 'Ada', tags: ['math', 'code'] };", "console.log('hello', circle);", "function area(shape) {", "  return shape.size.width * 2;", "}", "area({});", ""].join("\n"),
  );
  await expect(jsc).toContainText("hello {name: 'Ada', tags: Array(2)}");
  const error = jsc.locator(".tm-jsc-entry.is-error:not(.is-system)");
  await expect(error).toContainText("Uncaught TypeError");
  await expect(error.locator(".tm-jsv-link", { hasText: "js/shapes.js:4" }).first()).toBeVisible();
  // It runs in the host frame, not in the workbench.
  await expect(page.getByTestId("js-console-host")).toHaveAttribute("src", /\/__console\/host\.html\?net=1$/);

  // The REPL is eval: exactly what the app's CSP forbids.
  await page.locator(".tm-panel-tab", { hasText: "JavaScript Console" }).click();
  const input = page.getByTestId("js-console-input");
  await input.fill("circle.tags.length + 40");
  await input.press("Enter");
  await expect(jsc.locator(".tm-jsc-entry.is-result").last()).toHaveText("42");
  await input.fill("await new Promise((r) => setTimeout(() => r([1, 2, 3].map((n) => n * 2)), 10))");
  await input.press("Enter");
  await expect(jsc.locator(".tm-jsc-entry.is-result").last()).toContainText("(3) [2, 4, 6]");
  // Objects expand from the worker (round trip through the host).
  await input.fill("({ deep: { deeper: { deepest: 1 } } })");
  await input.press("Enter");
  await jsc.locator(".tm-jsc-entry.is-result").last().locator(".tm-jsv-head").first().click();
  await jsc.locator(".tm-jsv-head", { hasText: /^deep:/ }).click();
  await jsc.locator(".tm-jsv-head", { hasText: /^deeper/ }).click();
  await expect(jsc).toContainText("deepest: 1");

  // TypeScript with imports (bundled here, run there), errors mapped to the .ts source.
  await externalWrite(page, "ts/math.ts", "export const half = (n: number): number => {\n  if (n < 0) throw new RangeError('negative');\n  return n / 2;\n};\n");
  const tsc = await run(page, "ts/main.ts", "import { half } from './math';\nconst values: number[] = [8, 4];\nconsole.log(values.map(half));\nhalf(-1);\n");
  // The first TypeScript run loads esbuild-wasm, which can take several seconds in a cold WebKit.
  await expect(tsc).toContainText("(2) [4, 2]", { timeout: 30_000 });
  await expect(tsc.locator(".tm-jsc-entry.is-error:not(.is-system)")).toContainText("RangeError");
  await expect(tsc.locator(".tm-jsv-link", { hasText: "ts/math.ts:2" }).first()).toBeVisible();

  // A runaway program stops.
  await run(page, "js/loop.js", "console.log('start');\nwhile (true) {}\n");
  await expect(jsc).toContainText("start");
  await page.keyboard.press("Shift+F5");
  await expect(jsc).toContainText("Stopped");
  // …and the console works again afterwards.
  await page.locator(".tm-panel-tab", { hasText: "JavaScript Console" }).click();
  await input.fill("'still ' + 'alive'");
  await input.press("Enter");
  await expect(jsc.locator(".tm-jsc-entry.is-result").last()).toContainText("still alive");

  expect(violations).toEqual([]);
});

test("the console host's own CSP: network for practice, none in an exam", async ({ page }) => {
  await desktopLike(page, true);
  const probe = `fetch('http://localhost:${MOCK_PORT}/__test/state').then(() => console.log('net:on'), () => console.log('net:off'));\n`;
  const jsc = await run(page, "js/net.js", probe);
  await expect(jsc).toContainText("net:on");
  // The same page, as an exam gets it.
  const off = await page.evaluate(async (port) => {
    const f = document.createElement("iframe");
    f.src = `http://localhost:${port}/__console/host.html?net=0`;
    document.body.appendChild(f);
    const ready = new Promise((r) => addEventListener("message", (e) => e.source === f.contentWindow && e.data?.kind === "ready" && r(null)));
    await ready;
    const src = "fetch(location.origin === 'null' ? '' : 'http://localhost:" + port + "/__test/state').then(() => postMessage('on'), () => postMessage('off'));";
    const out = new Promise((r) => addEventListener("message", (e) => e.source === f.contentWindow && e.data?.kind === "message" && r(e.data.data)));
    f.contentWindow!.postMessage({ type: "spawn", source: src }, "*");
    return out;
  }, MOCK_PORT);
  expect(off).toBe("off");
});

test("a program finishes when nothing is left to run, like Node: timers, fetch, console.table, process.exit", async ({ page }) => {
  await desktopLike(page, true);
  const jsc = await run(
    page,
    "js/async.js",
    [
      "console.log('start');",
      "setTimeout(() => console.log('timer fired'), 300);",
      `fetch('http://localhost:${MOCK_PORT}/__test/state').then((r) => r.json()).then((s) => console.log('fetched', typeof s));`,
      "(async () => { await new Promise((r) => setTimeout(r, 150)); console.log('awaited'); })();",
      "console.table([{ name: 'Ada', score: 90 }, { name: 'Alan', score: 85 }]);",
      "",
    ].join("\n"),
  );
  await expect(jsc).toContainText("start");
  await expect(jsc).toContainText("│ (index) │  name  │ score │");
  await expect(jsc).toContainText("│    1    │ 'Alan' │  85   │");
  // Finished comes after every output, not when the first pass of the file ends.
  const system = jsc.locator(".tm-jsc-entry.is-system").last();
  await expect(system).toContainText(/Finished in \d+ ms/);
  const text = await jsc.innerText();
  for (const line of ["awaited", "fetched object", "timer fired"]) expect(text.indexOf(line)).toBeGreaterThan(-1);
  expect(text.indexOf("timer fired")).toBeLessThan(text.lastIndexOf("Finished in"));

  // An interval keeps it running until it is cleared; process.exit ends it with its code.
  await run(page, "js/interval.js", "let n = 0;\nconst id = setInterval(() => { console.log('tick', ++n); if (n === 3) { clearInterval(id); } }, 50);\n");
  await expect(jsc).toContainText("tick 3");
  await expect(jsc.locator(".tm-jsc-entry.is-system").last()).toContainText("Finished in");
  await run(page, "js/exit.js", "setTimeout(() => { console.log('bye'); process.exit(2); console.log('never'); }, 50);\nsetTimeout(() => console.log('never either'), 500);\n");
  await expect(jsc.locator(".tm-jsc-entry.is-system").last()).toContainText("process.exit(2)");
  await page.waitForTimeout(700);
  await expect(jsc).not.toContainText("never");

  // A failure in a callback fails the run, after the rest has run.
  await run(page, "js/late.js", "setTimeout(() => { null.x; }, 20);\nsetTimeout(() => console.log('still ran'), 60);\n");
  await expect(jsc.locator(".tm-jsc-entry.is-system").last()).toContainText("Failed after");
  await expect(jsc).toContainText("Uncaught TypeError");
  await expect(jsc).toContainText("still ran");

  // No page, so no dialogs: alert shows in the console, prompt explains where input works.
  await run(page, "js/dialogs.js", "alert('Hello!');\nconst name = prompt('Your name?');\n");
  await expect(jsc).toContainText("alert: Hello!");
  await expect(jsc).toContainText("prompt() and confirm() need a web page");
});
