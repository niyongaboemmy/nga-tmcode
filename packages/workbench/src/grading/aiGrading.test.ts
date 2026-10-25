import { beforeEach, describe, expect, it } from "vitest";
import { PRACTICE_POLICY } from "@tmcode/protocol";
import { MemoryFileSystem } from "../platform/memory";
import type { Platform } from "../platform/types";
import { initWorkbench, resetWorkbenchForTests, setPolicy, useWorkbench } from "../state/store";
import { useExam } from "../exam/state";
import { useAi, type AiStatus } from "../ai/service";
import { Checkpoint, permission, runTool, toolDefs } from "../ai/agent/tools";
import { applyExternalChanges } from "../monaco/external";
import { runGradingCommand } from "../exthost/mainThread";
import { DRAFT_FILE } from "./aiDraft";
import { discardAiDraft, resetDraftWatch, useAiGrading, wireAiGrading, writeGradingFiles } from "./aiGrading";
import { draftKey, useDrafts } from "./drafts";
import { useGrading, type Roster } from "./service";

/**
 * AI-assisted grading end to end inside the workbench (no Task Mentor): a draft from an extension
 * command, from draft.json and from the agent's propose_grade lands in the form, marked as the AI's,
 * and nothing is ever saved.
 */

const KEY = "assignment:51:";
const DKEY = draftKey(KEY, 21);
const roster: Roster = {
  activity: {
    type: "assignment",
    id: 51,
    title: "Build a to-do list",
    course_id: 3,
    due_date: null,
    max_points: 20,
    rubric: [
      { criteria: "Adding items works", description: null, max_score: 12 },
      { criteria: "Code quality", description: null, max_score: 8 },
    ],
    question: null,
    questions: [],
    can_grade: true,
    brief: { description: "<p>Build a to-do list.</p>", instructions: "Make Add work" },
  },
  counts: { total: 1, to_grade: 1, graded: 0 },
  rows: [
    {
      student: { id: 21, name: "Ben Learner" },
      state: "submitted",
      project: { id: 9, name: "Ben's work", kind: "tm", language: "javascript", repo_url: null },
      link: { id: 1, status: "submitted", submitted_at: null, revision_id: 30, revision_number: 3, git_commit: null },
      grade: { score: null, rubric_scores: null, feedback: null, graded_at: null, ref_id: 1, status: "ungraded", version: "none:21" },
      submitted_at: null,
      late: false,
    },
  ],
  loadedAt: 0,
};
const status = (extra: Partial<AiStatus>): AiStatus => ({ enabled: true, exam: false, default_mode: "free", modes: [], models: [], you: { chat: { used: 0, limit: 1 }, complete: { used: 0, limit: 1 } }, pools: {}, openrouter: null, ...extra });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let fs: MemoryFileSystem;

describe("AI-assisted grading", () => {
  beforeEach(async () => {
    try {
      localStorage.removeItem("tmcode.grading.aiDrafts");
    } catch {
      /* no storage in this test environment */
    }
    resetWorkbenchForTests();
    const memory = new Map<string, unknown>();
    fs = new MemoryFileSystem({ "app.js": "const items = [];\n" });
    await initWorkbench({
      kind: "desktop",
      os: "mac",
      version: "test",
      fs,
      store: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => void memory.set(k, v) },
      async openFolder() {
        return null;
      },
      async reopenFolder() {
        return null;
      },
    } as unknown as Platform);
    setPolicy(PRACTICE_POLICY);
    useExam.setState({ quiz: null, phase: "idle" });
    useWorkbench.setState({ workspace: { name: "review", root: "/review" }, readOnly: true, readOnlyReason: "Reviewing Ben Learner's submission (read-only)." });
    useAi.setState({ status: status({ allowed: true, features: { assist: true, complete: true }, thirdPartyExtensions: true, staff: true }), denied: null, project: { id: null, assessment: false } });
    useGrading.setState({ grader: true, rosters: { [KEY]: roster }, review: { key: KEY, project_id: 9, revision_id: 30, student: "Ben Learner", student_id: 21, activity: "Build a to-do list" } });
    useDrafts.setState({ drafts: {}, failed: {} });
    useAiGrading.setState({ meta: {}, watching: {}, drafting: {} });
    resetDraftWatch();
    wireAiGrading();
  });

  it("writes the grading files into the review folder", async () => {
    expect(await writeGradingFiles()).toBe(true);
    const readme = await fs.readFile(".tmcode/grading/README.md");
    expect(readme).toContain("Output contract");
    expect(await fs.readFile(".claude/CLAUDE.md")).toBe(readme);
    expect(JSON.parse(await fs.readFile(".tmcode/grading/context.json")).rubric).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(".tmcode/grading/draft.schema.json")).title).toBe("TMCode grading draft");
  });

  it("extension commands take arguments and return values; a proposed draft fills the form, unsaved", async () => {
    const ctx = (await runGradingCommand("tmcode.grading.getContext", [])) as { student: { name: string }; rubric: unknown[] };
    expect(ctx.student.name).toBe("Ben Learner");
    expect(ctx.rubric).toHaveLength(2);
    const res = await runGradingCommand("tmcode.grading.proposeDraft", [{ rubric_scores: [{ index: 0, score: 10, comment: "Works." }, { index: 1, score: 9 }], feedback: "Good.", confidence: "high", by: "Claude Code" }]);
    expect(res).toEqual({ ok: true, errors: [] });
    expect(useDrafts.getState().drafts[DKEY]).toMatchObject({ scores: [10, 8], comments: ["Works.", ""], feedback: "Good.", base: "none:21" });
    expect(useAiGrading.getState().meta[DKEY]).toMatchObject({ by: "Claude Code", confidence: "high", before: null });
    expect(useWorkbench.getState().notifications.at(-1)?.message).toBe("Claude Code drafted grades for Ben Learner: review, adjust, then Save.");
    expect(useWorkbench.getState().notifications.at(-1)?.actions?.map((a) => a.label)).toEqual(["Review", "Discard"]);
    expect(await runGradingCommand("tmcode.grading.proposeDraft", [{ feedback: "no scores" }])).toEqual({ ok: false, errors: [expect.stringMatching(/rubric_scores/)] });
    // Discard: the form as it was (no unsaved draft).
    discardAiDraft(DKEY);
    expect(useDrafts.getState().drafts[DKEY]).toBeUndefined();
    expect(useAiGrading.getState().meta[DKEY]).toBeUndefined();
  });

  it("extension commands are refused where third-party AI tools are off", async () => {
    useAi.setState({ status: status({ allowed: true, features: { assist: true, complete: true }, thirdPartyExtensions: false, staff: true }) });
    await expect(runGradingCommand("tmcode.grading.getContext", [])).rejects.toThrow(/third-party AI tools/);
  });

  it("draft.json written by any AI fills the form; a broken one says what is wrong", async () => {
    await fs.createDir(".tmcode").catch(() => {});
    await fs.createDir(".tmcode/grading").catch(() => {});
    await fs.writeFile(DRAFT_FILE, JSON.stringify({ rubric_scores: [{ index: 0, score: 15 }, { index: 1, score: 4, comment: "Names could be clearer." }], feedback: "Nice.", teacher_notes: "Try empty input.", confidence: "low", by: "Gemini CLI" }));
    await applyExternalChanges([DRAFT_FILE]);
    await tick(20);
    expect(useDrafts.getState().drafts[DKEY]).toMatchObject({ scores: [12, 4], comments: ["", "Names could be clearer."] });
    expect(useAiGrading.getState().meta[DKEY]).toMatchObject({ by: "Gemini CLI", confidence: "low", teacher_notes: "Try empty input.", notes: ['"Adding items works": 15 became 12 (0 to 12, half points).'] });
    await fs.writeFile(DRAFT_FILE, JSON.stringify({ rubric_scores: "all good" }));
    await applyExternalChanges([DRAFT_FILE]);
    await tick(20);
    const n = useWorkbench.getState().notifications.at(-1)!;
    expect(n.severity).toBe("warning");
    expect(n.message).toMatch(/couldn't be used: rubric_scores must be a list/);
    // The earlier draft stays.
    expect(useDrafts.getState().drafts[DKEY]?.scores).toEqual([12, 4]);
  });

  it("the agent: grading tools while reviewing, propose_grade fills the form, the read-only folder refuses edits", async () => {
    expect(toolDefs("plan", false, true).map((t) => t.function.name)).toEqual(["list_files", "read_file", "search", "get_problems", "get_grading_context", "propose_grade"]);
    expect(toolDefs("manual", false, false).map((t) => t.function.name)).not.toContain("propose_grade");
    expect(permission("manual", "propose_grade", {})).toBe("allow");
    const cp = new Checkpoint();
    const signal = { cancelled: false };
    const ctx = await runTool({ id: "1", type: "function", function: { name: "get_grading_context", arguments: "{}" } }, cp, signal);
    expect(ctx.ok && JSON.parse(ctx.output).activity.title).toBe("Build a to-do list");
    const r = await runTool({ id: "2", type: "function", function: { name: "propose_grade", arguments: JSON.stringify({ rubric_scores: [{ index: 0, score: 11 }, { index: 1, score: 7 }], feedback: "Well done.", confidence: "medium" }) } }, cp, signal);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/NOT saved/);
    expect(useAiGrading.getState().meta[DKEY]?.by).toBe("TMCode AI");
    expect(useDrafts.getState().drafts[DKEY]?.scores).toEqual([11, 7]);
    const edit = await runTool({ id: "3", type: "function", function: { name: "edit_file", arguments: JSON.stringify({ path: "app.js", old_text: "const", new_text: "let" }) } }, cp, signal);
    expect(edit.ok).toBe(false);
    expect(edit.output).toMatch(/read-only/);
    expect(await fs.readFile("app.js")).toBe("const items = [];\n");
  });
});
