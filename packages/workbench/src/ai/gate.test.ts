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
    // "hints" in a session is a timed task in Learning (D9): the tutor, no suggestions, no tools.
    expect(gate({ exam: true, examAi: "hints" })).toMatchObject({ chat: true, complete: false, thirdParty: false, layer: "learning", tutor: true, timedTask: true, edit: false });
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

describe("AI gate in exams, with a status asked during the exam", () => {
  const off = status({ allowed: false, reason: "TEACHER_OFF", message: "Your teacher turned AI off for this activity." });
  const full = status({ allowed: true, reason: "ALLOWED_BY_TEACHER", mode: "full", features: { assist: true, complete: true }, thirdPartyExtensions: true });
  const hints = status({ allowed: true, reason: "HINTS_ONLY", mode: "hints", features: { assist: false, complete: false } });

  it("the live status wins over the exam package, both ways", () => {
    expect(gate({ exam: true, examAi: "full", status: off, statusInExam: true })).toMatchObject({ chat: false, reason: "TEACHER_OFF" });
    expect(gate({ exam: true, examAi: "off", status: full, statusInExam: true })).toMatchObject({ chat: true, complete: true, thirdParty: false, reason: null });
    expect(gate({ exam: true, examAi: "full", status: hints, statusInExam: true })).toMatchObject({ chat: false, complete: false, reason: "HINTS_ONLY" });
  });

  it("a status from before the exam can't open it", () => {
    expect(gate({ exam: true, examAi: "off", status: full, statusInExam: false })).toMatchObject({ chat: false, reason: "EXAM_ACTIVE" });
  });

  it("a refusal just given still locks", () => {
    expect(gate({ exam: true, examAi: "full", status: full, statusInExam: true, denied: { reason: "GLOBAL_OFF" } })).toMatchObject({ chat: false, reason: "GLOBAL_OFF" });
  });
});

describe("aiReasonText", () => {
  it("has local words for every reason and a fallback", () => {
    for (const r of ["GLOBAL_OFF", "TEACHER_OFF", "HINTS_ONLY", "EXAM_ACTIVE", "ROLE_OFF", "ASSESSMENT_LOCKED", "APP_OFF"]) expect(aiReasonText(r)).toBe(AI_REASON_TEXT[r]);
    expect(aiReasonText("SOMETHING_NEW")).toBe("TMCode AI is off.");
    expect(aiReasonText("GLOBAL_OFF", "  ")).toBe(AI_REASON_TEXT.GLOBAL_OFF);
  });
});

describe("AI layers (vibe coding proposal §8)", () => {
  const learning = status({ allowed: true, reason: "ALLOWED_BY_TEACHER", mode: "hints", layer: "learning", features: { assist: true, complete: false }, thirdPartyExtensions: false });
  const full = status({ allowed: true, reason: "ALLOWED_BY_ROLE", mode: null, layer: "industrial", features: { assist: true, complete: true }, thirdPartyExtensions: true });

  it("Learning from a Task Mentor that knows layers: the tutor, words only", () => {
    expect(gate({ status: learning, assessmentProject: true })).toMatchObject({ layer: "learning", chat: true, tutor: true, complete: false, edit: false, nlCommand: false, copyCode: false, thirdParty: false, cause: "assignment" });
    expect(thirdPartyMessage(gate({ status: learning }), false)).toMatch(/Learning/);
  });

  it("an older Task Mentor's hints is still off (it can't filter the tutor)", () => {
    expect(gate({ status: status({ allowed: false, reason: "HINTS_ONLY", mode: "hints" }) })).toMatchObject({ layer: "exam", chat: false });
  });

  it("Industrial: Guided for students, Open for staff", () => {
    expect(gate({ status: { ...full, staff: false, thirdPartyExtensions: false } })).toMatchObject({ layer: "industrial", profile: "guided", edit: true, nlCommand: true, thirdParty: false });
    expect(gate({ status: { ...full, staff: true } })).toMatchObject({ layer: "industrial", profile: "open", thirdParty: true });
    // An Industrial assignment: Guided unless the teacher allowed own tools.
    const assignment = { ...full, mode: "full" as const, thirdPartyExtensions: true };
    expect(gate({ status: assignment, assessmentProject: true })).toMatchObject({ profile: "guided", thirdParty: false });
    expect(gate({ status: { ...assignment, own_tools: true }, assessmentProject: true })).toMatchObject({ profile: "open", thirdParty: true });
  });

  it("signed out: Industrial · Open (bring your own AI), unless the device says otherwise", () => {
    expect(gate({ signedIn: false })).toMatchObject({ layer: "industrial", profile: "open", cause: "signed-out", thirdParty: true, chat: true });
    expect(gate({ signedIn: false, device: { signedOutLayer: "learning" } })).toMatchObject({ layer: "learning", cause: "device", thirdParty: false });
    expect(gate({ signedIn: false, device: { requireSignIn: true } })).toMatchObject({ layer: "exam", chat: false, reason: "SIGN_IN_REQUIRED" });
  });

  it("the device's max layer and Guided apply signed in too", () => {
    expect(gate({ status: { ...full, staff: true }, device: { maxLayer: "learning" } })).toMatchObject({ layer: "learning", cause: "device" });
    expect(gate({ status: { ...full, staff: true }, device: { forceGuided: true } })).toMatchObject({ profile: "guided", thirdParty: false });
  });

  it("a sticky assignment layer holds when signed out, and expires", () => {
    const sticky = { layer: "learning" as const, ownTools: false, projectId: 7, exp: new Date(Date.now() + 3_600_000).toISOString() };
    expect(gate({ signedIn: false, sticky, assessmentProject: true })).toMatchObject({ layer: "learning", cause: "sticky", thirdParty: false });
    expect(gate({ signedIn: false, sticky: { ...sticky, exp: new Date(Date.now() - 1000).toISOString() } })).toMatchObject({ layer: "industrial" });
    // Signed in with a status, the status speaks (the teacher may have raised it since).
    expect(gate({ status: full, sticky })).toMatchObject({ layer: "industrial" });
  });

  it("a class ceiling from MIS caps the layer", () => {
    expect(gate({ status: { ...full, max_layer: "learning" } })).toMatchObject({ layer: "learning", cause: "class" });
  });

  it("the user may only lower: choosing Learning or No AI", () => {
    expect(gate({ status: full, choice: "learning" })).toMatchObject({ layer: "learning", cause: "choice", tutor: true });
    expect(gate({ status: full, choice: "exam" })).toMatchObject({ layer: "exam", chat: false, reason: "YOUR_CHOICE" });
    expect(gate({ status: learning, choice: "industrial" })).toMatchObject({ layer: "learning" });
  });

  it("an exam session is Exam; a timed task keeps third-party AI off", () => {
    expect(gate({ exam: true, examAi: "off", status: full })).toMatchObject({ layer: "exam", cause: "exam-session", timedTask: false });
    expect(gate({ exam: true, examAi: "full" })).toMatchObject({ layer: "industrial", timedTask: true, thirdParty: false });
  });
});
