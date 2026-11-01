import { recordActivity } from "../activity/log";
import { registerCommand } from "../commands/registry";
import { getDocument, pathOfUri } from "../monaco/documents";
import { revealInEditor } from "../monaco/reveal";
import { monaco, setupMonaco } from "../monaco/setup";
import { activeFilePath, getPlatform, notify, showAuxiliaryView, useWorkbench } from "../state/store";
import { aiMaySee, forAi } from "./agent/guard";
import { gradingTools } from "./agent/tools";
import { ask } from "./chat";

const gradingContext = () => gradingTools.chatContext?.() ?? null;
import { aiGate } from "./gate";
import { chat, type WireMessage } from "./service";
import { create } from "zustand";

/**
 * TMCode AI where the work is (proposal 1.4):
 * - L4 click-to-fix / click-to-explain: every error and warning gets "Explain this problem" (all
 *   layers with AI) and, in Industrial, "Fix this problem" as an editor quick fix;
 * - E5 the AI reviewer: comments on your code in the Problems panel, never edits (Learning's core);
 * - C13 Debug mode (Industrial) / Debug coach (Learning): hypotheses, where to look, you reproduce;
 * - N6 the code tour: a guided walk through the project, a sentence at each stop.
 * The reply language (H3) goes with every question (chat.ts).
 */

const REVIEW_OWNER = "tmcode-ai-review";

function problemText(m: monaco.editor.IMarkerData, path: string, model: monaco.editor.ITextModel) {
  const line = model.getLineContent(m.startLineNumber).trim();
  return `${path}:${m.startLineNumber}: ${m.message}\nThe line: ${line}`;
}

/** Explain (words) or fix (Industrial) one problem, in the chat. */
export function askAboutProblem(kind: "explain" | "fix", text: string) {
  const g = aiGate();
  if (!g.chat) return notify("info", g.message ?? "TMCode AI is off.");
  showAuxiliaryView("chat");
  if (kind === "fix" && g.edit) return void ask(`Fix this problem, with the smallest change:\n${text}`, { file: true, problems: true }, "manual");
  // Learning (and "explain" anywhere): ask first, then a graded hint (Rule 5: don't auto-explain).
  void ask(`Help me understand this problem. First ask me what I think it means, then give a hint (the concept, then where to look). Don't write the fix.\n${text}`, { file: true, problems: true }, "chat");
}

let actionsWired = false;
function wireCodeActions() {
  if (actionsWired) return;
  actionsWired = true;
  setupMonaco();
  monaco.languages.registerCodeActionProvider("*", {
    provideCodeActions(model, _range, context) {
      const g = aiGate();
      if (!g.chat || model.uri.scheme !== "tmcode" || !aiMaySee(pathOfUri(model.uri))) return { actions: [], dispose() {} };
      const path = pathOfUri(model.uri);
      const actions: monaco.languages.CodeAction[] = [];
      for (const m of context.markers.filter((x) => x.severity >= monaco.MarkerSeverity.Warning && x.source !== "TMCode AI review").slice(0, 3)) {
        const text = problemText(m, path, model);
        actions.push({ title: "TMCode AI: Explain this problem", kind: "quickfix", diagnostics: [m], command: { id: "tmcodeAI.explainProblem", title: "Explain", arguments: [text] } });
        if (g.edit) actions.push({ title: "TMCode AI: Fix this problem", kind: "quickfix", diagnostics: [m], command: { id: "tmcodeAI.fixProblem", title: "Fix", arguments: [text] } });
      }
      return { actions, dispose() {} };
    },
  });
  monaco.editor.registerCommand("tmcodeAI.explainProblem", (_a, text: string) => askAboutProblem("explain", text));
  monaco.editor.registerCommand("tmcodeAI.fixProblem", (_a, text: string) => askAboutProblem("fix", text));
}

// ── E5: the reviewer (comments, never edits) ──

/** "L12: comment" lines → review comments (words only, so it passes Learning's filter). */
export function parseReview(text: string): { line: number; severity: "warning" | "info"; comment: string }[] {
  const out: { line: number; severity: "warning" | "info"; comment: string }[] = [];
  for (const raw of text.split("\n")) {
    const m = /^\s*[-*]?\s*L(\d+)\s*(?:\((bug|risk|warning|style|info|tip)\))?\s*[:\-–]\s*(.+)$/i.exec(raw);
    if (!m) continue;
    const kind = (m[2] ?? "").toLowerCase();
    out.push({ line: Number(m[1]), severity: kind === "bug" || kind === "risk" || kind === "warning" ? "warning" : "info", comment: m[3].trim().slice(0, 400) });
  }
  return out.slice(0, 30);
}

/** One answer, not shown in the chat (the reviewer and the tour). */
function quietAnswer(question: string, fileText?: string, file?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const wire: WireMessage[] = [{ role: "user", content: question }];
    chat(wire, { ...(file ? { file } : {}), ...(fileText ? { fileText } : {}) }, { meta() {}, delta: (t) => (text += t), done: () => resolve(text), error: reject }).catch(reject);
  });
}

export async function reviewFile(path = activeFilePath()) {
  const g = aiGate();
  if (!g.chat) return notify("info", g.message ?? "TMCode AI is off.");
  if (!path || !aiMaySee(path)) return notify("info", "Open a file to review (files kept away from AI can't be reviewed).");
  const model = getDocument(path);
  const text = model?.getValue() ?? (await getPlatform().fs.readFile(path).catch(() => ""));
  if (!text.trim()) return notify("info", "This file is empty.");
  notify("info", `TMCode AI is reviewing ${path.slice(path.lastIndexOf("/") + 1)}…`);
  let answer = "";
  try {
    answer = await quietAnswer(
      `Review this file like a careful senior reviewer. Comment only; do not write code or fixes. One comment per line, in this exact form:\nL<line number> (<bug|risk|style|tip>): <one sentence in plain words>\nAt most 10 comments, most important first. If it looks good, write: L1 (tip): Looks good.`,
      forAi(text.slice(0, 60_000)),
      path,
    );
  } catch (e) {
    return notify("warning", String((e as Error)?.message ?? e));
  }
  const comments = parseReview(answer);
  if (model) {
    monaco.editor.setModelMarkers(
      model,
      REVIEW_OWNER,
      comments.map((c) => ({ startLineNumber: c.line, endLineNumber: c.line, startColumn: 1, endColumn: model.getLineMaxColumn(Math.min(c.line, model.getLineCount())), severity: c.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info, message: c.comment, source: "TMCode AI review" })),
    );
  }
  recordActivity({ kind: "ai", action: "review", path, text: `TMCode AI reviewed ${path} (${comments.length} comment${comments.length === 1 ? "" : "s"})`, data: { comments: comments.length }, actor: { type: "tmcode-ai" }, ai: { by: "TMCode AI", how: "review comments (no edits)" } });
  notify("info", comments.length ? `${comments.length} review comment${comments.length === 1 ? "" : "s"} in the Problems panel.` : "The reviewer had nothing to say.");
}

// ── C13: Debug mode / Debug coach ──

export function debugWithAi() {
  const g = aiGate();
  if (!g.chat) return notify("info", g.message ?? "TMCode AI is off.");
  showAuxiliaryView("chat");
  if (g.tutor) {
    return void ask(
      "Be my debug coach. Ask me what I expected and what happened. Then give 2-3 hypotheses in words, and for the most likely one tell me WHERE to put a breakpoint or a print and what to look at. I'll run it and tell you what I saw. Don't write the fix.",
      { file: true, problems: true },
      "chat",
    );
  }
  void ask(
    "Debug mode: 1) ask me what I expected and what happened if it isn't clear; 2) list 2-3 hypotheses; 3) add temporary logging (mark each line with // TMCODE-DEBUG) where it would tell them apart; 4) ask me to reproduce and paste what I saw (or run it yourself if it's a command); 5) fix the cause; 6) remove every TMCODE-DEBUG line.",
    { file: true, problems: true },
    "manual",
  );
}

// ── N6: the code tour ──

export interface TourStop {
  path: string;
  line: number;
  text: string;
}

interface TourState {
  stops: TourStop[];
  at: number;
}

export const useTour = create<TourState>(() => ({ stops: [], at: -1 }));

/** "path:line — sentence" lines → tour stops (only files that exist in the project). */
export function parseTour(text: string, exists: (path: string) => boolean): TourStop[] {
  const out: TourStop[] = [];
  for (const raw of text.split("\n")) {
    const m = /^\s*(?:\d+[.)]\s*)?`?([\w./-]+\.\w+)`?:(\d+)`?\s*[—–:-]+\s*(.+)$/.exec(raw);
    if (m && exists(m[1])) out.push({ path: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 300) });
  }
  return out.slice(0, 15);
}

let tourDecor: monaco.editor.IEditorDecorationsCollection | null = null;

export function goToStop(at: number) {
  const { stops } = useTour.getState();
  if (at < 0 || at >= stops.length) return;
  useTour.setState({ at });
  const s = stops[at];
  revealInEditor(s.path, s.line);
  setTimeout(() => {
    tourDecor?.clear();
    const ed = monaco.editor.getEditors().find((e) => e.getModel()?.uri.path === `/${s.path}`);
    tourDecor = ed?.createDecorationsCollection([{ range: new monaco.Range(s.line, 1, s.line, 1), options: { isWholeLine: true, className: "tm-tour-line", hoverMessage: { value: `**Tour ${at + 1}/${stops.length}:** ${s.text}` } } }]) ?? null;
  }, 120);
}

export function endTour() {
  tourDecor?.clear();
  useTour.setState({ stops: [], at: -1 });
}

export async function startTour() {
  const g = aiGate();
  if (!g.chat) return notify("info", g.message ?? "TMCode AI is off.");
  const { repoMap } = await import("./agent/codebase");
  const fs = getPlatform().fs;
  const map = await repoMap(fs, "", 6000);
  notify("info", "TMCode AI is preparing a tour of this project…");
  let answer = "";
  try {
    answer = await quietAnswer(
      `Write a guided tour of this project for a newcomer: 5-10 stops in the order to read them. One stop per line, exactly:\n<path>:<line> — <one plain sentence about what happens there>\nUse only files and lines from this map. No code.\n\nThe project map:\n${map}`,
    );
  } catch (e) {
    return notify("warning", String((e as Error)?.message ?? e));
  }
  const known = new Set(map.split("\n").map((l) => l.replace(/ \(used.*$/, "").trim()));
  const stops = parseTour(answer, (p) => known.has(p) && aiMaySee(p));
  if (!stops.length) return notify("info", "The tour couldn't be made for this project. Try again, or ask in the chat.");
  useTour.setState({ stops, at: 0 });
  recordActivity({ kind: "ai", action: "tour", text: `TMCode AI made a code tour (${stops.length} stops)`, data: { stops: stops.length }, actor: { type: "tmcode-ai" }, ai: { by: "TMCode AI", how: "code tour (read-only)" } });
  goToStop(0);
}

let wired = false;
export function wireAiActions() {
  if (wired) return;
  wired = true;
  wireCodeActions();
  const chatOn = () => aiGate().chat;
  registerCommand({ id: "tmcodeAI.review", title: "Review My Code (Comments Only)", category: "TMCode AI", enabled: chatOn, run: () => void reviewFile() });
  registerCommand({ id: "tmcodeAI.clearReview", title: "Clear Review Comments", category: "TMCode AI", run: () => monaco.editor.getModels().forEach((m) => monaco.editor.setModelMarkers(m, REVIEW_OWNER, [])) });
  registerCommand({ id: "tmcodeAI.debug", title: "Debug With Me", category: "TMCode AI", aliases: ["debug mode", "debug coach"], enabled: chatOn, run: debugWithAi });
  registerCommand({ id: "tmcodeAI.tour", title: "Tour This Project", category: "TMCode AI", aliases: ["code tour", "walkthrough"], enabled: chatOn, run: () => void startTour() });
  registerCommand({ id: "tmcodeAI.tourNext", title: "Code Tour: Next Stop", category: "TMCode AI", enabled: () => useTour.getState().at >= 0, run: () => goToStop(useTour.getState().at + 1) });
  registerCommand({ id: "tmcodeAI.tourPrevious", title: "Code Tour: Previous Stop", category: "TMCode AI", enabled: () => useTour.getState().at > 0, run: () => goToStop(useTour.getState().at - 1) });
  registerCommand({
    id: "tmcodeAI.syncRules",
    title: "Sync AI Rules from AGENTS.md",
    category: "TMCode AI",
    aliases: ["CLAUDE.md", "GEMINI.md", "copilot instructions", "cursor rules"],
    run: async () => {
      const { syncVendorRules } = await import("./agent/projectRules");
      const r = await syncVendorRules(getPlatform().fs);
      if (!r) return notify("info", "Write the project's rules in AGENTS.md first (the one source every AI follows).");
      notify("info", `${r.written.length ? `Wrote ${r.written.join(", ")} from AGENTS.md.` : ""}${r.kept.length ? ` Left ${r.kept.join(", ")} as written by hand.` : ""}`.trim());
    },
  });
  registerCommand({
    id: "tmcodeAI.aiUseStatement",
    title: "Show My AI-Use Statement",
    category: "TMCode AI",
    run: async () => {
      const { aiUseStatement, summariseAiUse } = await import("../activity/aiStatement");
      const { useActivityLog } = await import("../activity/log");
      notify("info", aiUseStatement(summariseAiUse(useActivityLog.getState().events)));
    },
  });
  registerCommand({
    id: "tmcodeAI.explainYourCode",
    title: "Explain-Your-Code Questions (Grading)",
    category: "Grading",
    enabled: () => chatOn() && !!gradingContext(),
    run: () => {
      showAuxiliaryView("chat");
      void ask(
        "Write 3 to 5 questions that check whether the student understands THEIR OWN code in this submission (e.g. 'Why does line 14 use <=?', 'What happens if the list is empty?'). Cite the file and line for each, add what a good answer would mention, and don't grade: I'll ask them and judge the answers.",
        { file: true, problems: false },
        "plan",
      );
    },
  });
  registerCommand({ id: "tmcodeAI.tourEnd", title: "Code Tour: End", category: "TMCode AI", enabled: () => useTour.getState().at >= 0, run: endTour });
}

/** The reply language for a question (H3): null when "auto". */
export function replyLanguage(): "English" | "French" | "Kinyarwanda" | null {
  const v = useWorkbench.getState().settings["tmcodeAI.replyLanguage"];
  return v === "en" ? "English" : v === "fr" ? "French" : v === "rw" ? "Kinyarwanda" : null;
}
