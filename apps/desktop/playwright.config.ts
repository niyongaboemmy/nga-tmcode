import { defineConfig, devices } from "@playwright/test";

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
    baseURL: "http://localhost:1430",
    viewport: { width: 1360, height: 820 },
    trace: "retain-on-failure",
  },
  webServer: [
    { command: "npm run dev", url: "http://localhost:1430", reuseExistingServer: true, timeout: 60_000 },
    // Mock Task Mentor (docs/PROTOCOL.md v1) for the exam flow.
    { command: "node e2e/mock-tm.mjs", url: "http://localhost:5099/__test/reset", reuseExistingServer: true, timeout: 15_000, stderr: "pipe" },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 820 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1360, height: 820 } } },
  ],
});
