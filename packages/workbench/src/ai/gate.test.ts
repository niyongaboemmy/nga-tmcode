import { describe, expect, it } from "vitest";
import { AI_REASON_TEXT, aiReasonText, decideAiGate, thirdPartyMessage, type AiGateInput } from "./gate";
import type { AiStatus } from "./service";

const legacy: AiStatus = {
  enabled: true,
  exam: false,
  default_mode: "free",
  modes: [],
  models: [],
  you: { chat: { used: 0, limit: 40 }, complete: { used: 0, limit: 200 } },
  pools: {},
  openrouter: null,
};
const status = (s: Partial<AiStatus>): AiStatus => ({ ...legacy, ...s });
const gate = (i: Partial<AiGateInput>) => decideAiGate({ status: null, exam: false, ...i });
const allowedStatus = status({ allowed: true, reason: "ALLOWED_BY_ROLE", message: "", mode: null, features: { assist: true, complete: true }, thirdPartyExtensions: true });

describe("AI gate outside exams", () => {
  it("follows Task Mentor's allowed / reason / message", () => {
    expect(gate({ status: allowedStatus })).toMatchObject({ chat: true, complete: true, thirdParty: true, reason: null, known: true });
    for (const reason of ["GLOBAL_OFF", "APP_OFF", "ASSESSMENT_LOCKED", "TEACHER_OFF", "ROLE_OFF", "EXAM_ACTIVE"]) {
      const g = gate({ status: status({ allowed: false, reason, message: "", features: { assist: false, complete: false }, thirdPartyExtensions: false }) });
      expect(g).toMatchObject({ chat: false, complete: false, thirdParty: false, reason });
      expect(g.message).toBe(AI_REASON_TEXT[reason]);
    }
    // The server's words win.
    expect(gate({ status: status({ allowed: false, reason: "TEACHER_OFF", message: "AI is off for Quiz 3." }) }).message).toBe("AI is off for Quiz 3.");
  });

  it("hints only: chat and suggestions off (TMCode has no hint feature)", () => {
    const g = gate({ status: status({ allowed: false, reason: "HINTS_ONLY", mode: "hints", features: { assist: false, complete: false }, thirdPartyExtensions: false }) });
    expect(g).toMatchObject({ chat: false, complete: false, reason: "HINTS_ONLY" });
    expect(g.message).toMatch(/Hints only/);
    // Allowed overall, but no chat feature: still says why.
    const h = gate({ status: status({ allowed: true, reason: "ALLOWED_BY_TEACHER", mode: "hints", features: { assist: false, complete: false }, thirdPartyExtensions: false }) });
    expect(h).toMatchObject({ chat: false, reason: "HINTS_ONLY" });
  });

  it("third-party tools need thirdPartyExtensions even when TMCode AI is allowed", () => {
    const g = gate({ status: { ...allowedStatus, thirdPartyExtensions: false } });
    expect(g).toMatchObject({ chat: true, complete: true, thirdParty: false });
    expect(thirdPartyMessage(g, false)).toMatch(/third-party AI tools/);
    expect(thirdPartyMessage(gate({ status: allowedStatus }), false)).toBeNull();
  });

  it("an older Task Mentor (no allowed field) is decided as before: on outside exams", () => {
    expect(gate({ status: legacy })).toMatchObject({ chat: true, complete: true, thirdParty: true, known: true });
    expect(gate({ status: legacy, assessmentProject: true })).toMatchObject({ chat: true, thirdParty: true });
    expect(gate({ status: { ...legacy, exam: true } })).toMatchObject({ chat: false, reason: "EXAM_ACTIVE" });
  });

  it("status unknown: TMCode AI shows (the server decides), third-party tools stay off in assignment projects", () => {
    expect(gate({})).toMatchObject({ chat: true, complete: true, thirdParty: true, known: false });
    const g = gate({ assessmentProject: true });
    expect(g).toMatchObject({ chat: true, thirdParty: false, known: false });
    expect(thirdPartyMessage(g, false)).toMatch(/until Task Mentor confirms/);
  });

  it("a refusal locks until the next status", () => {
    const g = gate({ status: allowedStatus, denied: { reason: "GLOBAL_OFF", message: null } });
    expect(g).toMatchObject({ chat: false, complete: false, thirdParty: false, reason: "GLOBAL_OFF", message: AI_REASON_TEXT.GLOBAL_OFF });
    expect(gate({ denied: { reason: "EXAM_ACTIVE" } }).message).toBe(AI_REASON_TEXT.EXAM_ACTIVE);
  });
});

describe("AI gate in exams", () => {
  it("off unless the exam policy says full", () => {
    expect(gate({ exam: true, status: allowedStatus })).toMatchObject({ chat: false, reason: "EXAM_ACTIVE" });
    expect(gate({ exam: true, examAi: "off", status: allowedStatus })).toMatchObject({ chat: false, reason: "EXAM_ACTIVE" });
    expect(gate({ exam: true, examAi: "hints" })).toMatchObject({ chat: false, complete: false, reason: "HINTS_ONLY" });
  });

  it("full: TMCode AI on, third-party tools still off", () => {
    expect(gate({ exam: true, examAi: "full" })).toMatchObject({ chat: true, complete: true, thirdParty: false });
    expect(gate({ exam: true, examAi: "full", status: allowedStatus })).toMatchObject({ chat: true, thirdParty: false });
    expect(thirdPartyMessage(gate({ exam: true, examAi: "full" }), true)).toMatch(/during exams/);
  });

  it("full but the school turned AI off since: off", () => {
    expect(gate({ exam: true, examAi: "full", status: status({ allowed: false, reason: "GLOBAL_OFF" }) })).toMatchObject({ chat: false, reason: "GLOBAL_OFF" });
    expect(gate({ exam: true, examAi: "full", denied: { reason: "ASSESSMENT_LOCKED" } })).toMatchObject({ chat: false, reason: "ASSESSMENT_LOCKED" });
  });
});

describe("aiReasonText", () => {
  it("has local words for every reason and a fallback", () => {
    for (const r of ["GLOBAL_OFF", "TEACHER_OFF", "HINTS_ONLY", "EXAM_ACTIVE", "ROLE_OFF", "ASSESSMENT_LOCKED", "APP_OFF"]) expect(aiReasonText(r)).toBe(AI_REASON_TEXT[r]);
    expect(aiReasonText("SOMETHING_NEW")).toBe("TMCode AI is off.");
    expect(aiReasonText("GLOBAL_OFF", "  ")).toBe(AI_REASON_TEXT.GLOBAL_OFF);
  });
});
