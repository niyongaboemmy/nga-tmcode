import { registerCommand } from "./registry";
import { activeFilePath, getPlatform, notify, openEditorInput, showPanel, useWorkbench } from "../state/store";
import { toggleZenMode, useZen } from "../state/zen";
import { pickAndRunTask } from "../tasks/service";
import { openBrowser } from "../terminal/browser";
import { clearCommandHistory, recentCommands } from "../terminal/history";
import { normalizeUrl } from "../parts/editor/BrowserEditor";
import { showQuickPick } from "../widgets/quickPick";
import { inExam } from "../exam/state";

const terminalAllowed = () => !!getPlatform().terminal && useWorkbench.getState().policy.terminal !== "off";
const previewable = () => /\.(md|markdown|svg)$/i.test(activeFilePath() ?? "");

/** Developer conveniences from VS Code: previews, Simple Browser, tasks, recent commands, Zen Mode. */
export function registerDeveloperCommands() {
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
      const pick = await showQuickPick(
        "Enter a URL to open (e.g. localhost:3000)",
        suggestions.map((u) => ({ id: u, label: u.replace("http://", ""), description: hint(u), icon: "globe" })),
        { allowCustom: true },
      );
      if (!pick) return;
      const url = normalizeUrl(pick.id === "custom" ? pick.label : pick.id);
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
      const pick = await showQuickPick(
        "Select a command to run (type to filter)",
        list.map((c) => ({ id: c, label: c, icon: "history", group: "recent commands" })),
      );
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
