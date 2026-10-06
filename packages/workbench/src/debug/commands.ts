import { registerCommand } from "../commands/registry";
import { codeEditorFor } from "../monaco/editors";
import { activeFilePath, getPlatform, revealView, showPanel, togglePanel, useWorkbench, workbench } from "../state/store";
import { runFile } from "../run/runService";
import { showInputBox } from "../widgets/QuickPick";
import { pickValue } from "./pick";
import {
  addConfiguration,
  continueExecution,
  debugAllowed,
  isDebugging,
  pauseExecution,
  pickConfiguration,
  removeAllBreakpoints,
  restartDebugging,
  runWithoutDebugging,
  showInstallGuide,
  splitArgs,
  startDebugging,
  startOrContinue,
  stepInto,
  stepOut,
  stepOver,
  stopDebugging,
  toggleBreakpoint,
  useDebug,
} from "./debugService";
import { editBreakpointCondition } from "./editorContrib";
import { GUIDES } from "./installGuide";

const phase = () => useDebug.getState().phase;
const stopped = () => phase() === "stopped";
const hasHost = () => !!getPlatform().debug;
const cursorLine = () => codeEditorFor(workbench.get().activeGroup)?.getPosition()?.lineNumber ?? null;

/**
 * Run and Debug commands with VS Code's ids and keybindings. Registered before
 * the Run commands so that, while debugging, F5 / Shift+F5 reach the debugger.
 */
export function registerDebugCommands() {
  // F5 is one key with three meanings (VS Code): Continue, Start Debugging, or (no debugger for this file) Run.
  registerCommand({
    id: "tmcode.f5",
    title: "Start Debugging or Run",
    category: "Run",
    hidden: true,
    keybinding: "f5",
    enabled: () => stopped() || (phase() === "inactive" && (!!activeFilePath() || (debugAllowed() && useDebug.getState().configs.length > 0))),
    run: startOrContinue,
  });
  registerCommand({
    id: "workbench.action.debug.start",
    title: "Start Debugging",
    category: "Debug",
    enabled: () => debugAllowed() && hasHost() && phase() === "inactive",
    run: () => startDebugging(),
  });
  registerCommand({ id: "workbench.action.debug.run", title: "Run Without Debugging", category: "Debug", enabled: () => !!activeFilePath(), run: runWithoutDebugging });
  registerCommand({
    id: "workbench.action.debug.selectandstart",
    title: "Select and Start Debugging",
    category: "Debug",
    enabled: () => debugAllowed() && hasHost() && phase() === "inactive",
    run: () => pickConfiguration(true),
  });
  registerCommand({ id: "workbench.action.debug.continue", title: "Continue", category: "Debug", enabled: stopped, run: continueExecution });
  registerCommand({ id: "workbench.action.debug.pause", title: "Pause", category: "Debug", keybinding: "f6", enabled: () => phase() === "running", run: pauseExecution });
  registerCommand({ id: "workbench.action.debug.stepOver", title: "Step Over", category: "Debug", keybinding: "f10", enabled: stopped, run: stepOver });
  registerCommand({ id: "workbench.action.debug.stepInto", title: "Step Into", category: "Debug", keybinding: "f11", enabled: stopped, run: stepInto });
  registerCommand({ id: "workbench.action.debug.stepOut", title: "Step Out", category: "Debug", keybinding: "shift+f11", enabled: stopped, run: stepOut });
  registerCommand({ id: "workbench.action.debug.restart", title: "Restart", category: "Debug", keybinding: "mod+shift+f5", enabled: isDebugging, run: restartDebugging });
  registerCommand({ id: "workbench.action.debug.stop", title: "Stop", category: "Debug", keybinding: "shift+f5", enabled: isDebugging, run: stopDebugging });
  registerCommand({
    id: "editor.debug.action.toggleBreakpoint",
    title: "Toggle Breakpoint",
    category: "Debug",
    keybinding: "f9",
    enabled: () => debugAllowed() && !!activeFilePath(),
    run: () => {
      const path = activeFilePath();
      const line = cursorLine();
      if (path && line) toggleBreakpoint(path, line);
    },
  });
  registerCommand({
    id: "editor.debug.action.conditionalBreakpoint",
    title: "Add Conditional Breakpoint...",
    category: "Debug",
    enabled: () => debugAllowed() && !!activeFilePath(),
    run: () => {
      const path = activeFilePath();
      const line = cursorLine();
      if (path && line) void editBreakpointCondition(path, line, "condition");
    },
  });
  registerCommand({
    id: "editor.debug.action.addLogPoint",
    title: "Add Logpoint...",
    category: "Debug",
    enabled: () => debugAllowed() && !!activeFilePath(),
    run: () => {
      const path = activeFilePath();
      const line = cursorLine();
      if (path && line) void editBreakpointCondition(path, line, "logMessage");
    },
  });
  registerCommand({ id: "workbench.debug.viewlet.action.removeAllBreakpoints", title: "Remove All Breakpoints", category: "Debug", run: removeAllBreakpoints });
  registerCommand({ id: "debug.addConfiguration", title: "Add Configuration...", category: "Debug", enabled: () => debugAllowed() && !!useWorkbench.getState().workspace, run: addConfiguration });
  registerCommand({ id: "workbench.view.debug", title: "Show Run and Debug", category: "View", keybinding: "mod+shift+d", enabled: debugAllowed, run: () => revealView("debug") });
  registerCommand({
    id: "workbench.debug.action.toggleRepl",
    title: "Debug Console",
    category: "View",
    keybinding: "mod+shift+y",
    run: () => {
      const s = useWorkbench.getState();
      if (s.panelVisible && s.activePanel === "debugConsole") togglePanel(false);
      else showPanel("debugConsole");
    },
  });
  registerCommand({
    id: "tmcode.runWithArgs",
    title: "Run with Arguments...",
    category: "Run",
    enabled: () => !!activeFilePath(),
    run: async () => {
      const path = activeFilePath();
      if (!path) return;
      const text = await showInputBox({ prompt: "Command Line Arguments", placeholder: "Enter the arguments, separated by spaces", value: (useWorkbench.getState().run.args ?? []).join(" ") });
      if (text !== undefined) await runFile(path, { args: splitArgs(text) });
    },
  });
  registerCommand({
    id: "tmcode.installGuide",
    title: "How to Install a Language...",
    category: "Run",
    run: async () => {
      const id = await pickValue(
        GUIDES.map((g) => ({ label: g.language, description: g.summary, icon: g.icon, value: g.id })),
        { placeholder: "Select a language to see how to install it" },
      );
      if (id) showInstallGuide(id);
    },
  });
}
