import { defineConfig, devices } from "@playwright/test";

/**
 * The workbench runs in a plain browser with the in-memory platform, so the
 * UI is tested on Chromium (≈ WebView2 on Windows) and WebKit (≈ WKWebView on macOS).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1430",
    viewport: { width: 1360, height: 820 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1430",
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 820 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1360, height: 820 } } },
  ],
});
