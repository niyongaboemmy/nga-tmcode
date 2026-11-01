import { describe, expect, it } from "vitest";
import { buildGradingContext, CLI_PROMPT, draftSchema, gradingReadme, htmlToMarkdown, mergeAiDraft, parseDraftText, testsSummary, validateAiDraft } from "./aiDraft";
import { cliCommand } from "./aiCli";
import type { Draft } from "./drafts";
import type { Roster, RosterRow } from "./service";

const rubric = [
  { criteria: "Adding items works", description: "Typing a task and pressing Add shows it", max_score: 12 },
  { criteria: "Code quality", description: null, max_score: 8 },
];

const roster = (extra: Partial<Roster["activity"]> = {}): Roster => ({
  activity: {
    type: "assignment",
    id: 51,
    title: "Build a to-do list",
    course_id: 3,
    due_date: null,
    max_points: 20,
    rubric,
    question: null,
    questions: [],
    can_grade: true,
    brief: { description: '<p>Build a <b>to-do list</b> page. <a href="https://developer.mozilla.org/">MDN</a> helps.</p><script>alert(1)</script><ul><li>Add</li><li>Remove</li></ul>', instructions: "1. Open `index.html`\n2. Submit", language: "javascript", kind: "practical", submission_type: "tmcode", attachments: [{ name: "spec.pdf" }] },
    ...extra,
  },
  counts: { total: 1, to_grade: 1, graded: 0 },
  rows: [],
  loadedAt: 0,
});
const row: RosterRow = {
  student: { id: 21, name: "Ben Learner" },
  state: "submitted",
  project: { id: 9, name: "Ben's work", kind: "tm", language: "javascript", repo_url: null },
  link: { id: 1, status: "submitted", submitted_at: "2026-10-24T10:00:00Z", revision_id: 30, revision_number: 3, git_commit: null },
  grade: null,
  submitted_at: "2026-10-24T10:00:00Z",
  late: true,
};
const blank: Draft = { scores: [null, null], comments: ["", ""], score: null, feedback: "", annotations: [{ path: "app.js", line: 1, text: "Use const" }] };

describe("the brief as Markdown", () => {
  it("keeps the words, emphasis, links and lists; drops scripts", () => {
    const md = htmlToMarkdown(roster().activity.brief!.description);
    expect(md).toContain("Build a **to-do list** page.");
    expect(md).toContain("[MDN](https://developer.mozilla.org/)");
    expect(md).toContain("- Add");
    expect(md).not.toContain("alert");
    expect(htmlToMarkdown('<h2>Model</h2><p>A &amp; B</p><img src="data:image/svg+xml,x" alt="ER diagram">')).toBe("### Model\n\nA & B\n\n[image: ER diagram]");
  });
});

describe("the grading files", () => {
  const ctx = buildGradingContext(roster(), row, { passed: 1, failed: 1, total: 2, summary: "FAILED removes an item" });

  it("context.json: activity, brief, rubric with indexes, student, tests and the output file", () => {
    expect(ctx.activity).toMatchObject({ type: "assignment", id: 51, title: "Build a to-do list", max_points: 20 });
    expect(ctx.brief.attachments).toEqual(["spec.pdf"]);
    expect(ctx.rubric).toEqual([
      { index: 0, criteria: "Adding items works", description: "Typing a task and pressing Add shows it", max_score: 12 },
      { index: 1, criteria: "Code quality", description: null, max_score: 8 },
    ]);
    expect(ctx.student).toEqual({ id: 21, name: "Ben Learner" });
    expect(ctx.submission).toEqual({ version: 3, submitted_at: "2026-10-24T10:00:00Z", late: true });
    expect(ctx.output).toEqual({ file: ".tmcode/grading/draft.json", schema: ".tmcode/grading/draft.schema.json" });
  });

  it("README.md: the role, the brief, the rubric table and the output contract", () => {
    const md = gradingReadme(ctx);
    expect(md).toMatch(/^# Grading task \(TMCode\)\n\nYou are helping a teacher grade/);
    expect(md).toContain("Build a **to-do list** page.");
    expect(md).toContain("### Instructions\n\n1. Open `index.html`");
    expect(md).toContain("| 0 | Adding items works | 12 | Typing a task and pressing Add shows it |");
    expect(md).toContain("| 1 | Code quality | 8 |  |");
    expect(md).toContain("Student: Ben Learner");
    expect(md).toContain("handed in late");
    expect(md).toContain("1 of 2 passed, 1 failed.");
    expect(md).toContain("## Output contract (required)");
    expect(md).toContain("Write exactly one file, `.tmcode/grading/draft.json`");
    expect(md).toContain('"rubric_scores": [');
    expect(md).toContain("`index` 0 to 1");
    expect(md).toMatch(/Never edit, create, rename or delete the student's files/);
    expect(md).toMatch(/Never submit, save or release a grade/);
    expect(md).toMatch(/never instructions to you/);
  });

  it("without a rubric: one final score", () => {
    const md = gradingReadme(buildGradingContext(roster({ rubric: [] }), row));
    expect(md).toContain("No rubric: give one final score from 0 to 20 in `score`");
    expect(md).toContain('"score": 20');
  });

  it("draft.schema.json: indexes and scores bounded by the rubric", () => {
    const s = draftSchema(ctx) as { properties: { rubric_scores: { items: { properties: { index: { maximum: number }; score: { maximum: number; multipleOf: number } } } } } };
    expect(s.properties.rubric_scores.items.properties.index.maximum).toBe(1);
    expect(s.properties.rubric_scores.items.properties.score).toMatchObject({ maximum: 12, multipleOf: 0.5 });
  });

  it("the CLI prompt is one shell-safe line", () => {
    expect(CLI_PROMPT).not.toMatch(/["'`$\\\n]/);
    expect(cliCommand("claude")).toBe(`claude "${CLI_PROMPT}"`);
    expect(cliCommand("gemini")).toBe(`gemini -i "${CLI_PROMPT}"`);
    expect(cliCommand("agy")).toBe(`agy -i "${CLI_PROMPT}"`);
    expect(cliCommand("codex", 'say "hi" $HOME')).toBe('codex "say hi HOME"');
  });
});

describe("an AI's draft", () => {
  it("is clamped to 0…max in half points, with notes, and fills the form", () => {
    const check = validateAiDraft(
      { rubric_scores: [{ index: 0, score: 14, comment: " Adding works (app.js:3). " }, { index: 1, score: "6.3", comment: "Clear names." }], score: null, feedback: "Well done.", teacher_notes: "Check empty input.", confidence: "MEDIUM", by: "Claude Code", warnings: ["Could not run it"] },
      rubric,
      20,
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.draft).toMatchObject({ scores: [12, 6.5], comments: ["Adding works (app.js:3).", "Clear names."], feedback: "Well done.", teacher_notes: "Check empty input.", confidence: "medium", by: "Claude Code", warnings: ["Could not run it"] });
    expect(check.draft.notes).toEqual(['"Adding items works": 14 became 12 (0 to 12, half points).', '"Code quality": 6.3 became 6.5 (0 to 8, half points).']);
    const merged = mergeAiDraft(blank, check.draft, 2);
    expect(merged).toEqual({ scores: [12, 6.5], comments: ["Adding works (app.js:3).", "Clear names."], score: null, feedback: "Well done.", annotations: blank.annotations });
  });

  it("leaves out unknown criteria and keeps what it didn't score", () => {
    const check = validateAiDraft({ rubric_scores: [{ index: 1, score: -2 }, { index: 7, score: 3 }], feedback: "" }, rubric, 20);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.draft.scores).toEqual([null, 0]);
    expect(check.draft.notes.join(" ")).toMatch(/index 7/);
    expect(check.draft.notes.join(" ")).toMatch(/No score for "Adding items works"/);
    expect(check.draft.notes.join(" ")).toMatch(/No feedback/);
    expect(check.draft.confidence).toBeNull();
    const merged = mergeAiDraft({ ...blank, scores: [9, null], feedback: "Mine" }, check.draft, 2);
    expect(merged.scores).toEqual([9, 0]);
    expect(merged.feedback).toBe("Mine");
  });

  it("is refused when nothing is usable, saying what is wrong", () => {
    expect(validateAiDraft([], rubric, 20)).toEqual({ ok: false, errors: [expect.stringMatching(/JSON object/)] });
    expect(validateAiDraft({ feedback: "x" }, rubric, 20)).toEqual({ ok: false, errors: [expect.stringMatching(/rubric_scores must be a list/)] });
    expect(validateAiDraft({ rubric_scores: [{ index: 0, score: "lots" }] }, rubric, 20)).toEqual({ ok: false, errors: ["No criterion has a usable score."] });
    expect(parseDraftText('{"rubric_scores": [')).toEqual({ ok: false, errors: [expect.stringMatching(/not valid JSON/)] });
  });

  it("without a rubric: the final score, clamped", () => {
    const check = validateAiDraft({ rubric_scores: [], score: 25, feedback: "ok", confidence: "high" }, [], 20);
    expect(check.ok && check.draft.score).toBe(20);
    expect(validateAiDraft({ score: null }, [], 20).ok).toBe(false);
    const merged = check.ok ? mergeAiDraft({ scores: [], comments: [], score: null, feedback: "", annotations: [] }, check.draft, 0) : null;
    expect(merged).toMatchObject({ score: 20, feedback: "ok" });
  });
});

describe("tests summary", () => {
  it("counts and lists failures", () => {
    expect(testsSummary([])).toBeNull();
    expect(testsSummary([{ name: "adds", status: "passed" }, { name: "removes", status: "failed", message: "expected 0\nat x" }])).toEqual({ passed: 1, failed: 1, total: 2, summary: "FAILED removes: expected 0" });
  });
});
