import { registerCommand } from "./registry";
import { monaco } from "../monaco/setup";
import { codeEditorFor } from "../monaco/editors";
import { activeTerminal } from "../terminal/active";
import { configureDefaultFormatter, formatDocumentWith } from "../monaco/formatters";
import { activeFilePath, getPlatform, notify, openEditorInput, showPanel, useWorkbench, workbench } from "../state/store";
import { toggleZenMode, useZen } from "../state/zen";
import { pickAndRunTask } from "../tasks/service";
import { openBrowser } from "../terminal/browser";
import { clearCommandHistory, recentCommands } from "../terminal/history";
import { normalizeUrl } from "../parts/editor/BrowserEditor";
import { showQuickPick } from "../widgets/QuickPick";
import { inExam } from "../exam/state";
import { terminalAllowed as allowsTerminal } from "@tmcode/protocol";

const terminalAllowed = () => !!getPlatform().terminal && allowsTerminal(useWorkbench.getState().policy);
const previewable = () => /\.(md|markdown|svg)$/i.test(activeFilePath() ?? "");

/** Developer conveniences from VS Code: previews, Simple Browser, tasks, recent commands, Zen Mode. */
/** Edit › Select All (⌘A / Ctrl+A from the native menu): whatever has focus, as in VS Code. */
export function selectAllInFocus() {
  const el = document.activeElement as HTMLElement | null;
  if (el?.closest(".xterm")) {
    activeTerminal()?.selectAll();
    return "terminal";
  }
  const focused = monaco.editor.getEditors().find((e) => e.hasTextFocus());
  if (focused) {
    focused.trigger("menu", "editor.action.selectAll", null);
    return "editor";
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select();
    return "input";
  }
  if (el?.isContentEditable) {
    document.execCommand("selectAll");
    return "content";
  }
  // Nothing text-like focused (a list, the preview): the active editor, like VS Code's menu.
  const ed = codeEditorFor(workbench.get().activeGroup);
  if (ed) {
    ed.focus();
    ed.trigger("menu", "editor.action.selectAll", null);
    return "editor";
  }
  return null;
}

export function registerDeveloperCommands() {
  const activeCodeEditor = () => monaco.editor.getEditors().find((e) => e.hasTextFocus()) ?? codeEditorFor(workbench.get().activeGroup);
  registerCommand({
    id: "editor.action.formatDocument.multiple",
    title: "Format Document With...",
    category: "Editor",
    enabled: () => !!activeFilePath(),
    run: () => {
      const ed = activeCodeEditor();
      if (ed) return formatDocumentWith(ed);
    },
  });
  registerCommand({
    id: "editor.action.configureDefaultFormatter",
    title: "Configure Default Formatter...",
    category: "Editor",
    enabled: () => !!activeFilePath(),
    run: () => {
      const m = activeCodeEditor()?.getModel();
      if (m) return configureDefaultFormatter(m);
    },
  });
  registerCommand({ id: "workbench.action.selectAllInFocus", title: "Select All", category: "Edit", hidden: true, run: () => void selectAllInFocus() });
  registerCommand({
    id: "markdown.showPreviewToSide",
    title: "Open Preview to the Side",
    category: "Markdown",
    keybinding: "mod+k v",
    enabled: previewable,
    run: () => {
      const path = activeFilePath();
      if (!path) return;
      const svg = /\.svg$/i.test(path);
      openEditorInput({ kind: svg ? "image" : "markdown", id: `${svg ? "image" : "markdown"}:${path}`, path, preview: false }, { toSide: true });
    },
  });
  registerCommand({
    id: "markdown.showPreview",
    title: "Open Preview",
    category: "Markdown",
    keybinding: "mod+shift+v",
    enabled: previewable,
    run: () => {
      const path = activeFilePath();
      if (!path) return;
      const svg = /\.svg$/i.test(path);
      openEditorInput({ kind: svg ? "image" : "markdown", id: `${svg ? "image" : "markdown"}:${path}`, path, preview: false });
    },
  });

  registerCommand({
    id: "simpleBrowser.show",
    title: "Show",
    category: "Simple Browser",
    enabled: () => !inExam(),
    run: async () => {
      const suggestions = ["http://localhost:5173", "http://localhost:3000", "http://localhost:4200", "http://localhost:8080", "http://localhost:8000"];
      const pick = await showQuickPick({
        placeholder: "Enter a URL to open (e.g. localhost:3000)",
        items: suggestions.map((u) => ({ id: u, label: u.replace("http://", ""), description: hint(u), icon: "globe" })),
        dynamicItems: (v) => (v.trim() ? [{ id: `url:${v.trim()}`, label: v.trim(), description: "Open this address", icon: "link-external", alwaysShow: true }] : []),
        matchOnDescription: true,
      });
      if (!pick) return;
      const url = normalizeUrl(pick.id.startsWith("url:") ? pick.id.slice(4) : pick.id);
      if (url) openBrowser(url, { toSide: false });
      else notify("warning", `"${pick.label}" is not a valid URL.`);
    },
  });

  registerCommand({
    id: "workbench.action.tasks.runTask",
    title: "Run Task...",
    category: "Tasks",
    enabled: terminalAllowed,
    run: () => void pickAndRunTask(),
  });

  registerCommand({
    id: "workbench.action.terminal.runRecentCommand",
    title: "Run Recent Command...",
    category: "Terminal",
    keybinding: "ctrl+alt+r",
    enabled: terminalAllowed,
    run: async () => {
      const list = recentCommands();
      if (!list.length) {
        notify("info", "Commands you type in the terminal will appear here.");
        return;
      }
      const pick = await showQuickPick({
        placeholder: "Select a command to run (type to filter)",
        items: list.map((c, i) => ({ id: c, label: c, icon: "history", separator: i === 0 ? "recent commands" : undefined })),
      });
      if (!pick) return;
      showPanel("terminal");
      // The terminal may be mounting; let it subscribe first.
      setTimeout(() => window.dispatchEvent(new CustomEvent("tmcode:terminal-run", { detail: pick.id })), 0);
    },
  });
  registerCommand({
    id: "workbench.action.terminal.clearCommandHistory",
    title: "Clear Command History",
    category: "Terminal",
    run: () => {
      clearCommandHistory();
      notify("info", "Terminal command history cleared.");
    },
  });
  registerCommand({
    id: "workbench.action.terminal.focusFind",
    title: "Find in Terminal",
    category: "Terminal",
    enabled: terminalAllowed,
    run: () => {
      showPanel("terminal");
      setTimeout(() => window.dispatchEvent(new CustomEvent("tmcode:terminal-find")), 0);
    },
  });

  registerCommand({
    id: "workbench.action.toggleZenMode",
    title: "Toggle Zen Mode",
    category: "View",
    keybinding: "mod+k z",
    run: () => toggleZenMode(),
  });
  registerCommand({
    id: "workbench.action.exitZenMode",
    title: "Exit Zen Mode",
    category: "View",
    hidden: true,
    enabled: () => useZen.getState().on,
    run: () => toggleZenMode(false),
  });
}

function hint(url: string) {
  const port = url.split(":").pop();
  return { "5173": "Vite", "3000": "React / Next.js / Express", "4200": "Angular", "8080": "Spring Boot / Tomcat", "8000": "Django / FastAPI" }[port ?? ""] ?? "";
}
