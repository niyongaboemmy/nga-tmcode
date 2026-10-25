import { AI_TOOL_CATALOG } from "@tmcode/protocol";
import { recordActivity } from "../activity/log";
import { useExam } from "../exam/state";
import type { AiToolEvent } from "../platform/types";
import { getPlatform, notify, useWorkbench } from "../state/store";
import { aiGate, thirdPartyMessage } from "./gate";
import { useAi } from "./service";

/**
 * Third-party AI tools in terminals (AI usage control): the AI gate's `thirdParty` goes to the
 * desktop app with the AI CLI catalogue, live (school switch, project change, exam). The app stubs
 * them in new terminals, stops them in running ones and says so here: a toast and an activity log
 * entry, so the teacher sees the attempt. Allowed tools are logged too (not stopped).
 */

export function aiToolsPolicyNow(): { blocked: boolean; message: string } {
  const message = thirdPartyMessage(aiGate());
  return { blocked: message !== null, message: message ?? "" };
}

export function onAiToolEvent(e: AiToolEvent) {
  const what = e.install ? `installing ${e.tool}` : e.tool;
  const command = e.command.length > 200 ? `${e.command.slice(0, 197)}…` : e.command;
  if (e.action === "blocked") {
    notify("warning", `${e.install ? `Installing ${e.tool}` : e.tool} was stopped. ${e.message || "AI tools are turned off."}`, undefined, { kind: "result", owner: "ai-tools" });
  }
  recordActivity({
    kind: "ai",
    action: e.action === "blocked" ? "blocked" : e.install ? "install" : "terminal",
    text: e.action === "blocked" ? `Tried ${what} in the terminal: stopped (AI tools are off)` : `${e.install ? `Installed ${e.tool}` : `Ran ${e.tool}`} in the terminal`,
    data: { tool: e.tool, command, install: e.install, blocked: e.action === "blocked" },
    actor: { type: "you" },
    ai: { by: `terminal: ${e.tool}`, how: e.action === "blocked" ? "blocked" : e.install ? "installed in the terminal" : "ran in the terminal" },
  });
}

let wired = false;
export function wireAiTools() {
  if (wired) return;
  const host = (() => {
    try {
      return getPlatform().aiTools;
    } catch {
      return undefined;
    }
  })();
  if (!host) return;
  wired = true;
  let last = "";
  const push = () => {
    const p = aiToolsPolicyNow();
    const key = `${p.blocked}|${p.message}`;
    if (key === last) return;
    last = key;
    host.setPolicy({ ...p, catalog: AI_TOOL_CATALOG });
  };
  push();
  useAi.subscribe(push);
  useExam.subscribe(push);
  useWorkbench.subscribe((s, prev) => {
    if (s.policy !== prev.policy) push();
  });
  host.onEvent(onAiToolEvent);
}
