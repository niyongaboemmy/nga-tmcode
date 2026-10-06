import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  Workbench,
  createMemoryPlatform,
  executeCommand,
  initWorkbench,
  openPathFromOs,
  parseLaunchLink,
  parseProjectLink,
  openProjectLink,
  selfCheckWorkers,
  startExam,
  setWorkspace,
  startedWorkers,
  watchCspViolations,
  type Platform,
} from "@tmcode/workbench";

const inTauri = "__TAURI_INTERNALS__" in window;

/** Desktop: webview errors and a startup self-check go to the app log file (support diagnostics). */
async function wireDesktopLogging() {
  const log = await import("@tauri-apps/plugin-log");
  window.addEventListener("error", (e) => void log.error(`webview error: ${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => void log.error(`unhandled rejection: ${String(e.reason?.message ?? e.reason)}`));
  // A refused stylesheet or script silently breaks the UI (the 0.3.0 invisible-cursor bug), so say so.
  watchCspViolations((msg) => void log.warn(`content security policy: ${msg}`));
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
  const desktop = inTauri ? await import("./platform/tauri") : null;
  const dev = desktop?.devOptions ?? null;
  const launchPath = desktop?.launchPath ?? null;
  await initWorkbench(platform, { autoOpenLast: platform.kind === "desktop" && !dev?.workspace && !launchPath });
  if (launchPath) await openPathFromOs(launchPath);
  if (dev?.workspace) {
    const ws = await platform.reopenFolder(dev.workspace);
    if (ws) await setWorkspace(ws);
  }
  // Browser builds open the in-memory demo project straight away (dev server, Playwright).
  if (platform.kind === "web" && params.get("empty") !== "1" && !params.get("launch")) {
    await setWorkspace({ name: "practice-project", root: "memory://practice-project" });
  }
  if (import.meta.env.DEV) {
    const { simulateExternalWrite, runUiProbe } = await import("@tmcode/workbench");
    if (!inTauri) watchCspViolations();
    (window as unknown as { __TMCODE_DEBUG__: unknown }).__TMCODE_DEBUG__ = {
      startedWorkers,
      externalWrite: (path: string, content: string) => simulateExternalWrite(platform, path, content),
      uiProbe: runUiProbe,
    };
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Workbench />
    </StrictMode>,
  );
  // Browser build: ?launch=<tmcode:// link> starts an exam (dev server and e2e against a mock Task Mentor).
  const launch = params.get("launch");
  if (platform.kind === "web" && launch) {
    const link = parseLaunchLink(launch);
    if (link) void startExam(link.api, link.ticket);
  }
  const projectLink = params.get("project");
  if (platform.kind === "web" && projectLink) {
    const link = parseProjectLink(projectLink);
    if (link) setTimeout(() => void openProjectLink(link), 500);
  }
  if (inTauri) {
    // macOS menu bar items run the same workbench commands as keys and the palette.
    const { listen } = await import("@tauri-apps/api/event");
    void listen<string>("menu", (e) => executeCommand(e.payload));
    // A second `tmcode <path>`, or files dropped on the Dock icon / "Open With".
    await listen<string>("open-path", (e) => void openPathFromOs(e.payload));
    // Anything that arrived between startup and this listener.
    const { invoke } = await import("@tauri-apps/api/core");
    const late = await invoke<string[]>("take_pending_open").catch(() => []);
    if (late.length) void openPathFromOs(late[late.length - 1]);
    // tmcode://launch links: the one that started the app, and any that arrive while it runs.
    const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
    const open = (urls: string[] | null) => {
      // tmcode://project?id=…&api=… (Task Mentor "Open in TMCode") before exam launch links.
      const project = urls?.map(parseProjectLink).find(Boolean);
      if (project) return void openProjectLink(project);
      const link = urls?.map(parseLaunchLink).find(Boolean);
      if (link) void startExam(link.api, link.ticket);
    };
    open(await getCurrent().catch(() => null));
    void onOpenUrl(open);
  }
  if (desktopLog && dev?.launch) {
    const { runExamSelfTest } = await import("./selftest");
    setTimeout(() => void runExamSelfTest(dev.launch!, (m) => void desktopLog.info(m)), 2000);
  } else if (desktopLog && dev?.selftestUi) {
    const { runUiSelfTest } = await import("./selftest");
    setTimeout(() => void runUiSelfTest((m) => void desktopLog.info(m)), 2500);
  } else if (desktopLog && dev?.selftestExtensions) {
    const { runExtensionsSelfTest } = await import("./selftest");
    setTimeout(() => void runExtensionsSelfTest(platform, (m) => void desktopLog.info(m)), 3000);
  } else if (desktopLog && dev?.selftestExthost) {
    const { runExthostSelfTest } = await import("./selftest");
    setTimeout(() => void runExthostSelfTest(platform, (m) => void desktopLog.info(m)), 3000);
  } else if (desktopLog && dev?.selftestProjects) {
    const { runProjectsSelfTest } = await import("./selftest");
    setTimeout(() => void runProjectsSelfTest(platform, (m) => void desktopLog.info(m)), 3000);
  } else if (desktopLog && dev?.selftestGit) {
    const { runGitSelfTest } = await import("./selftest");
    setTimeout(() => void runGitSelfTest(platform, (m) => void desktopLog.info(m)), 2500);
  } else if (desktopLog && dev?.selftest) {
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
