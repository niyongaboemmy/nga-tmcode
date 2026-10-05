import { useEffect, useMemo, useRef, useState } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import "@vscode/codicons/dist/codicon.css";
import "./styles/theme.css";
import "./styles/workbench.css";
import { registerBuiltinCommands } from "./commands/builtin";
import { KeybindingResolver } from "./commands/registry";
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
import "./extensions/monacoContributions";
import { ActivityBar } from "./parts/ActivityBar";
import { EditorGroupView } from "./parts/editor/EditorGroupView";
import { Panel } from "./parts/panel/Panel";
import { SideBar } from "./parts/SideBar";
import { StatusBar } from "./parts/StatusBar";
import { TitleBar } from "./parts/TitleBar";
import { getPlatform, useWorkbench } from "./state/store";
import { ContextMenu, Dialog, Notifications } from "./widgets/Overlays";
import { QuickInput } from "./widgets/QuickInput";
import { ExamOverlay } from "./exam/ExamViews";

/**
 * Editor groups side by side. Always one Allotment with a stable key per group,
 * so splitting or closing a group never remounts (and re-lays-out) the others.
 */
function EditorArea() {
  const groups = useWorkbench((s) => s.groups);
  return (
    <Allotment className="tm-editor-groups">
      {groups.map((g) => (
        <Allotment.Pane key={g.id} minSize={180}>
          <EditorGroupView group={g} single={groups.length === 1} />
        </Allotment.Pane>
      ))}
    </Allotment>
  );
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
  const blocking = useWorkbench((s) => !!s.dialog || !!s.quickInput);
  const [chord, setChord] = useState<string | null>(null);
  const [focused, setFocused] = useState(true);
  const platform = getPlatform();
  const resolver = useMemo(() => new KeybindingResolver(platform.os, setChord), [platform.os]);
  const blockingRef = useRef(blocking);
  blockingRef.current = blocking;

  useEffect(() => {
    registerBuiltinCommands();
    wireDocuments();
    wireRunServices();
    startAutoUpdates();
    const unwatch = platform.watch?.((paths) => void applyExternalChanges(paths));
    return () => {
      stopAutoUpdates();
      unwatch?.();
    };
  }, [platform]);

  // Size class for responsive layout; very narrow windows hide the side bar once.
  const viewport = useWorkbench((s) => s.viewport);
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
    const onKey = (e: KeyboardEvent) => {
      if (blockingRef.current || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      // Monaco owns chords like ⌘K ⌘C while it has focus; our chord commands are bound inside it.
      const inMonaco = !!target?.closest(".monaco-editor");
      const inTerminal = !!target?.closest(".xterm");
      if (inTerminal && !(e.metaKey || e.ctrlKey || e.key === "F1")) return;
      if (inMonaco && (e.metaKey || e.ctrlKey) && e.code === "KeyK") return;
      const r = resolver.handle(e);
      if (r !== "none") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [resolver]);

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
      onContextMenu={(e) => {
        // No browser context menu anywhere in the workbench (Monaco and inputs bring their own).
        if (!(e.target as HTMLElement).closest(".monaco-editor, input, textarea, .xterm")) e.preventDefault();
      }}
    >
      <TitleBar focused={focused} />
      <div className="tm-main">
        <ActivityBar />
        <Allotment className="tm-split" proportionalLayout={false}>
          <Allotment.Pane minSize={170} preferredSize={viewport === "sm" ? 220 : 260} maxSize={720} visible={sidebarVisible} snap>
            <SideBar />
          </Allotment.Pane>
          <Allotment.Pane minSize={220}>
            <Allotment vertical className="tm-split" proportionalLayout={false}>
              <Allotment.Pane minSize={120} visible={!panelMaximized}>
                <main className="tm-editor-area" aria-label="Editor">
                  <EditorArea />
                </main>
              </Allotment.Pane>
              <Allotment.Pane minSize={100} preferredSize={260} visible={panelVisible} snap>
                <Panel />
              </Allotment.Pane>
            </Allotment>
          </Allotment.Pane>
        </Allotment>
      </div>
      <StatusBar chord={chord} />
      <QuickInput />
      <ContextMenu />
      <Dialog />
      <ExamOverlay />
      <Notifications />
    </div>
  );
}
