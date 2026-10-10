import { useActivity } from "./state/activity";
import { useEffect, useMemo, useRef, useState } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import "@vscode/codicons/dist/codicon.css";
import "./styles/theme.css";
import "./styles/workbench.css";
import { registerBuiltinCommands, wirePaletteAndMenus } from "./commands/builtin";
import { registerFilesSearchCommands } from "./parts/editorStatus";

import { registerDeveloperCommands } from "./commands/developer";
import { registerProjectCommands } from "./projects/commands";
import { wireProjects } from "./projects/service";
import { toggleZenMode, useZen } from "./state/zen";
import { acquireTypes, enableEmmet, enablePrettier, resetProjectConfig } from "./monaco/languageServices";
import { setupMonaco } from "./monaco/setup";
import { installFormatterSelection, registerFormatterActions } from "./monaco/formatters";
import { KeybindingResolver, canonical, chordOf } from "./commands/registry";
import { isBrowserReservedKey, WheelZoom } from "./commands/reservedKeys";
import { registerVsCodeCommands } from "./commands/vscodeCommands";
import { wireNotificationCenter } from "./state/notificationCenter";
import { loadUserSnippets } from "./snippets/userSnippets";
import { NotificationCenter } from "./widgets/NotificationCenter";
import { zoomIn, zoomOut } from "./state/windowZoom";
import { inExam } from "./exam/state";
import { wireDocuments } from "./monaco/documents";
import { wireRunServices } from "./run/wire";
import { applyExternalChanges } from "./monaco/external";
import { startAutoUpdates, stopAutoUpdates } from "./update/updateService";
import { activeFilePath } from "./state/store";
import { basename } from "./util/paths";
import { applyTheme, useThemes } from "./themes/themeService";
import { applyIconTheme, useIconTheme } from "./themes/iconThemes";
import { startupHooks } from "./state/store";
import { loadInstalledExtensions } from "./extensions/service";
// ── extension host (feat/exthost) ──
import { initExtensionHost } from "./exthost/hostService";
import { registerExtHostCommands } from "./exthost/commands";
import "./extensions/monacoContributions";
import { ActivityBar } from "./parts/ActivityBar";
import { EditorGrid } from "./parts/editor/EditorGrid";
import { registerWorkbenchExtras } from "./layout/commands";
import { Panel } from "./parts/panel/Panel";
import { SideBar } from "./parts/SideBar";
import { WebviewLayer } from "./exthost/views/WebviewSlot";
import { StatusBar } from "./parts/StatusBar";
import { TitleBar } from "./parts/TitleBar";
import { getPlatform, useWorkbench } from "./state/store";
import { ContextMenu, Dialog, Notifications } from "./widgets/Overlays";
import { QuickInput } from "./widgets/QuickInput";
import { ExamOverlay } from "./exam/ExamViews";
// ── git (scm/*) ──
import { wireScm } from "./scm/commands";
import { QuickPickHost, useQuickPick } from "./widgets/QuickPick";
import { TooltipHost } from "./widgets/Tooltip";
// ── Run and Debug ──
import { wireDebugServices } from "./debug/debugService";
import { DebugToolbar } from "./debug/DebugToolbar";
// ── end Run and Debug ──

/** Editor groups in rows and columns (parts/editor/EditorGrid). */
function EditorArea() {
  return <EditorGrid />;
}

// Colour and icon themes (and the extensions that contribute them) load before the first paint.
startupHooks.beforeReady = async () => {
  // A slow or broken extension store must not hold the workbench back.
  await Promise.race([loadInstalledExtensions(), new Promise((r) => setTimeout(r, 3000))]);
  const s = useWorkbench.getState().settings;
  await Promise.all([applyTheme(s["workbench.colorTheme"]), applyIconTheme(s["workbench.iconTheme"])]);
};

/**
 * The whole VS Code-style workbench. The host calls `initWorkbench(platform)`
 * before rendering this.
 */
export function Workbench() {
  const ready = useWorkbench((s) => s.ready);
  const themeId = useWorkbench((s) => s.previewTheme ?? s.settings["workbench.colorTheme"]);
  const themesVersion = useThemes((s) => s.version);
  const activeTheme = useThemes((s) => s.active);
  const iconThemeId = useWorkbench((s) => s.previewIconTheme ?? s.settings["workbench.iconTheme"]);
  const iconThemesVersion = useIconTheme((s) => s.version);
  const theme = activeTheme?.cssBase ?? "dark-modern";
  const dark = activeTheme ? activeTheme.uiTheme === "vs-dark" || activeTheme.uiTheme === "hc-black" : true;
  const reduceMotion = useWorkbench((s) => s.settings["workbench.reduceMotion"]);
  const sidebarVisible = useWorkbench((s) => s.sidebarVisible);
  const panelVisible = useWorkbench((s) => s.panelVisible);
  const panelMaximized = useWorkbench((s) => s.panelMaximized);
  // View › Appearance: hidden activity / status bar, side bar on the right (never hidden in exams).
  const examLayout = useWorkbench((s) => s.policy.mode !== "practice");
  const activityBarHidden = useWorkbench((s) => !s.settings["workbench.activityBar.visible"]) && !examLayout;
  const statusBarHidden = useWorkbench((s) => !s.settings["workbench.statusBar.visible"]) && !examLayout;
  const sideBarRight = useWorkbench((s) => s.settings["workbench.sideBar.location"] === "right");
  const quickPick = useQuickPick((s) => !!s.request);
  const blocking = useWorkbench((s) => !!s.dialog || !!s.quickInput) || quickPick;
  const [chord, setChord] = useState<string | null>(null);
  const [focused, setFocused] = useState(true);
  const platform = getPlatform();
  const resolver = useMemo(() => new KeybindingResolver(platform.os, setChord), [platform.os]);
  const blockingRef = useRef(blocking);
  blockingRef.current = blocking;

  useEffect(() => {
    registerBuiltinCommands();
    registerVsCodeCommands();
    wireNotificationCenter();
    void loadUserSnippets();
    registerFilesSearchCommands();
    registerWorkbenchExtras();
    registerDeveloperCommands();
    registerProjectCommands();
    wireProjects();
    setupMonaco();
    enableEmmet("standard"); // TextMate tokens (textmate/monacoTm.ts), not Monarch
    enablePrettier();
    installFormatterSelection();
    registerFormatterActions();
    wireDocuments();
    wireRunServices();
    wireScm();
    wireDebugServices();
    registerExtHostCommands();
    initExtensionHost();
    startAutoUpdates();
    wirePaletteAndMenus();
    // After `npm install` (lock file) or a config edit, re-read types and .prettierrc.
    let projectTimer: ReturnType<typeof setTimeout> | undefined;
    const unwatch = platform.watch?.((paths) => {
      void applyExternalChanges(paths);
      if (paths.some((p) => /^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|tsconfig\.json|\.prettierrc(\.json)?)$/.test(p))) {
        clearTimeout(projectTimer);
        projectTimer = setTimeout(() => {
          resetProjectConfig();
          void acquireTypes().catch(() => {});
        }, 1500);
      }
    });
    return () => {
      stopAutoUpdates();
      unwatch?.();
    };
  }, [platform]);

  // Size class for responsive layout; very narrow windows hide the side bar once.
  const viewport = useWorkbench((s) => s.viewport);
  const zen = useZen((s) => s.on);
  useEffect(() => {
    const classify = (w: number) => (w < 640 ? "xs" : w < 900 ? "sm" : w < 1200 ? "md" : "lg");
    const update = () => {
      const next = classify(window.innerWidth);
      const prev = useWorkbench.getState().viewport;
      if (next === prev) return;
      useWorkbench.setState({ viewport: next });
      if (next === "xs" && useWorkbench.getState().sidebarVisible) useWorkbench.setState({ sidebarVisible: false });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // OS window title, VS Code style: "file — folder — TMCode".
  const titleFile = useWorkbench((s) => activeFilePath(s));
  const titleFolder = useWorkbench((s) => s.workspace?.name ?? null);
  const titleDirty = useWorkbench((s) => (titleFile ? !!s.dirty[titleFile] : false));
  useEffect(() => {
    const parts = [titleFile ? `${titleDirty ? "● " : ""}${basename(titleFile)}` : null, titleFolder, "TMCode"].filter(Boolean);
    document.title = parts.join(" — ");
    platform.setTitle?.(document.title);
  }, [titleFile, titleFolder, titleDirty, platform]);

  useEffect(() => {
    void applyTheme(themeId);
  }, [themeId, themesVersion]);
  useEffect(() => {
    void applyIconTheme(iconThemeId);
  }, [iconThemeId, iconThemesVersion]);

  useEffect(() => {
    platform.setNativeTheme?.(dark ? "dark" : "light");
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark, platform]);

  // Global keybindings, in the capture phase so they win over focused widgets.
  useEffect(() => {
    const os = platform.os;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      // Monaco owns chords like ⌘K ⌘C while it has focus; our chord commands are bound inside it.
      const inMonaco = !!target?.closest?.(".monaco-editor");
      const inTerminal = !!target?.closest?.(".xterm");
      const inInput = !inMonaco && !inTerminal && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || !!target?.isContentEditable);
      const chord = chordOf(e, os);
      const c = chord ? canonical(chord, os) : null;
      // Reload, print, find bar, back…: the webview's own keys never act, even when no command takes them.
      const reserved = !!c && isBrowserReservedKey(c, os, { inEditor: inMonaco, inInput, inTerminal, devtools: !!platform.shell?.toggleDevTools && !inExam() });
      const done = (r: "executed" | "chord" | "none") => {
        if (r !== "none") {
          e.preventDefault();
          e.stopPropagation();
        } else if (reserved) e.preventDefault();
      };
      if (blockingRef.current) return done("none");
      if (inTerminal && !(e.metaKey || e.ctrlKey || e.key === "F1")) return done("none");
      // The shell's reverse search (Ctrl+R) wins over Reload Window inside the terminal.
      if (inTerminal && os !== "mac" && c === "mod+r") return done("none");
      if (inMonaco && (e.metaKey || e.ctrlKey) && e.code === "KeyK") return done("none");
      done(resolver.handle(e));
    };
    // Ctrl+wheel (a pinch): window zoom steps, never the webview's page zoom.
    const wheelZoom = new WheelZoom((dir) => (dir > 0 ? zoomIn() : zoomOut()));
    const onWheel = (e: WheelEvent) => {
      // WebView2 / Chromium zoom the page on Ctrl+wheel; WKWebView doesn't (and a trackpad pinch must not zoom TMCode).
      if (!e.ctrlKey || os === "mac") return;
      e.preventDefault();
      wheelZoom.wheel(e.deltaY, performance.now());
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [resolver, platform]);

  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // A real project: its .prettierrc and the types of its installed packages.
  const workspaceRoot = useWorkbench((s) => s.workspace?.root);
  useEffect(() => {
    resetProjectConfig();
    if (!workspaceRoot) return;
    const t = setTimeout(() => void acquireTypes().catch(() => {}), 800);
    return () => clearTimeout(t);
  }, [workspaceRoot]);

  // Zen Mode: Escape twice leaves it, as in VS Code.
  useEffect(() => {
    if (!zen) return;
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const now = Date.now();
      if (now - last < 600) toggleZenMode(false);
      last = now;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zen]);

  // Theme colours as CSS variables over the closest hand-styled base (empty for Dark/Light Modern and HC).
  const themeStyle = activeTheme?.cssVars as React.CSSProperties | undefined;
  if (!ready) return <div className="tm-root tm-booting" data-theme={theme} style={themeStyle} />;

  return (
    <div
      className="tm-root"
      data-theme={theme}
      data-color-theme={activeTheme?.id}
      style={themeStyle}
      data-os={platform.os}
      data-platform={platform.kind}
      data-motion={reduceMotion ? "reduced" : "full"}
      data-size={viewport}
      data-zen={zen ? "on" : undefined}
      data-activitybar={activityBarHidden ? "hidden" : undefined}
      data-statusbar={statusBarHidden ? "hidden" : undefined}
      data-sidebar={sideBarRight ? "right" : "left"}
      onContextMenu={(e) => {
        // No browser context menu anywhere in the workbench (Monaco and inputs bring their own).
        if (!(e.target as HTMLElement).closest(".monaco-editor, input, textarea, .xterm")) e.preventDefault();
      }}
    >
      <TitleBar focused={focused} />
      <ProgressLine />
      <div className="tm-main">
        <ActivityBar />
        <Allotment key={sideBarRight ? "side-right" : "side-left"} className="tm-split" proportionalLayout={false}>
          {orderPanes(
            sideBarRight,
            <Allotment.Pane key="side" minSize={170} preferredSize={viewport === "sm" ? 220 : 260} maxSize={720} visible={sidebarVisible} snap>
              <SideBar />
            </Allotment.Pane>,
            <Allotment.Pane key="main" minSize={220}>
              <Allotment vertical className="tm-split" proportionalLayout={false}>
                <Allotment.Pane minSize={120} visible={!panelMaximized}>
                  <main className="tm-editor-area" aria-label="Editor">
                    <EditorArea />
                    <DebugToolbar />
                  </main>
                </Allotment.Pane>
                <Allotment.Pane minSize={100} preferredSize={260} visible={panelVisible} snap>
                  <Panel />
                </Allotment.Pane>
              </Allotment>
            </Allotment.Pane>,
          )}
        </Allotment>
      </div>
      {/* Extension webview iframes, over their slots (exthost/views/webviews.ts). */}
      <WebviewLayer />
      <StatusBar chord={chord} />
      <QuickInput />
      <QuickPickHost />
      <TooltipHost />
      <ContextMenu />
      <Dialog />
      <ExamOverlay />
      <Notifications />
      <NotificationCenter />
    </div>
  );
}

/** Side bar and editor panes, left to right (Toggle Primary Side Bar Position puts the side bar last). */
function orderPanes(sideRight: boolean, side: React.ReactElement, main: React.ReactElement) {
  return sideRight ? [main, side] : [side, main];
}

/** A thin running line under the title bar while anything is in flight (VS Code's progress bar). */
function ProgressLine() {
  const busy = useActivity((s) => s.running.length > 0);
  return <div className={`tm-progress-line ${busy ? "is-busy" : ""}`} role="progressbar" aria-hidden={!busy} aria-label="Working" data-testid="progress-line" />;
}
