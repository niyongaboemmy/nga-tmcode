import { beforeEach, describe, expect, it } from "vitest";
import { AI_TOOL_CATALOG, PRACTICE_POLICY } from "@tmcode/protocol";
import { setActivityFolder, useActivityLog } from "../activity/log";
import { MemoryFileSystem } from "../platform/memory";
import type { AiToolEvent, AiToolsPolicy, Platform } from "../platform/types";
import { initWorkbench, resetWorkbenchForTests, setPolicy } from "../state/store";
import { useExam } from "../exam/state";
import { useAi, type AiStatus } from "./service";
import { aiToolsPolicyNow, onAiToolEvent, wireAiTools } from "./tools";

const status = (extra: Partial<AiStatus>): AiStatus => ({ enabled: true, exam: false, default_mode: "free", modes: [], models: [], you: { chat: { used: 0, limit: 1 }, complete: { used: 0, limit: 1 } }, pools: {}, openrouter: null, ...extra });

describe("AI tools in terminals", () => {
  beforeEach(() => {
    resetWorkbenchForTests();
    setPolicy(PRACTICE_POLICY);
    useExam.setState({ quiz: null, phase: "idle" });
    useAi.setState({ status: null, denied: null, project: { id: null, assessment: false } });
    setActivityFolder("/ws");
  });

  it("follows the gate's third-party decision, with the reason", () => {
    expect(aiToolsPolicyNow()).toEqual({ blocked: false, message: "" });
    useAi.setState({ status: status({ allowed: false, reason: "TEACHER_OFF", message: "Off for Lab 2." }) });
    expect(aiToolsPolicyNow()).toEqual({ blocked: true, message: "Off for Lab 2." });
    useAi.setState({ status: null, project: { id: 3, assessment: true } });
    expect(aiToolsPolicyNow().blocked).toBe(true);
  });

  it("pushes the policy and the catalogue to the desktop app, live", async () => {
    const sent: AiToolsPolicy[] = [];
    let emit: ((e: AiToolEvent) => void) | null = null;
    const memory = new Map<string, unknown>();
    await initWorkbench({
      kind: "desktop",
      os: "mac",
      version: "test",
      fs: new MemoryFileSystem({}),
      store: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => void memory.set(k, v) },
      aiTools: { setPolicy: (p: AiToolsPolicy) => sent.push(p), onEvent: (cb: (e: AiToolEvent) => void) => ((emit = cb), () => {}) },
      async openFolder() {
        return null;
      },
      async reopenFolder() {
        return null;
      },
    } as unknown as Platform);
    setActivityFolder("/ws");
    wireAiTools();
    expect(sent.at(-1)).toMatchObject({ blocked: false, catalog: AI_TOOL_CATALOG });
    useAi.setState({ status: status({ allowed: false, reason: "GLOBAL_OFF", message: "" }) });
    expect(sent.at(-1)).toMatchObject({ blocked: true, message: "Your school has turned AI off." });
    const n = sent.length;
    useAi.setState({ loading: true });
    expect(sent.length).toBe(n); // nothing changed: nothing sent
    emit!({ action: "blocked", tool: "Claude Code", install: false, command: "claude", message: "Your school has turned AI off." });
    const last = useActivityLog.getState().events.at(-1)!;
    expect(last).toMatchObject({ kind: "ai", action: "blocked", ai: { by: "terminal: Claude Code", how: "blocked" } });
  });

  it("logs allowed tools and installs without stopping them", () => {
    onAiToolEvent({ action: "seen", tool: "Aider", install: true, command: "pip install aider-chat", message: "" });
    expect(useActivityLog.getState().events.at(-1)).toMatchObject({ kind: "ai", action: "install", text: "Installed Aider in the terminal", ai: { by: "terminal: Aider", how: "installed in the terminal" } });
  });
});
