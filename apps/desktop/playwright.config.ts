import { defineConfig, devices } from "@playwright/test";

// Overridable so several worktrees can run e2e at once.
const PORT = Number(process.env.TMCODE_DEV_PORT ?? 1430);
const MOCK_PORT = Number(process.env.MOCK_TM_PORT ?? 5099);

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
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1360, height: 820 } } },
  ],
});
