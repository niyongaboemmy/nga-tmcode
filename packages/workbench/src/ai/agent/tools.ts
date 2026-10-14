import { recordActivity, runAs, type Actor } from "../../activity/log";
import { ensureDocument, getDocument, saveDocument } from "../../monaco/documents";
import { applyExternalChanges } from "../../monaco/external";
import { monaco } from "../../monaco/setup";
import { buildRegExp, listFiles, searchText } from "../../parts/search/search";
import { getPlatform, moveEntry, openFile } from "../../state/store";

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

export type ToolName = (typeof TOOL_DEFS)[number]["name"];
export const READ_ONLY = new Set<string>(["list_files", "read_file", "search", "get_problems"]);

export function toolDefs(mode: AgentMode, canRun: boolean) {
  return TOOL_DEFS.filter((t) => (mode === "plan" ? READ_ONLY.has(t.name) : t.name !== "run_command" || canRun)).map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> } }));
}

// ── what needs the student's OK, by mode (Claude Code's permission modes) ──

/** A command that only reads, tests, builds or runs the student's own program. */
const SAFE_COMMAND = /^\s*(npm (test|run (test|build|lint|start|dev))|npx (vitest|jest|tsc|eslint|prettier --check)|yarn (test|build|lint)|pnpm (test|build|lint)|node [\w./-]+|python3? [\w./-]+|pytest|go (test|run|build|vet)|cargo (test|build|check|run)|mvn (-q )?(test|compile)|gradle(w)? (test|build)|javac [\w./ -]+|java [\w./-]+|dotnet (test|build|run)|php [\w./-]+|ruby [\w./-]+|ls\b|cat |pwd|git (status|diff|log)\b|echo )[^;&|`$<>]*$/;
const RISKY_COMMAND = /\b(rm|rmdir|del|sudo|chmod|chown|curl|wget|ssh|scp|git (push|reset|clean|checkout)|npm (i|install|publish|uninstall)|pip3? install|brew|apt|mkfs|dd)\b|[>|&;`$]/;

export type Verdict = "allow" | "ask" | "refuse";

export function permission(mode: AgentMode, name: string, args: Record<string, unknown>): Verdict {
  if (READ_ONLY.has(name)) return "allow";
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

export async function runTool(call: ToolCall, cp: Checkpoint, signal: { cancelled: boolean }): Promise<ToolResult> {
  const a = parseArgs(call);
  const fs = getPlatform().fs;
  try {
    switch (call.function.name as ToolName) {
      case "list_files": {
        const all = await listFiles(fs);
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
        return { ok: true, output: clip(numbered), summary: `Read ${name(path)}${start > 1 || end < all.length ? ` (lines ${start}–${end})` : ` (${all.length} lines)`}` };
      }
      case "search": {
        const q = String(a.query ?? "");
        const re = buildRegExp({ query: q, matchCase: false, wholeWord: false, regex: !!a.regex });
        const rx = typeof re === "string" ? new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : re;
        const budget = { left: 200 };
        const out: string[] = [];
        for (const p of await listFiles(fs)) {
          if (budget.left <= 0 || signal.cancelled) break;
          const text = await fs.readFile(p).catch(() => null);
          if (text === null || text.length > 500_000) continue;
          const m = searchText(p, text, rx, budget);
          for (const x of m?.matches ?? []) out.push(`${p}:${x.line + 1}: ${x.text.trim().slice(0, 200)}`);
        }
        return { ok: true, output: out.join("\n") || "No matches.", summary: `Searched for "${q.slice(0, 40)}" (${out.length} match${out.length === 1 ? "" : "es"})` };
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
        return { ok: true, output: `Edited ${path}.`, summary: `Edited ${name(path)}`, diff: { path, before, after } };
      }
      case "write_file": {
        const path = cleanPath(a.path);
        const before = await currentText(path).catch(() => null);
        const content = String(a.content ?? "");
        await cp.remember(path);
        await writeText(path, content, before === null);
        if (before === null) openFile(path);
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
        recordActivity({ kind: "terminal", action: "command", text: `TMCode AI ran: ${command.slice(0, 120)} (exit ${code ?? "?"})`, data: { command: command.slice(0, 500), exit: code ?? null }, actor: ACTOR, ai: { by: "TMCode AI", how: "agent ran a command" } });
        return { ok: code === 0, output: clip(`$ ${command}\n${out}\n(exit code ${code ?? "unknown"})`), summary: `Ran \`${command.slice(0, 60)}\` → exit ${code ?? "?"}` };
      }
    }
    return { ok: false, output: `Unknown tool ${call.function.name}.`, summary: `Unknown tool ${call.function.name}` };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    return { ok: false, output: `Error: ${message}`, summary: `${call.function.name.replace(/_/g, " ")} failed: ${message.slice(0, 120)}` };
  }
}
