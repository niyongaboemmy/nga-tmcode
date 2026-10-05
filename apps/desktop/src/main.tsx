import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  Workbench,
  createMemoryPlatform,
  executeCommand,
  initWorkbench,
  selfCheckWorkers,
  setWorkspace,
  startedWorkers,
  type Platform,
} from "@tmcode/workbench";

const inTauri = "__TAURI_INTERNALS__" in window;

/** Desktop: webview errors and a startup self-check go to the app log file (support diagnostics). */
async function wireDesktopLogging() {
  const log = await import("@tauri-apps/plugin-log");
  window.addEventListener("error", (e) => void log.error(`webview error: ${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => void log.error(`unhandled rejection: ${String(e.reason?.message ?? e.reason)}`));
  return log;
}

async function choosePlatform(): Promise<Platform> {
  if (inTauri) {
    const { createTauriPlatform } = await import("./platform/tauri");
    return createTauriPlatform();
  }
  return createMemoryPlatform();
}

async function boot() {
  const desktopLog = inTauri ? await wireDesktopLogging() : null;
  const platform = await choosePlatform();
  const params = new URLSearchParams(location.search);
  const dev = inTauri ? (await import("./platform/tauri")).devOptions : null;
  await initWorkbench(platform, { autoOpenLast: platform.kind === "desktop" && !dev?.workspace });
  if (dev?.workspace) {
    const ws = await platform.reopenFolder(dev.workspace);
    if (ws) await setWorkspace(ws);
  }
  // Browser builds open the in-memory demo project straight away (dev server, Playwright).
  if (platform.kind === "web" && params.get("empty") !== "1") {
    await setWorkspace({ name: "practice-project", root: "memory://practice-project" });
  }
  if (import.meta.env.DEV) {
    (window as unknown as { __TMCODE_DEBUG__: unknown }).__TMCODE_DEBUG__ = { startedWorkers };
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Workbench />
    </StrictMode>,
  );
  if (inTauri) {
    // macOS menu bar items run the same workbench commands as keys and the palette.
    const { listen } = await import("@tauri-apps/api/event");
    void listen<string>("menu", (e) => executeCommand(e.payload));
  }
  if (desktopLog && dev?.selftest) {
    const { runSelfTest } = await import("./selftest");
    setTimeout(() => void runSelfTest(platform, (m) => void desktopLog.info(m)), 2500);
  }
  if (desktopLog) {
    // Self-check: Monaco's workers must run off the main thread in WKWebView / WebView2 (plan spike S1).
    setTimeout(async () => {
      void desktopLog.info(`workbench ready; ua=${navigator.userAgent}; monaco workers ${await selfCheckWorkers()}`);
    }, 1500);
  }
}

void boot();
