import { beforeEach, describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../platform/memory";
import type { Platform } from "../platform/types";
import { initWorkbench, resetWorkbenchForTests, setPolicy } from "../state/store";
import { EXAM_POLICY_DEFAULTS, PRACTICE_POLICY } from "@tmcode/protocol";
import { useExam } from "../exam/state";
import { aiGate } from "./gate";
import { aiErrorFromResponse, completeAt, refreshAiStatus, setAiProject, useAi, type AiStatus } from "./service";

type Req = { method: string; path: string; json?: Record<string, unknown> };

function platform(answer: (r: Req) => { status: number; body: unknown }) {
  const memory = new Map<string, unknown>();
  const seen: Req[] = [];
  const p = {
    kind: "web",
    os: "mac",
    version: "test",
    fs: new MemoryFileSystem({}),
    store: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => void memory.set(k, v) },
    account: {
      request: async (r: Req) => {
        seen.push(r);
        return answer(r);
      },
    },
    async openFolder() {
      return null;
    },
    async reopenFolder() {
      return null;
    },
  } as unknown as Platform;
  return { p, seen };
}

const okStatus = (extra: Partial<AiStatus> = {}): AiStatus => ({
  enabled: true,
  exam: false,
  default_mode: "free",
  modes: [],
  models: [],
  you: { chat: { used: 0, limit: 40 }, complete: { used: 0, limit: 200 } },
  pools: {},
  openrouter: null,
  ...extra,
});

describe("TMCode AI requests carry the open project", () => {
  beforeEach(() => {
    resetWorkbenchForTests();
    useExam.setState({ quiz: null });
    useAi.setState({ status: null, denied: null, statusFor: null, project: { id: null, assessment: false } });
  });

  it("status asks with ?project_id=, completions send project_id", async () => {
    const { p, seen } = platform((r) => (r.path.includes("/status") ? { status: 200, body: okStatus({ allowed: true, reason: "ALLOWED_BY_ROLE", features: { assist: true, complete: true }, thirdPartyExtensions: false }) } : { status: 200, body: { text: "x", provider: "groq", model: "m" } }));
    await initWorkbench(p);
    setAiProject({ id: 42, assessment: true });
    await refreshAiStatus();
    expect(seen[0].path).toBe("/api/tmcode/ai/status?project_id=42");
    expect(useAi.getState().statusFor).toBe(42);
    expect(aiGate()).toMatchObject({ chat: true, thirdParty: false });
    await completeAt({ prefix: "abc", suffix: "", language: "python", path: "main.py" });
    expect(seen[1].path).toBe("/api/tmcode/ai/complete");
    expect(seen[1].json).toMatchObject({ project_id: 42, prefix: "abc" });
  });

  it("without a project nothing extra is sent", async () => {
    const { p, seen } = platform(() => ({ status: 200, body: okStatus() }));
    await initWorkbench(p);
    await refreshAiStatus();
    expect(seen[0].path).toBe("/api/tmcode/ai/status");
    await completeAt({ prefix: "abc", suffix: "", language: "python", path: "main.py" });
    expect(seen[1].json && "project_id" in seen[1].json).toBe(false);
  });

  it("a project change forgets the old status", async () => {
    useAi.setState({ status: okStatus({ allowed: true }), statusFor: 1, project: { id: 1, assessment: false } });
    setAiProject({ id: 2, assessment: false });
    expect(useAi.getState().status).toBeNull();
    // The same project learning it is an assessment keeps the status.
    useAi.setState({ status: okStatus({ allowed: true }) });
    setAiProject({ id: 2, assessment: true });
    expect(useAi.getState().status).not.toBeNull();
  });

  it("a 403 AI_DISABLED locks the gate with the server's reason", async () => {
    const { p } = platform((r) => (r.path.includes("/status") ? { status: 200, body: okStatus({ allowed: false, reason: "TEACHER_OFF", message: "Off for this assignment." }) } : { status: 403, body: { code: "AI_DISABLED", reason: "TEACHER_OFF", message: "Off for this assignment." } }));
    await initWorkbench(p);
    setAiProject({ id: 5, assessment: true });
    const e = await completeAt({ prefix: "abc", suffix: "", language: "python", path: "main.py" }).catch((x) => x);
    expect(e).toMatchObject({ code: "AI_DISABLED", reason: "TEACHER_OFF", message: "Off for this assignment." });
    expect(aiGate()).toMatchObject({ chat: false, reason: "TEACHER_OFF" });
    // Locked now: no further request.
    expect(await completeAt({ prefix: "abc", suffix: "", language: "python", path: "main.py" })).toBeNull();
  });

  it("in an exam the policy's ai decides; status is asked only when the exam allows AI", async () => {
    const { p, seen } = platform(() => ({ status: 200, body: okStatus() }));
    await initWorkbench(p);
    useExam.setState({ quiz: { id: 1 } as never });
    setPolicy({ ...EXAM_POLICY_DEFAULTS });
    await refreshAiStatus();
    expect(seen.length).toBe(0);
    expect(aiGate()).toMatchObject({ chat: false, reason: "EXAM_ACTIVE" });
    setPolicy({ ...EXAM_POLICY_DEFAULTS, ai: "full" });
    await refreshAiStatus();
    expect(seen.length).toBe(1);
    expect(aiGate()).toMatchObject({ chat: true, thirdParty: false });
    setPolicy(PRACTICE_POLICY);
  });
});

describe("aiErrorFromResponse", () => {
  it("reads AI_DISABLED at the top level or under error, and the legacy EXAM_ACTIVE", () => {
    expect(aiErrorFromResponse(403, { code: "AI_DISABLED", reason: "GLOBAL_OFF", message: "Your school has turned AI off." })).toMatchObject({ code: "AI_DISABLED", reason: "GLOBAL_OFF", message: "Your school has turned AI off." });
    expect(aiErrorFromResponse(403, { success: false, error: { code: "AI_DISABLED", reason: "ROLE_OFF" } })).toMatchObject({ code: "AI_DISABLED", reason: "ROLE_OFF", message: expect.stringMatching(/account/) });
    expect(aiErrorFromResponse(403, { error_code: "EXAM_ACTIVE", message: "TMCode AI is off during exams." })).toMatchObject({ code: "EXAM_ACTIVE", reason: "EXAM_ACTIVE" });
    const other = aiErrorFromResponse(429, { error_code: "USER_QUOTA", message: "You've used today's 40 AI questions." });
    expect(other).toMatchObject({ code: "USER_QUOTA", reason: undefined });
  });
});
