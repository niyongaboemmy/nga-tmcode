import { registerCommand } from "../commands/registry";
import { monaco, setupMonaco } from "../monaco/setup";
import { notify, showAuxiliaryView } from "../state/store";
import { ask } from "./chat";
import { aiGate } from "./gate";
import { wireAiProject } from "./project";
import { wireAiTools } from "./tools";
import { wireInlineSuggestions } from "./inline";
import { loadAiSettings, refreshAiStatus, setAiSuggestions, useAi } from "./service";

/**
 * TMCode AI's commands: Ask (⌘I, the selection goes along), Explain / Fix / Write Tests on the
 * selection (also in the editor's context menu), suggestions on/off, and the model picker.
 * They run only when the AI gate allows (ai/gate.ts: Task Mentor's status, the exam policy).
 */

const allowed = () => aiGate().chat;
const completeAllowed = () => aiGate().complete;

function askNow(prompt: string) {
  showAuxiliaryView("chat");
  const gate = aiGate();
  if (!gate.chat) return notify("info", gate.message ?? "TMCode AI is off.");
  void ask(prompt);
}

let wired = false;
export function wireAi() {
  if (wired) return;
  wired = true;
  void loadAiSettings();
  wireAiProject();
  wireAiTools();
  wireInlineSuggestions();
  registerCommand({
    id: "tmcodeAI.ask",
    title: "Ask TMCode AI",
    category: "TMCode AI",
    keybinding: "mod+i",
    enabled: allowed,
    run: () => {
      showAuxiliaryView("chat");
      setTimeout(() => (document.querySelector('[data-testid="ai-input"]') as HTMLTextAreaElement | null)?.focus(), 50);
    },
  });
  registerCommand({ id: "tmcodeAI.explain", title: "Explain This Code", category: "TMCode AI", enabled: allowed, run: () => askNow("Explain what this code does, step by step.") });
  registerCommand({ id: "tmcodeAI.fix", title: "Fix This Code", category: "TMCode AI", enabled: allowed, run: () => askNow("Find the bugs in this code and show the fixed code.") });
  registerCommand({ id: "tmcodeAI.tests", title: "Write Tests for This Code", category: "TMCode AI", enabled: allowed, run: () => askNow("Write unit tests for this code.") });
  registerCommand({
    id: "tmcodeAI.toggleSuggestions",
    title: "Toggle Suggestions While Typing",
    category: "TMCode AI",
    enabled: completeAllowed,
    run: () => setAiSuggestions(!useAi.getState().suggestions),
  });
  registerCommand({
    id: "tmcodeAI.chooseModel",
    title: "Choose How TMCode AI Answers (Free, Auto, Model)",
    category: "TMCode AI",
    enabled: allowed,
    run: async () => {
      await refreshAiStatus();
      const { pickMode } = await import("./ChatView");
      await pickMode();
    },
  });
  registerCommand({
    id: "tmcodeAI.manageKeys",
    title: "Manage Your API Keys",
    category: "TMCode AI",
    aliases: ["byok", "own key", "api key", "premium"],
    run: () => void import("./ChatView").then((m) => m.openAiKeysSettings()),
  });
  void import("./keys").then((m) => m.loadAiKeys()).catch(() => {});
  setupMonaco();
  // The editor's context menu, as VS Code's "Copilot" submenu.
  for (const [id, label, order] of [
    ["tmcodeAI.explain", "TMCode AI: Explain This Code", 1],
    ["tmcodeAI.fix", "TMCode AI: Fix This Code", 2],
    ["tmcodeAI.tests", "TMCode AI: Write Tests", 3],
  ] as const) {
    monaco.editor.addEditorAction({
      id: `${id}.editor`,
      label,
      contextMenuGroupId: "0_tmcodeai",
      contextMenuOrder: order,
      precondition: undefined,
      run: () => {
        if (allowed()) void import("../commands/registry").then((m) => m.executeCommand(id));
      },
    });
  }
}
