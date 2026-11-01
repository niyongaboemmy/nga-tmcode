import type { Layer } from "@tmcode/protocol";
import { recordActivity, runAs, type Actor } from "../../activity/log";
import { ensureDocument, getDocument, saveDocument } from "../../monaco/documents";
import { applyExternalChanges } from "../../monaco/external";
import { monaco } from "../../monaco/setup";
import { buildRegExp, listFiles, searchText } from "../../parts/search/search";
import { getPlatform, moveEntry, openFile, useWorkbench } from "../../state/store";
import { aiMaySee, forAi } from "./guard";

/**
 * What TMCode AI's agent can do in the project (the tools it is given, Claude Code's set in small):
 * look (list, read, search, problems) and act (create, edit, write, rename, delete, run a command).
 * Acting tools change files through the editor's documents (open tabs follow, ⌘Z works), are
 * recorded in the activity log as TMCode AI, and keep the original for "Undo all".
 */

export type AgentMode = "manual" | "edit" | "plan" | "auto";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const ACTOR: Actor = { type: "tmcode-ai" };
const str = { type: "string" } as const;

export const TOOL_DEFS = [
  { name: "list_files", description: "List the project's files (paths relative to the project folder). Optional `under` folder.", parameters: { type: "object", properties: { under: str } } },
  { name: "read_file", description: "Read a text file. Optional 1-based start_line/end_line for long files.", parameters: { type: "object", properties: { path: str, start_line: { type: "integer" }, end_line: { type: "integer" } }, required: ["path"] } },
  { name: "search", description: "Search the project's files for text (or a regex when regex=true). Returns file:line: text matches.", parameters: { type: "object", properties: { query: str, regex: { type: "boolean" } }, required: ["query"] } },
  { name: "get_problems", description: "The errors and warnings the editor reports, for one file or all open files.", parameters: { type: "object", properties: { path: str } } },
  { name: "edit_file", description: "Replace exact text in a file. old_text must appear exactly once (copy it from read_file, with enough lines to be unique).", parameters: { type: "object", properties: { path: str, old_text: str, new_text: str }, required: ["path", "old_text", "new_text"] } },
  { name: "write_file", description: "Create a file, or replace a whole file's content.", parameters: { type: "object", properties: { path: str, content: str }, required: ["path", "content"] } },
  { name: "rename_file", description: "Rename or move a file.", parameters: { type: "object", properties: { from: str, to: str }, required: ["from", "to"] } },
  { name: "delete_file", description: "Delete a file (it goes to the Trash).", parameters: { type: "object", properties: { path: str }, required: ["path"] } },
  { name: "run_command", description: "Run a shell command in the project folder (tests, a build, the program) and get its output.", parameters: { type: "object", properties: { command: str }, required: ["command"] } },
] as const;

/**
 * While a teacher reviews a submission: the grading tools. `propose_grade` only fills the grade form
 * as an AI draft (the teacher reviews and saves); it never saves anything.
 */
export const GRADING_TOOL_DEFS = [
  { name: "get_grading_context", description: "The grading task: the activity, its brief, the rubric (index, criteria, max_score), the student and any test results. Call it before grading.", parameters: { type: "object", properties: {} } },
  {
    name: "propose_grade",
    description:
      "Fill the teacher's grade form with your draft (it is NOT saved: the teacher reviews, adjusts and saves). rubric_scores: one per criterion, score 0..max_score in half points, comment for the student citing files and lines. score: only when there is no rubric. feedback: to the student. teacher_notes: for the teacher only. confidence: low, medium or high.",
    parameters: {
      type: "object",
      properties: {
        rubric_scores: { type: "array", items: { type: "object", properties: { index: { type: "integer" }, score: { type: "number" }, comment: str }, required: ["index", "score"] } },
        score: { type: ["number", "null"] },
        feedback: str,
        teacher_notes: str,
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["rubric_scores", "feedback", "confidence"],
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]["name"];
export const READ_ONLY = new Set<string>(["list_files", "read_file", "search", "get_problems", "get_grading_context"]);
/** Tools that change nothing on disk and save nothing (allowed in every mode, Plan included). */
const HARMLESS = new Set<string>(["propose_grade"]);

/** The draft file any AI may write in a review folder (the only file there that may change). */
export const GRADING_DRAFT_PATH = ".tmcode/grading/draft.json";

/**
 * The tools for a request. In the Learning layer only the looking tools (the tutor reads the
 * student's code, it never changes it; Task Mentor drops any other tool too).
 */
export function toolDefs(mode: AgentMode, canRun: boolean, grading = false, layer: Layer = "industrial") {
  const defs: readonly { name: string; description: string; parameters: unknown }[] = layer === "learning" ? TOOL_DEFS : [...TOOL_DEFS, ...(grading ? GRADING_TOOL_DEFS : [])];
  return defs
    .filter((t) => (layer === "learning" ? READ_ONLY.has(t.name) : mode === "plan" ? READ_ONLY.has(t.name) || HARMLESS.has(t.name) : t.name !== "run_command" || canRun))
    .map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> } }));
}

// ── what needs the student's OK, by mode (Claude Code's permission modes) ──

/** A command that only reads, tests, builds or runs the student's own program. */
const SAFE_COMMAND = /^\s*(npm (test|run (test|build|lint|start|dev))|npx (vitest|jest|tsc|eslint|prettier --check)|yarn (test|build|lint)|pnpm (test|build|lint)|node [\w./-]+|python3? [\w./-]+|pytest|go (test|run|build|vet)|cargo (test|build|check|run)|mvn (-q )?(test|compile)|gradle(w)? (test|build)|javac [\w./ -]+|java [\w./-]+|dotnet (test|build|run)|php [\w./-]+|ruby [\w./-]+|ls\b|cat |pwd|git (status|diff|log)\b|echo )[^;&|`$<>]*$/;
const RISKY_COMMAND = /\b(rm|rmdir|del|sudo|chmod|chown|curl|wget|ssh|scp|git (push|reset|clean|checkout)|npm (i|install|publish|uninstall)|pip3? install|brew|apt|mkfs|dd)\b|[>|&;`$]/;

export type Verdict = "allow" | "ask" | "refuse";

export function permission(mode: AgentMode, name: string, args: Record<string, unknown>, layer: Layer = "industrial"): Verdict {
  if (READ_ONLY.has(name)) return "allow";
  // Learning: the read-only preset, fixed (proposal C7). Exam never gets here (no AI).
  if (layer !== "industrial") return "refuse";
  if (HARMLESS.has(name)) return "allow";
  if (mode === "plan") return "refuse";
  if (mode === "manual") return "ask";
  if (name === "run_command") {
    const cmd = String(args.command ?? "");
    if (mode === "auto" && SAFE_COMMAND.test(cmd) && !RISKY_COMMAND.test(cmd.replace(/^\s*echo .*$/, ""))) return "allow";
    return "ask";
  }
  // Deleting always asks (even in Auto: it is the riskiest file change).
  if (name === "delete_file") return "ask";
  // edit, write, rename: applied directly in Edit automatically and Auto.
  return "allow";
}

// ── checkpoint: what the files were before this request ──

export class Checkpoint {
  readonly before = new Map<string, string | null>();
  async remember(path: string) {
    if (this.before.has(path)) return;
    this.before.set(path, await getPlatform().fs.readFile(path).catch(() => null));
  }
  get files() {
    return [...this.before.keys()];
  }
  /** Puts every changed file back as it was (files the agent created are deleted). */
  async restore() {
    const fs = getPlatform().fs;
    for (const [path, text] of this.before) {
      await runAs(ACTOR, async () => {
        if (text === null) {
          await fs.remove(path).catch(() => undefined);
        } else {
          const model = getDocument(path);
          if (model) {
            model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
            await saveDocument(path).catch(() => undefined);
          } else await fs.writeFile(path, text);
        }
      });
    }
    await applyExternalChanges(this.files);
    recordActivity({ kind: "ai", action: "undo", text: `Undid TMCode AI's changes to ${this.files.length} file${this.files.length === 1 ? "" : "s"}`, data: { files: this.files.join(", ") }, actor: { type: "you" }, ai: { by: "TMCode AI", how: "agent changes undone" } });
  }
}

// ── running a tool ──

const MAX_OUT = 12_000;
const clip = (s: string) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n… (${s.length - MAX_OUT} more characters)` : s);
const lines = (s: string) => s.split("\n").length;
const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function cleanPath(p: unknown): string {
  const s = String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
  if (!s || s.split("/").some((x) => x === "..")) throw new Error(`'${String(p)}' is not a path inside the project.`);
  return s;
}

async function currentText(path: string): Promise<string> {
  const model = getDocument(path);
  if (model) return model.getValue();
  return getPlatform().fs.readFile(path);
}

/** Writes through the editor when the file is open (its tab follows, undoable), else to disk. */
async function writeText(path: string, text: string, created: boolean) {
  const fs = getPlatform().fs;
  await runAs(ACTOR, async () => {
    if (created) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) await fs.createDir(parts.slice(0, i).join("/")).catch(() => undefined);
      await fs.writeFile(path, text);
      await applyExternalChanges([path]);
      return;
    }
    const model = await ensureDocument(path);
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    model.pushStackElement();
    await saveDocument(path);
  });
}

export interface ToolResult {
  /** What the model gets back. */
  output: string;
  /** One line for the chat ("Read app.js (24 lines)"). */
  summary: string;
  /** A change, for the chat's diff preview. */
  diff?: { path: string; before: string; after: string };
  ok: boolean;
}

/** The change an acting tool would make, before it is approved (shown to the student). */
export async function preview(call: ToolCall): Promise<{ title: string; diff?: { path: string; before: string; after: string }; command?: string }> {
  const a = parseArgs(call);
  const n = call.function.name;
  try {
    if (n === "edit_file") {
      const path = cleanPath(a.path);
      const before = await currentText(path);
      return { title: `Edit ${name(path)}`, diff: { path, before, after: replaceOnce(before, String(a.old_text ?? ""), String(a.new_text ?? "")) } };
    }
    if (n === "write_file") {
      const path = cleanPath(a.path);
      const before = await currentText(path).catch(() => "");
      return { title: before ? `Rewrite ${name(path)}` : `Create ${path}`, diff: { path, before, after: String(a.content ?? "") } };
    }
    if (n === "rename_file") return { title: `Rename ${cleanPath(a.from)} → ${cleanPath(a.to)}` };
    if (n === "delete_file") return { title: `Delete ${cleanPath(a.path)}` };
    if (n === "run_command") return { title: "Run a command", command: String(a.command ?? "") };
  } catch (e) {
    return { title: `${n}: ${(e as Error).message}` };
  }
  return { title: n };
}

export function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const v = JSON.parse(call.function.arguments || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function replaceOnce(text: string, oldText: string, newText: string): string {
  if (!oldText) throw new Error("old_text is empty.");
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  const t = norm(text);
  const o = norm(oldText);
  const at = t.indexOf(o);
  if (at < 0) {
    // Tolerate indentation differences (models often re-indent what they copied).
    const strip = (s: string) => s.replace(/^[ \t]+/gm, "");
    if (strip(t).includes(strip(o))) throw new Error("old_text was found only with different indentation. Copy it exactly from read_file, with its spaces.");
    throw new Error("old_text was not found in the file. Read the file again and copy the exact text.");
  }
  if (t.indexOf(o, at + 1) >= 0) throw new Error("old_text appears more than once. Include more lines around it so it is unique.");
  return t.slice(0, at) + norm(newText) + t.slice(at + o.length);
}

/** Hooks for the grading tools (set by the grading module while it is loaded; none: not grading). */
export const gradingTools: {
  context?: () => Promise<unknown>;
  propose?: (args: Record<string, unknown>) => Promise<{ ok: boolean; errors?: string[]; notes?: string[] }>;
  /** The chat's `purpose: "grading"` context while a staff member reviews a submission (null: not grading). */
  chatContext?: () => { purpose: "grading"; grading: NonNullable<import("../service").ChatContext["grading"]> } | null;
} = {};

/** A read-only folder (a submission under review) refuses changes, except the grading draft file. */
function readOnlyRefusal(name: string, a: Record<string, unknown>): ToolResult | null {
  if (!useWorkbench.getState().readOnly || !["edit_file", "write_file", "rename_file", "delete_file"].includes(name)) return null;
  const paths = name === "rename_file" ? [a.from, a.to] : [a.path];
  if (paths.every((p) => String(p ?? "").replace(/^\.\/+/, "") === GRADING_DRAFT_PATH) && name !== "rename_file" && name !== "delete_file") return null;
  return {
    ok: false,
    output: `This folder is read-only (${useWorkbench.getState().readOnlyReason ?? "a submission under review"}). Don't change files here. To grade it, call propose_grade${gradingTools.propose ? "" : ` or write ${GRADING_DRAFT_PATH}`}.`,
    summary: "Refused: the folder is read-only",
  };
}

export async function runTool(call: ToolCall, cp: Checkpoint, signal: { cancelled: boolean }): Promise<ToolResult> {
  const a = parseArgs(call);
  const fs = getPlatform().fs;
  const refused = readOnlyRefusal(call.function.name, a);
  if (refused) return refused;
  if (call.function.name === "get_grading_context") {
    const ctx = gradingTools.context ? await gradingTools.context().catch(() => null) : null;
    return ctx ? { ok: true, output: clip(JSON.stringify(ctx, null, 2)), summary: "Read the grading task (brief and rubric)" } : { ok: false, output: "No submission is open for grading.", summary: "No grading task open" };
  }
  if (call.function.name === "propose_grade") {
    if (!gradingTools.propose) return { ok: false, output: "No submission is open for grading.", summary: "No grading task open" };
    const r = await gradingTools.propose(a);
    return r.ok
      ? { ok: true, output: `The draft is in the teacher's grade form (NOT saved: the teacher reviews and saves it).${r.notes?.length ? ` TMCode adjusted: ${r.notes.join(" ")}` : ""}`, summary: "Proposed a grade (the teacher reviews and saves)" }
      : { ok: false, output: `The draft was not used: ${(r.errors ?? []).join(" ")} Fix it and call propose_grade again.`, summary: "Proposed grade refused" };
  }
  try {
    switch (call.function.name as ToolName) {
      case "list_files": {
        const all = (await listFiles(fs)).filter((f) => aiMaySee(f));
        const under = a.under ? cleanPath(a.under) : "";
        const list = all.filter((p) => !under || p.startsWith(`${under}/`)).slice(0, 400);
        return { ok: true, output: list.join("\n") || "(no files)", summary: `Listed ${list.length} file${list.length === 1 ? "" : "s"}${under ? ` in ${under}` : ""}` };
      }
      case "read_file": {
        const path = cleanPath(a.path);
        const text = await currentText(path);
        const all = text.split("\n");
        const start = Math.max(1, Number(a.start_line) || 1);
        const end = Math.min(all.length, Number(a.end_line) || all.length);
        const numbered = all
          .slice(start - 1, end)
          .map((l, i) => `${String(start + i).padStart(4)}  ${l}`)
          .join("\n");
        return { ok: true, output: clip(forAi(numbered)), summary: `Read ${name(path)}${start > 1 || end < all.length ? ` (lines ${start}–${end})` : ` (${all.length} lines)`}` };
      }
      case "search": {
        const q = String(a.query ?? "");
        const re = buildRegExp({ query: q, matchCase: false, wholeWord: false, regex: !!a.regex });
        const rx = typeof re === "string" ? new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : re;
        const budget = { left: 200 };
        const out: string[] = [];
        for (const p of await listFiles(fs)) {
          if (budget.left <= 0 || signal.cancelled) break;
          if (!aiMaySee(p)) continue;
          const text = await fs.readFile(p).catch(() => null);
          if (text === null || text.length > 500_000) continue;
          const m = searchText(p, text, rx, budget);
          for (const x of m?.matches ?? []) out.push(`${p}:${x.line + 1}: ${x.text.trim().slice(0, 200)}`);
        }
        return { ok: true, output: forAi(out.join("\n")) || "No matches.", summary: `Searched for "${q.slice(0, 40)}" (${out.length} match${out.length === 1 ? "" : "es"})` };
      }
      case "get_problems": {
        const only = a.path ? cleanPath(a.path) : null;
        const markers = monaco.editor
          .getModelMarkers({})
          .filter((m) => m.severity >= monaco.MarkerSeverity.Warning)
          .map((m) => ({ path: m.resource.path.replace(/^\//, ""), m }))
          .filter((x) => !only || x.path === only);
        const out = markers.slice(0, 80).map(({ path, m }) => `${path}:${m.startLineNumber}: ${m.severity === monaco.MarkerSeverity.Error ? "error" : "warning"}: ${m.message}`);
        return { ok: true, output: out.join("\n") || "No problems.", summary: `Checked problems${only ? ` in ${name(only)}` : ""} (${out.length})` };
      }
      case "edit_file": {
        const path = cleanPath(a.path);
        const before = await currentText(path);
        const after = replaceOnce(before, String(a.old_text ?? ""), String(a.new_text ?? ""));
        await cp.remember(path);
        await writeText(path, after, false);
        if (path === GRADING_DRAFT_PATH) await applyExternalChanges([path]);
        return { ok: true, output: `Edited ${path}.`, summary: `Edited ${name(path)}`, diff: { path, before, after } };
      }
      case "write_file": {
        const path = cleanPath(a.path);
        const before = await currentText(path).catch(() => null);
        const content = String(a.content ?? "");
        await cp.remember(path);
        await writeText(path, content, before === null);
        if (path === GRADING_DRAFT_PATH) {
          if (before !== null) await applyExternalChanges([path]);
        } else if (before === null) openFile(path);
        return { ok: true, output: `${before === null ? "Created" : "Wrote"} ${path} (${lines(content)} lines).`, summary: `${before === null ? "Created" : "Rewrote"} ${name(path)}`, diff: { path, before: before ?? "", after: content } };
      }
      case "rename_file": {
        const from = cleanPath(a.from);
        const to = cleanPath(a.to);
        await cp.remember(from);
        await cp.remember(to);
        await runAs(ACTOR, () => moveEntry(from, to));
        return { ok: true, output: `Renamed ${from} to ${to}.`, summary: `Renamed ${name(from)} → ${name(to)}` };
      }
      case "delete_file": {
        const path = cleanPath(a.path);
        await cp.remember(path);
        await runAs(ACTOR, async () => {
          if (fs.trash) await fs.trash(path);
          else await fs.remove(path);
        });
        await applyExternalChanges([path]);
        return { ok: true, output: `Deleted ${path}.`, summary: `Deleted ${name(path)}` };
      }
      case "run_command": {
        const proc = getPlatform().proc;
        if (!proc) return { ok: false, output: "Commands can't run here.", summary: "Couldn't run a command here" };
        const command = String(a.command ?? "");
        let out = "";
        let pid: number | null = null;
        const code = await new Promise<number | null>((resolve) => {
          // At most 2 minutes, and Stop ends it.
          const timer = setTimeout(() => pid !== null && void proc.kill(pid), 120_000);
          const poll = setInterval(() => signal.cancelled && pid !== null && void proc.kill(pid), 300);
          const done = (c: number | null) => {
            clearTimeout(timer);
            clearInterval(poll);
            resolve(c);
          };
          proc
            .run(command, "", (e) => {
              if (e.type === "exit") done(e.code);
              else out += e.data;
            })
            .then((id) => (pid = id))
            .catch((e) => {
              out += String((e as Error)?.message ?? e);
              done(-1);
            });
        });
        recordActivity({ kind: "terminal", action: "command", text: `TMCode AI ran: ${forAi(command).slice(0, 120)} (exit ${code ?? "?"})`, data: { command: forAi(command).slice(0, 500), exit: code ?? null }, actor: ACTOR, ai: { by: "TMCode AI", how: "agent ran a command" } });
        return { ok: code === 0, output: clip(forAi(`$ ${command}\n${out}\n(exit code ${code ?? "unknown"})`)), summary: `Ran \`${command.slice(0, 60)}\` → exit ${code ?? "?"}` };
      }
    }
    return { ok: false, output: `Unknown tool ${call.function.name}.`, summary: `Unknown tool ${call.function.name}` };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    return { ok: false, output: `Error: ${message}`, summary: `${call.function.name.replace(/_/g, " ")} failed: ${message.slice(0, 120)}` };
  }
}
