import { defineConfig, devices } from "@playwright/test";

// Overridable so several worktrees can run e2e at once.
const PORT = Number(process.env.TMCODE_DEV_PORT ?? 1430);
const MOCK_PORT = Number(process.env.MOCK_TM_PORT ?? 5099);

/**
 * "Desktop Safari" claims to be a Mac. On a Linux CI runner that makes Monaco
 * use ⌘ while Playwright's ControlOrMeta presses Ctrl, so key tests failed
 * there only. Off macOS, WebKit tells the truth about the host instead.
 */
const WEBKIT_UA: Record<string, string> = {
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  win32: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
};
const webkitUa = WEBKIT_UA[process.platform];

/**
 * The workbench runs in a plain browser with the in-memory platform, so the
 * UI is tested on Chromium (≈ WebView2 on Windows) and WebKit (≈ WKWebView on macOS).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  // One worker: the exam tests share one mock Task Mentor.
  workers: 1,
  // On CI a test that fails once is run again: a slow runner's timing slip shows as "flaky"
  // instead of blocking a release; a real failure fails twice. Locally, no retries.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1360, height: 820 },
    trace: "retain-on-failure",
  },
  webServer: [
    { command: "npm run dev", url: `http://localhost:${PORT}`, reuseExistingServer: true, timeout: 60_000, env: { TMCODE_DEV_PORT: String(PORT) } },
    // Mock Task Mentor (docs/PROTOCOL.md v1) for the exam flow.
    {
      command: "node e2e/mock-tm.mjs",
      url: `http://localhost:${MOCK_PORT}/__test/reset`,
      reuseExistingServer: true,
      timeout: 15_000,
      stderr: "pipe",
      env: { MOCK_TM_PORT: String(MOCK_PORT) },
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 820 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1360, height: 820 }, ...(webkitUa ? { userAgent: webkitUa } : {}) } },
  ],
});
