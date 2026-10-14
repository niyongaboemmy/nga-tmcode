import { isExamRoot } from "../exam/roots";
import { getPlatform, onWorkspaceChanged, useWorkbench, activeFilePath } from "../state/store";
import { isBookkeepingPath, recentlyWritten } from "./fsRecorder";
import { flushActivity, internally, recordActivity, setActivityFolder, setActivityPersistence, sizeText, useActivityLog, type ActivityEvent, type Actor } from "./log";

/**
 * Feeds the activity log: per-folder persistence, copy/cut/paste anywhere in
 * the workbench, and file changes made outside TMCode (a terminal command, a
 * CLI agent, another app), which the file watcher reports.
 */

const DIR = ".tmcode/activity";
/** Days of history loaded when a folder opens (older days stay on disk). */
const DAYS_LOADED = 14;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** An AI agent working right now (an AI extension's chat in use), named for outside changes. Set by the extension bridge. */
export const outsideHint: { likely: () => string | undefined } = { likely: () => undefined };

async function load(root: string): Promise<ActivityEvent[]> {
  if (isExamRoot(root)) return [];
  const fs = getPlatform().fs;
  const files = await fs.readDir(DIR).catch(() => []);
  const days = files
    .filter((f) => f.kind === "file" && /^\d{4}-\d{2}-\d{2}\.json$/.test(f.name))
    .map((f) => f.name)
    .sort()
    .slice(-DAYS_LOADED);
  const out: ActivityEvent[] = [];
  for (const d of days) {
    try {
      const list = JSON.parse(await fs.readFile(`${DIR}/${d}`)) as ActivityEvent[];
      if (Array.isArray(list)) out.push(...list.filter((e) => e && typeof e.t === "number" && typeof e.text === "string"));
    } catch {
      /* a damaged day is skipped, never fatal */
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

let writing: Promise<void> = Promise.resolve();
/** Writes the days that changed since the last write (normally just today). */
function save(root: string, events: ActivityEvent[]) {
  if (isExamRoot(root) || useWorkbench.getState().workspace?.root !== root) return;
  const byDay = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    const d = day(e.t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(e);
  }
  const fs = getPlatform().fs;
  writing = writing.then(() =>
    internally(async () => {
      await fs.createDir(".tmcode").catch(() => {});
      await fs.createDir(DIR).catch(() => {});
      const ignore = await fs.readFile(".tmcode/.gitignore").catch(() => null);
      if (ignore === null) await fs.writeFile(".tmcode/.gitignore", "*\n").catch(() => {});
      for (const [d, list] of byDay) {
        const text = JSON.stringify(list);
        if (written.get(`${root}|${d}`) === text.length + ":" + list[list.length - 1]?.t) continue;
        await fs.writeFile(`${DIR}/${d}.json`, text).catch(() => {});
        written.set(`${root}|${d}`, text.length + ":" + list[list.length - 1]?.t);
      }
    }),
  );
}
const written = new Map<string, string>();

// ── copy, cut, paste ──

const copies: string[] = [];
const norm = (s: string) => s.replace(/\r\n?/g, "\n");
function rememberCopy(text: string) {
  const t = norm(text);
  const at = copies.indexOf(t);
  if (at >= 0) copies.splice(at, 1);
  copies.push(t);
  if (copies.length > 100) copies.shift();
}
/** Was this text copied inside TMCode (this session)? */
export function copiedInside(text: string) {
  const t = norm(text);
  return !!t && copies.some((c) => c.includes(t));
}

type Where = { where: string; path?: string };
function whereOf(target: EventTarget | null): Where {
  const el = target instanceof Element ? target : null;
  if (el?.closest(".monaco-editor")) {
    const path = activeFilePath() ?? undefined;
    return { where: path ? path.slice(path.lastIndexOf("/") + 1) : "the editor", path };
  }
  if (el?.closest(".xterm")) return { where: "the terminal" };
  if (el?.closest(".tm-jsc")) return { where: "the JavaScript Console" };
  if (el?.closest(".tm-chat")) return { where: "TMCode AI chat" };
  if (el?.closest(".tm-quickinput, .quick-input-widget")) return { where: "the Command Palette" };
  if (el?.closest(".tm-sidebar")) return { where: "the side bar" };
  if (el?.closest(".tm-panel")) return { where: "the panel" };
  return { where: "TMCode" };
}

/** Records a copy or cut (the editor, the terminal, a webview…). */
export function recordCopy(kind: "copy" | "cut", text: string, at: Where, actor?: Actor, aiBy?: string) {
  if (!text) return;
  rememberCopy(text);
  recordActivity({
    kind: "clipboard",
    action: kind,
    path: at.path,
    text: `${kind === "copy" ? "Copied" : "Cut"} ${sizeText(text)} in ${at.where}`,
    data: { chars: text.length, lines: norm(text).split("\n").length, where: at.where, ...(aiBy ? { from_ai: aiBy } : {}) },
    ...(actor ? { actor } : {}),
    ...(aiBy ? { ai: { by: aiBy, how: "copied from the AI's answer" } } : {}),
  });
}

/** Records a paste, saying whether the text came from inside TMCode, from an AI's answer, or from outside. */
export function recordPaste(text: string, at: Where) {
  if (!text) return;
  const t = norm(text);
  const fromAi = aiCopies.find((c) => c.text.includes(t) || t.includes(c.text));
  const inside = copiedInside(text);
  const origin = fromAi ? `from ${fromAi.by}'s answer` : inside ? "copied inside TMCode" : "from outside TMCode";
  recordActivity({
    kind: "clipboard",
    action: "paste",
    path: at.path,
    text: `Pasted ${sizeText(text)} into ${at.where} (${origin})`,
    data: { chars: text.length, lines: t.split("\n").length, where: at.where, origin: fromAi ? "ai" : inside ? "inside" : "outside" },
    ...(fromAi ? { ai: { by: fromAi.by, how: "pasted text copied from the AI's answer" } } : {}),
  });
}

/** Text copied from an AI's answer (chat code block, webview), so a later paste of it is AI use. */
const aiCopies: { text: string; by: string }[] = [];
export function rememberAiCopy(text: string, by: string) {
  const t = norm(text);
  if (!t.trim()) return;
  aiCopies.push({ text: t, by });
  if (aiCopies.length > 50) aiCopies.shift();
}

function wireClipboard() {
  // Bubble phase for copy/cut: Monaco and xterm have put their text on the event by then.
  const onCopy = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain") || window.getSelection()?.toString() || "";
    recordCopy(e.type === "cut" ? "cut" : "copy", text, whereOf(e.target));
  };
  // Capture phase for paste: the text is on the event before any widget takes it.
  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    recordPaste(text, whereOf(e.target));
  };
  window.addEventListener("copy", onCopy);
  window.addEventListener("cut", onCopy);
  window.addEventListener("paste", onPaste, true);
}

// ── terminal ──

/** A command run in a terminal (typed by the student, or sent by an extension: then its actor). */
export function recordTerminalCommand(command: string, terminal: string | null, actor?: Actor) {
  const cmd = command.trim();
  if (!cmd) return;
  recordActivity({
    kind: "terminal",
    action: "command",
    text: `Ran in the terminal: ${cmd.length > 120 ? `${cmd.slice(0, 117)}…` : cmd}`,
    data: { command: cmd.slice(0, 500), ...(terminal ? { terminal } : {}) },
    ...(actor ? { actor } : {}),
  });
}

// ── changes on disk TMCode didn't make ──

let expectedUntil = 0;
/** Disk changes TMCode is about to cause itself (git pull, a sync), recorded as that action instead. */
export function expectDiskChanges(ms = 4000) {
  expectedUntil = Math.max(expectedUntil, Date.now() + ms);
}

function wireOutsideChanges() {
  getPlatform().watch?.((paths) => {
    if (Date.now() < expectedUntil) return;
    const outside = paths.filter((p) => p && !isBookkeepingPath(p) && !recentlyWritten(p) && !/(^|\/)(node_modules|dist|build|target|__pycache__|\.next)(\/|$)/.test(p));
    if (!outside.length) return;
    const likely = outsideHint.likely();
    const actor: Actor = { type: "outside", ...(likely ? { likely } : {}) };
    const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
    const text =
      outside.length === 1
        ? `${name(outside[0])} changed outside the editor`
        : `${outside.length} files changed outside the editor: ${outside.slice(0, 4).map(name).join(", ")}${outside.length > 4 ? "…" : ""}`;
    recordActivity({ kind: "file", action: "outside-change", path: outside[0], text, data: { files: outside.slice(0, 30).join(", "), count: outside.length }, actor });
  });
}

let wired = false;
/** Starts the log for the open folder and its sources (once). */
export function wireActivity() {
  if (wired) return;
  wired = true;
  setActivityPersistence(save);
  const open = async () => {
    flushActivity();
    const root = useWorkbench.getState().workspace?.root ?? null;
    setActivityFolder(root, []);
    if (!root) return;
    const events = await load(root).catch(() => []);
    // Still the same folder, and nothing was recorded meanwhile (merge if it was).
    if (useActivityLog.getState().root !== root) return;
    const fresh = useActivityLog.getState().events;
    setActivityFolder(root, [...events, ...fresh.filter((e) => !events.some((x) => x.t === e.t && x.text === e.text))]);
  };
  onWorkspaceChanged(() => void open());
  void open();
  wireClipboard();
  wireOutsideChanges();
  window.addEventListener("beforeunload", () => flushActivity());
}
