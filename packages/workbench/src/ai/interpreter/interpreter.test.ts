import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRACTICE_POLICY, ruleCard, type IntentCard } from "@tmcode/protocol";
import { setActivityFolder, useActivityLog } from "../../activity/log";
import { MemoryFileSystem } from "../../platform/memory";
import type { Platform } from "../../platform/types";
import { initWorkbench, resetWorkbenchForTests, setPolicy, useWorkbench } from "../../state/store";
import { useExam } from "../../exam/state";
import { useProjects } from "../../projects/service";
import { useLayerInputs } from "../layerState";
import { useAi, type AiStatus } from "../service";
import { decide, type PolicyEnv, type PolicyInput } from "./policy";
import { INITIAL, nextFade } from "./fading";

const ask = vi.fn();
vi.mock("../chat", async (orig) => ({ ...(await orig<typeof import("../chat")>()), ask: (...a: unknown[]) => ask(...a) }));
const fetchInterpretation = vi.fn();
vi.mock("./client", async (orig) => ({ ...(await orig<typeof import("./client")>()), fetchInterpretation: (...a: unknown[]) => fetchInterpretation(...a) }));

import { backToEditing, confirmCard, editCard, interceptRequest, registerComposer, resetIntent, sendAsIs, studentContributed, useIntent } from "./state";

/**
 * The request interpreter in TMCode (reports/TMCode prompt interpreter layer.md): the gate's rules
 * (policy.ts), Guided's fading, and the chat flow -- the card, the hand-off with the user's words,
 * pass-through on failure, the understood-diff, Guided's "your turn" and the Activity evidence.
 */

const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({ text: "write a function", trigger: "send", firstOfTask: true, recipeWithArgs: false, planEntry: false, mentions: 0, openFile: false, ...over });
const env = (over: Partial<PolicyEnv> = {}): PolicyEnv => ({
  layer: "industrial",
  profile: "guided",
  student: true,
  examActive: false,
  chatAllowed: true,
  status: { available: true, arm: "card", stage: "auto", show_prompts: false, prompt_problem: null },
  setting: "onDemand",
  localSetting: false,
  doubleCheck: false,
  mode: "free",
  signedIn: true,
  localAvailable: false,
  dismissStreak: 0,
  fadingStage: "full",
  ...over,
});
const ran = (d: ReturnType<typeof decide>) => (d.run ? d : null);

describe("the gate (policy.ts)", () => {
  it("never in an exam, for the holdout, or when the teacher turned it off", () => {
    expect(decide(input(), env({ layer: "exam" }))).toMatchObject({ run: false, reason: "exam" });
    expect(decide(input(), env({ examActive: true }))).toMatchObject({ run: false });
    expect(decide(input(), env({ status: { available: true, arm: "holdout", stage: "auto", show_prompts: false, prompt_problem: null } }))).toMatchObject({ run: false, reason: "holdout" });
    expect(decide(input({ trigger: "manual" }), env({ status: { available: true, arm: "holdout", stage: "auto", show_prompts: false, prompt_problem: null } }))).toMatchObject({ run: false });
    expect(decide(input(), env({ status: { available: true, arm: "card", stage: "off", show_prompts: false, prompt_problem: null } }))).toMatchObject({ run: false, reason: "teacher-off" });
  });
  it("Guided: the first message of a task gets the full card, and the student fills one field", () => {
    expect(ran(decide(input(), env()))).toMatchObject({ kind: "card", stage: "full", route: "school", mustFill: true });
  });
  it("skips follow-ups, recipes with arguments and a pasted error with 'fix'", () => {
    expect(decide(input({ firstOfTask: false, text: "now make the button blue please" }), env())).toMatchObject({ run: false, reason: "follow-up" });
    expect(decide(input({ recipeWithArgs: true }), env())).toMatchObject({ run: false, reason: "recipe" });
    expect(decide(input({ text: "fix\n```\nTypeError: x is undefined\n```" }), env())).toMatchObject({ run: false, reason: "pasted-error" });
  });
  it("Kinyarwanda and mixed requests are always offered, even as follow-ups", () => {
    const d = ran(decide(input({ firstOfTask: false, text: "nshaka ko page ya login ivuga error niba password ari mbi" }), env()));
    expect(d?.reasons).toContain("language");
    expect(d?.language.startsWith("rw")).toBe(true);
  });
  it("Open (staff, signed-out, own tools): on demand, auto only for Kinyarwanda or very unclear requests", () => {
    const open = env({ student: false, profile: "open" });
    expect(decide(input({ text: "Add a dark mode toggle to the navbar that switches a class on the body" }), open)).toMatchObject({ run: false, reason: "on-demand" });
    expect(ran(decide(input({ trigger: "manual" }), open))).toMatchObject({ kind: "card", stage: "full", mustFill: false });
    expect(ran(decide(input({ text: "ndashaka kwerekana ubutumwa bw'ikosa niba ijambobanga ari ribi" }), open))).toBeTruthy();
    expect(decide(input({ text: "make it work" }), env({ student: false, profile: "open", setting: "never" }))).toMatchObject({ run: false, reason: "never" });
  });
  it("stops offering after the words were sent as-is twice in a row", () => {
    expect(decide(input(), env({ dismissStreak: 2 }))).toMatchObject({ run: false, reason: "dismissed" });
  });
  it("Learning: the coach", () => {
    expect(ran(decide(input(), env({ layer: "learning" })))).toMatchObject({ kind: "coach" });
  });
  it("the teacher's pin, else Guided's fading stage", () => {
    expect(ran(decide(input(), env({ status: { available: true, arm: "card", stage: "hint", show_prompts: false, prompt_problem: null } })))).toMatchObject({ stage: "hint", mustFill: false });
    expect(ran(decide(input(), env({ fadingStage: "strip" })))).toMatchObject({ stage: "strip" });
  });
  it("routes: AI accounts and local models stay off the school's quota; Kinyarwanda never goes to a small model (Q5)", () => {
    expect(decide(input({ trigger: "manual" }), env({ mode: "cli:claude" }))).toMatchObject({ run: false, reason: "cli-needs-local" });
    expect(ran(decide(input({ trigger: "manual" }), env({ mode: "cli:claude", localAvailable: true })))).toMatchObject({ route: "local" });
    expect(ran(decide(input({ text: "nshaka ko page ya login ivuga error" }), env({ mode: "local:qwen", localAvailable: true })))).toMatchObject({ route: "school" });
    expect(decide(input({ text: "nshaka ko page ya login ivuga error" }), env({ mode: "local:qwen", localAvailable: true, signedIn: false, student: false }))).toMatchObject({ run: false, reason: "rw-local" });
    expect(ran(decide(input({ trigger: "manual" }), env({ mode: "byok:openai/gpt-4.1", signedIn: false, student: false, profile: "open" })))).toMatchObject({ route: "direct" });
    expect(ran(decide(input({ trigger: "manual" }), env({ localSetting: true, localAvailable: true })))).toMatchObject({ route: "local" });
  });
  it("two samples (Q15) with Double-Check or a paid mode, on the school route", () => {
    expect(ran(decide(input(), env({ doubleCheck: true })))?.samples).toBe(2);
    expect(ran(decide(input(), env({ mode: "premium:anthropic/claude-sonnet-4-5" })))?.samples).toBe(2);
    expect(ran(decide(input(), env()))?.samples).toBe(1);
  });
});

describe("Guided's fading (Q7)", () => {
  const good = { additions: 0, completeness: 0.83, at: 1 };
  const bad = { additions: 3, completeness: 0.17, at: 1 };
  it("moves on after three complete requests, back after two poor ones", () => {
    let s = INITIAL;
    s = nextFade(s, good);
    s = nextFade(s, good);
    expect(s.stage).toBe("full");
    s = nextFade(s, good);
    expect(s.stage).toBe("hint");
    s = nextFade(nextFade(nextFade(s, good), good), good);
    expect(s.stage).toBe("strip");
    s = nextFade(nextFade(nextFade(s, good), good), good);
    expect(s.stage).toBe("strip");
    s = nextFade(nextFade(s, bad), bad);
    expect(s.stage).toBe("hint");
  });
  it("a lot of added help doesn't count as complete", () => {
    const helped = { additions: 3, completeness: 0.9, at: 1 };
    expect(nextFade(nextFade(nextFade(INITIAL, helped), helped), helped).stage).toBe("full");
  });
});

const status = (extra: Partial<AiStatus>): AiStatus => ({ enabled: true, exam: false, default_mode: "free", modes: [], models: [], you: { chat: { used: 0, limit: 9 }, complete: { used: 0, limit: 9 } }, pools: {}, openrouter: null, ...extra });
const guided = status({ allowed: true, reason: "ALLOWED_BY_TEACHER", mode: "full", layer: "industrial", staff: false, features: { assist: true, complete: true }, interpreter: { available: true, arm: "card", stage: "auto", show_prompts: false, prompt_problem: null } });
const opts = { file: true, problems: true };

describe("the chat flow (state.ts)", () => {
  beforeEach(async () => {
    ask.mockReset();
    fetchInterpretation.mockReset();
    resetWorkbenchForTests();
    setPolicy(PRACTICE_POLICY);
    useExam.setState({ quiz: null });
    const p = { kind: "web", os: "mac", version: "test", fs: new MemoryFileSystem({}), store: { get: async () => undefined, set: async () => {} } } as unknown as Platform;
    await initWorkbench(p);
    useAi.setState({ status: guided, mode: "free", project: { id: 5, assessment: true } });
    useProjects.setState({ account: { signed_in: true, user: { id: 77, name: "Aline", permissions: [] }, tm_api: "", phase: "idle", error: null } as never });
    useLayerInputs.setState({ signedIn: true, device: null, sticky: null, choice: null, choseGuided: false });
    setActivityFolder("/ws");
    resetIntent();
    if (typeof localStorage !== "undefined" && typeof localStorage.clear === "function") localStorage.clear();
  });
  const first = { firstOfTask: true, recipeWithArgs: false, planEntry: false, mentions: 0, openFile: false };
  const card = (text: string, over: Partial<IntentCard> = {}) => ({ ...ruleCard(text), ...over });

  it("takes the request, shows the card, and hands the agent the words plus the card", async () => {
    fetchInterpretation.mockResolvedValue({ card: card("write average(xs) -> 0 for an empty list"), provider: "groq", model: "gpt-oss-20b", ms: 900 });
    expect(interceptRequest("write average(xs) -> 0 for an empty list", opts, "edit", first)).toBe(true);
    expect(useIntent.getState().pending?.status).toBe("loading");
    await vi.waitFor(() => expect(useIntent.getState().pending?.status).toBe("ready"));
    expect(ask).not.toHaveBeenCalled();
    confirmCard();
    expect(ask).toHaveBeenCalledWith("write average(xs) -> 0 for an empty list", opts, "edit", { intent: expect.objectContaining({ original: "write average(xs) -> 0 for an empty list" }) });
    const e = useActivityLog.getState().events.find((x) => x.action === "intent")!;
    expect(e.data).toMatchObject({ outcome: "accepted", stage: "full", arm: "card", route: "school" });
    expect(typeof e.data?.completeness).toBe("number");
    // Metadata only for students unless the teacher asked for the text (QD5).
    expect(e.data?.request).toBeUndefined();
  });

  it("an automatic check that fails sends the words as they are (never blocks)", async () => {
    fetchInterpretation.mockRejectedValue(Object.assign(new Error("slow"), { code: "TIMEOUT" }));
    interceptRequest("write a function that sorts students", opts, "edit", first);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledWith("write a function that sorts students", opts, "edit"));
    expect(useIntent.getState().pending).toBeNull();
    expect(useIntent.getState().note).toMatch(/took too long/);
    expect(useActivityLog.getState().events.find((x) => x.action === "intent")?.data?.outcome).toBe("failed");
  });

  it("one the user asked for says why; then 'as typed' sends it and counts the dismissal", async () => {
    fetchInterpretation.mockRejectedValue(new Error("nope"));
    interceptRequest("write a function", opts, "chat", first, "manual");
    await vi.waitFor(() => expect(useIntent.getState().pending?.status).toBe("failed"));
    sendAsIs();
    expect(ask).toHaveBeenCalledWith("write a function", opts, "chat");
    expect(useIntent.getState().dismissStreak).toBe(1);
  });

  it("'Edit my words' puts the text back in the prompt box", async () => {
    fetchInterpretation.mockResolvedValue({ card: card("write a function"), provider: "groq", model: "m", ms: 1 });
    const composer = vi.fn();
    registerComposer(composer);
    interceptRequest("write a function", opts, "edit", first);
    await vi.waitFor(() => expect(useIntent.getState().pending?.status).toBe("ready"));
    backToEditing();
    expect(composer).toHaveBeenCalledWith("write a function");
    expect(ask).not.toHaveBeenCalled();
  });

  it("Guided's 'your turn': the student adds an example or an unusual case themselves", async () => {
    fetchInterpretation.mockResolvedValue({ card: card("write a function that sorts students"), provider: "groq", model: "m", ms: 1 });
    interceptRequest("write a function that sorts students", opts, "edit", first);
    await vi.waitFor(() => expect(useIntent.getState().pending?.status).toBe("ready"));
    const p = useIntent.getState().pending!;
    expect(p.decision.mustFill).toBe(true);
    expect(studentContributed(p.card, p.received)).toBe(false);
    editCard("edge_cases", (c) => ({ ...c, edge_cases: [...c.edge_cases, { text: "two students with the same name", by: "you" }] }));
    const after = useIntent.getState().pending!;
    expect(studentContributed(after.card, after.received)).toBe(true);
    confirmCard();
    expect(useActivityLog.getState().events.find((x) => x.action === "intent")?.data).toMatchObject({ outcome: "edited", edited: "edge_cases" });
  });

  it("Q9: an edited request that means the same is said plainly", async () => {
    const a = card("In src/utils.py write average(numbers) that returns the mean");
    useIntent.setState({ last: a });
    fetchInterpretation.mockResolvedValue({ card: { ...a, original: "In src/utils.py, write average(numbers) returning the mean" }, provider: "groq", model: "m", ms: 1 });
    interceptRequest("In src/utils.py, write average(numbers) returning the mean", opts, "edit", first);
    await vi.waitFor(() => expect(useIntent.getState().pending?.status).toBe("ready"));
    expect(useIntent.getState().pending?.diffNote).toMatch(/didn't change what I understood/);
    expect(useActivityLog.getState().events.some((x) => x.action === "understood-diff")).toBe(true);
  });

  it("hint stage: the interpreter's own additions are hidden; the student fills the gaps", async () => {
    useAi.setState({ status: { ...guided, interpreter: { ...guided.interpreter!, stage: "hint" } } });
    fetchInterpretation.mockResolvedValue({ card: card("sort the list of students", { examples: [{ input: "[]", output: "[]", verdict: null, by: "ai" }], assumptions: [{ text: "by name", by: "ai", keep: true }] }), provider: "groq", model: "m", ms: 1 });
    interceptRequest("sort the list of students", opts, "edit", first);
    await vi.waitFor(() => expect(useIntent.getState().pending?.status).toBe("ready"));
    const c = useIntent.getState().pending!.card!;
    expect(c.examples).toHaveLength(0);
    expect(c.assumptions).toHaveLength(0);
  });

  it("the holdout never sees it; a teacher who wants the text gets it logged", async () => {
    useAi.setState({ status: { ...guided, interpreter: { ...guided.interpreter!, arm: "holdout" } } });
    expect(interceptRequest("write a function", opts, "edit", first)).toBe(false);
    useAi.setState({ status: { ...guided, interpreter: { ...guided.interpreter!, show_prompts: true } } });
    fetchInterpretation.mockResolvedValue({ card: card("write a function"), provider: "groq", model: "m", ms: 1 });
    interceptRequest("write a function", opts, "edit", first);
    await vi.waitFor(() => expect(useIntent.getState().pending?.status).toBe("ready"));
    sendAsIs();
    expect(useActivityLog.getState().events.find((x) => x.action === "intent")?.data).toMatchObject({ outcome: "as-is", request: "write a function" });
  });

  it("Open: the user's 'never' setting stops automatic checks", () => {
    useAi.setState({ status: { ...guided, staff: true } });
    useWorkbench.setState((s) => ({ settings: { ...s.settings, "tmcodeAI.interpreter": "never" } }));
    expect(interceptRequest("make it work", opts, "edit", first)).toBe(false);
  });
});
