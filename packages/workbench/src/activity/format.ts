import type { ActivityEvent } from "./log";

/**
 * How the Activity panel (and the Run console) show things: commands as tokens
 * to colour, run results as status chips, event details in plain words, and the
 * day summaries. Pure functions, no workbench imports (unit-tested).
 */

// ── commands ──

export type CommandTokenKind = "program" | "flag" | "string" | "path" | "number" | "variable" | "env" | "operator" | "text" | "space";
export interface CommandToken {
  kind: CommandTokenKind;
  text: string;
}

const OPERATORS = ["&&", "||", ">>", "2>&1", "2>", "|", ";", ">", "<", "&"];
const PATH_RE = /^(\.{1,2}\/|~\/|\/)|[\\/]|\.[A-Za-z0-9]{1,8}$/;

/** Splits a shell line into words, operators and spaces (quotes kept with their word). */
function lex(line: string): { word: string; quoted: boolean; op: boolean; space: boolean }[] {
  const out: { word: string; quoted: boolean; op: boolean; space: boolean }[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) {
      let j = i;
      while (j < line.length && /\s/.test(line[j])) j++;
      out.push({ word: line.slice(i, j), quoted: false, op: false, space: true });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => line.startsWith(o, i));
    if (op) {
      out.push({ word: op, quoted: false, op: true, space: false });
      i += op.length;
      continue;
    }
    let j = i;
    let quoted = false;
    while (j < line.length && !/\s/.test(line[j]) && !(OPERATORS.some((o) => line.startsWith(o, j)) && j > i && !/["']/.test(line[j]))) {
      const q = line[j];
      if (q === '"' || q === "'") {
        quoted = true;
        const end = line.indexOf(q, j + 1);
        j = end < 0 ? line.length : end + 1;
      } else if (q === "\\" && j + 1 < line.length) {
        j += 2;
      } else {
        j++;
      }
    }
    out.push({ word: line.slice(i, j), quoted, op: false, space: false });
    i = j;
  }
  return out;
}

function classify(word: string, quoted: boolean): CommandTokenKind {
  if (quoted && /^["'].*["']$/s.test(word)) return "string";
  if (/^\$(\{[^}]*\}|\w+|\(.*\))$/.test(word)) return "variable";
  if (/^-?\d+(\.\d+)?$/.test(word)) return "number";
  if (/^--?[A-Za-z0-9]/.test(word)) return "flag";
  if (quoted) return "string";
  if (PATH_RE.test(word) && !/^https?:/.test(word)) return "path";
  return "text";
}

/**
 * Tokens of a shell command for colouring: the program of each part of a
 * pipeline or chain, flags, quoted strings, paths, numbers, $variables,
 * leading VAR=value assignments and operators. Joining the texts gives the line back.
 */
export function tokenizeCommand(line: string): CommandToken[] {
  const out: CommandToken[] = [];
  let expectProgram = true;
  for (const t of lex(line)) {
    if (t.space) {
      out.push({ kind: "space", text: t.word });
      continue;
    }
    if (t.op) {
      out.push({ kind: "operator", text: t.word });
      if (!/^\d?>/.test(t.word) && t.word !== "<" && t.word !== "2>&1") expectProgram = true;
      continue;
    }
    if (expectProgram && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.word)) {
      out.push({ kind: "env", text: t.word });
      continue;
    }
    if (expectProgram) {
      out.push({ kind: "program", text: t.word });
      expectProgram = false;
      continue;
    }
    // --flag=value: the flag, "=" and the value on their own.
    const eq = /^(--?[A-Za-z0-9][\w-]*)=(.+)$/s.exec(t.word);
    if (eq) {
      out.push({ kind: "flag", text: eq[1] }, { kind: "operator", text: "=" }, { kind: classify(eq[2], /["']/.test(eq[2])), text: eq[2] });
      continue;
    }
    out.push({ kind: classify(t.word, t.quoted), text: t.word });
  }
  return out;
}

const ANSI: Partial<Record<CommandTokenKind, string>> = {
  program: "\x1b[1m",
  flag: "\x1b[36m",
  string: "\x1b[33m",
  number: "\x1b[32m",
  variable: "\x1b[35m",
  env: "\x1b[35m",
  operator: "\x1b[90m",
};

/** The command coloured for a terminal (xterm): program bold, flags cyan, strings yellow… */
export function ansiCommand(line: string): string {
  return tokenizeCommand(line)
    .map((t) => (ANSI[t.kind] ? `${ANSI[t.kind]}${t.text}\x1b[0m` : t.text))
    .join("");
}

/** The command an entry ran, when it has one (terminal commands, runs that know their command line). */
export function commandOf(e: Pick<ActivityEvent, "data">): string | null {
  const c = e.data?.command;
  return typeof c === "string" && c.trim() ? c.trim() : null;
}

// ── durations and run results ──

/** "12 ms", "1.2 s", "2 min 5 s", "1 h 3 min". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}

export type RunTone = "ok" | "fail" | "stopped" | "running";
export interface RunStatus {
  tone: RunTone;
  /** "exit 0", "exit 1", "stopped", "timed out", "running". */
  label: string;
  /** "1.2 s", when known. */
  duration?: string;
}

/**
 * A run's or command's result from its data (`status`, `exit`, `duration_ms`), or null when the
 * entry doesn't know one (a command typed in a terminal: the shell doesn't say).
 */
export function runStatusOf(e: Pick<ActivityEvent, "data">): RunStatus | null {
  const d = e.data ?? {};
  const status = typeof d.status === "string" ? d.status : null;
  const exit = typeof d.exit === "number" ? d.exit : null;
  const duration = typeof d.duration_ms === "number" ? formatDuration(d.duration_ms) : undefined;
  const withDuration = (s: RunStatus): RunStatus => (duration ? { ...s, duration } : s);
  if (status === "running") return { tone: "running", label: "running" };
  if (status === "stopped") return withDuration({ tone: "stopped", label: "stopped" });
  if (status === "timed-out") return withDuration({ tone: "fail", label: "timed out" });
  if (status === "too-much-output") return withDuration({ tone: "fail", label: "too much output" });
  if (status === "build-failed") return withDuration({ tone: "fail", label: exit !== null ? `build failed · exit ${exit}` : "build failed" });
  if (exit !== null) return withDuration({ tone: exit === 0 ? "ok" : "fail", label: `exit ${exit}` });
  if (status === "ok") return withDuration({ tone: "ok", label: "done" });
  if (status === "error") return withDuration({ tone: "fail", label: "error" });
  return null;
}

/** The status in words for screen readers and tooltips: "exited with code 0 in 1.2 s". */
export function runStatusWords(s: RunStatus): string {
  const base = s.label.startsWith("exit ") ? `exited with code ${s.label.slice(5)}` : s.label;
  return s.duration ? `${base} in ${s.duration}` : base;
}

// ── words ──

/** "1 action", "3 actions", "1 file change". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A run action's label as a past action: "Run main.cpp" → "main.cpp", anything else as it is. */
export function runSubject(label: string): string {
  return label.replace(/^Run\s+/, "");
}

// ── details ──

const ORIGIN: Record<string, string> = { inside: "Copied inside TMCode", outside: "From outside TMCode", ai: "From an AI's answer" };

/** Data keys shown in details, with their label and how the value reads. Keys not here are shown humanised; `null` hides one. */
const KEYS: Record<string, { label: string; value?: (v: string | number | boolean, d: Record<string, unknown>) => string } | null> = {
  command: { label: "Command" },
  exit: { label: "Exit code" },
  duration_ms: { label: "Duration", value: (v) => formatDuration(Number(v)) },
  status: {
    label: "Result",
    value: (v, d) => {
      const s = runStatusOf({ data: d as ActivityEvent["data"] });
      return s ? runStatusWords({ ...s, duration: undefined }) : String(v);
    },
  },
  origin: { label: "Came from", value: (v) => ORIGIN[String(v)] ?? String(v) },
  chars: { label: "Characters", value: (v) => Number(v).toLocaleString() },
  lines: { label: "Lines", value: (v) => Number(v).toLocaleString() },
  where: { label: "Where" },
  terminal: { label: "Terminal" },
  seconds: { label: "Time away", value: (v) => formatDuration(Number(v) * 1000) },
  from: { label: "Left at", value: (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : String(v)) },
  files: { label: "Files" },
  count: { label: "How many" },
  profile: { label: "Runtime" },
  language: { label: "Language" },
  reason: { label: "Why" },
  config: { label: "Configuration" },
  revision: { label: "Version" },
  uploaded: { label: "Files uploaded" },
  version: { label: "Version" },
  branch: { label: "Branch" },
  changes: { label: "Changes" },
  from_ai: { label: "Copied from" },
  starter: { label: "Starter" },
  attempt: { label: "Tried to" },
  where_run: { label: "Ran on" },
  // Bookkeeping: the kind of run action, ids, flags already shown elsewhere.
  kind: null,
  ai: null,
  trash: null,
  link: null,
  project: null,
  ids: null,
  id: { label: "Extension" },
};

const FIRST = ["status", "exit", "duration_ms", "command"];

/** The entry's data as label/value rows for its details: plain words, formatted values, internal keys hidden. */
export function detailRows(e: Pick<ActivityEvent, "data">): { key: string; label: string; value: string }[] {
  const d = (e.data ?? {}) as Record<string, string | number | boolean | null>;
  const rows: { key: string; label: string; value: string }[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined || v === "") continue;
    const spec = KEYS[k];
    if (spec === null) continue;
    // The result already says the exit code.
    if (k === "exit" && typeof d.status === "string") continue;
    const label = spec?.label ?? humanize(k);
    const value = spec?.value ? spec.value(v, d) : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
    if (value) rows.push({ key: k, label, value });
  }
  // How it ended first, then the command; the rest as recorded.
  const rank = (k: string) => {
    const i = FIRST.indexOf(k);
    return i < 0 ? FIRST.length : i;
  };
  return rows.sort((a, b) => rank(a.key) - rank(b.key));
}

function humanize(key: string): string {
  const s = key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── day summaries ──

export interface DaySummary {
  actions: number;
  ai: number;
  aiTools: string[];
  files: number;
  pastes: number;
  outsidePastes: number;
  runs: number;
  failedRuns: number;
  awayMs: number;
}

/** What a day's entries add up to (shown on its header). */
export function summarize(events: Pick<ActivityEvent, "kind" | "action" | "ai" | "data">[]): DaySummary {
  const s: DaySummary = { actions: events.length, ai: 0, aiTools: [], files: 0, pastes: 0, outsidePastes: 0, runs: 0, failedRuns: 0, awayMs: 0 };
  const tools = new Set<string>();
  for (const e of events) {
    if (e.ai) {
      s.ai++;
      tools.add(e.ai.by);
    }
    if (e.kind === "file") s.files++;
    if (e.action === "paste" || e.action === "drop") {
      s.pastes++;
      if (e.data?.origin === "outside") s.outsidePastes++;
    }
    if (e.kind === "run" && e.action === "run") {
      s.runs++;
      if (runStatusOf(e)?.tone === "fail") s.failedRuns++;
    }
    if (e.action === "away" && typeof e.data?.seconds === "number") s.awayMs += e.data.seconds * 1000;
  }
  s.aiTools = [...tools];
  return s;
}
