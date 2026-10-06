import { pathOfUri } from "../monaco/documents";
import { monaco } from "../monaco/setup";
import { getPlatform, openContextMenu, useWorkbench } from "../state/store";
import { useExam } from "../exam/state";
import { formatKeybinding } from "../commands/registry";
import { showInputBox } from "../widgets/QuickPick";
import { addBreakpoint, breakpointsFor, debugAllowed, debugKindForPath, evaluateForHover, moveBreakpoints, removeBreakpoint, toggleBreakpoint, updateBreakpoint, useDebug, type BreakpointModel } from "./debugService";

/**
 * Breakpoints and the current-line highlight in Monaco, as in VS Code:
 * red dots in the glyph margin (faint dot on hover), conditional/log/disabled/
 * unverified variants, the yellow stopped line with its arrow, and hover
 * evaluation while paused. Decorations live on the *model*, so every editor
 * showing a file shows them and they move with edits.
 */

const TRACKED = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;

function bpGlyph(bp: BreakpointModel, active: boolean, debugging: boolean) {
  const kind = bp.logMessage ? "log" : bp.condition || bp.hitCondition ? "conditional" : "";
  if (!bp.enabled || !active) return `codicon codicon-debug-breakpoint${kind ? `-${kind}` : ""}-disabled tm-bp is-disabled`;
  if (debugging && bp.verified === false) return `codicon codicon-debug-breakpoint${kind ? `-${kind}` : ""}-unverified tm-bp is-unverified`;
  return `codicon codicon-debug-breakpoint${kind ? `-${kind}` : ""} tm-bp`;
}

function bpHover(bp: BreakpointModel): string {
  const parts = [bp.logMessage ? `Log Message: ${bp.logMessage}` : bp.condition ? `Expression: ${bp.condition}` : bp.hitCondition ? `Hit Count: ${bp.hitCondition}` : "Breakpoint"];
  if (bp.verified === false) parts.push(bp.message ?? "Unverified breakpoint");
  if (!bp.enabled) parts.push("(disabled)");
  return parts.join(" — ");
}

/** model uri → { decoration ids, breakpoint id per decoration } */
const modelState = new Map<string, { ids: string[]; bpByDeco: Map<string, string> }>();

function render(model: monaco.editor.ITextModel) {
  if (model.isDisposed() || model.uri.scheme !== "tmcode") return;
  const path = pathOfUri(model.uri);
  const st = useDebug.getState();
  const debugging = st.phase !== "inactive";
  const bps = breakpointsFor(path).filter((b) => b.line <= model.getLineCount());
  const stopped = st.stoppedAt?.path === path ? st.stoppedAt : null;
  const decos: monaco.editor.IModelDeltaDecoration[] = [];
  const bpIndex: string[] = [];
  for (const bp of bps) {
    const onStopped = stopped && stopped.line === bp.line;
    decos.push({
      range: new monaco.Range(bp.line, 1, bp.line, 1),
      options: {
        stickiness: TRACKED,
        glyphMarginClassName: onStopped ? `codicon codicon-debug-breakpoint-stackframe${stopped.top ? "" : "-focused"} tm-bp-frame` : bpGlyph(bp, st.breakpointsActive, debugging),
        glyphMarginHoverMessage: { value: bpHover(bp) },
        zIndex: 20,
      },
    });
    bpIndex.push(bp.id);
  }
  if (stopped && stopped.line <= model.getLineCount()) {
    const hasBp = bps.some((b) => b.line === stopped.line);
    decos.push({
      range: new monaco.Range(stopped.line, 1, stopped.line, 1),
      options: {
        isWholeLine: true,
        className: stopped.top ? "tm-debug-top-frame-line" : "tm-debug-focused-frame-line",
        glyphMarginClassName: hasBp ? undefined : `codicon codicon-debug-stackframe${stopped.top ? "" : "-focused"} tm-bp-frame`,
        overviewRuler: { color: stopped.top ? "#ffcc00" : "#89d185", position: monaco.editor.OverviewRulerLane.Full },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        zIndex: 30,
      },
    });
  }
  const prev = modelState.get(model.uri.toString());
  const ids = model.deltaDecorations(prev?.ids ?? [], decos);
  const bpByDeco = new Map<string, string>();
  bpIndex.forEach((bpId, i) => bpByDeco.set(ids[i], bpId));
  modelState.set(model.uri.toString(), { ids, bpByDeco });
}

function renderAll() {
  for (const m of monaco.editor.getModels()) render(m);
}

/** After an edit, breakpoints follow their (tracked) decorations to new lines. */
function trackMoves(model: monaco.editor.ITextModel) {
  const st = modelState.get(model.uri.toString());
  if (!st) return;
  const moves: { id: string; line: number }[] = [];
  for (const [decoId, bpId] of st.bpByDeco) {
    const range = model.getDecorationRange(decoId);
    const bp = useDebug.getState().breakpoints.find((b) => b.id === bpId);
    if (range && bp && range.startLineNumber !== bp.line) moves.push({ id: bpId, line: range.startLineNumber });
  }
  if (moves.length) moveBreakpoints(pathOfUri(model.uri), moves);
}

let wired = false;

export function wireDebugDecorations() {
  if (wired) return;
  wired = true;
  let prev = useDebug.getState();
  useDebug.subscribe((s) => {
    if (s.breakpoints !== prev.breakpoints || s.stoppedAt !== prev.stoppedAt || s.phase !== prev.phase || s.breakpointsActive !== prev.breakpointsActive) renderAll();
    prev = s;
  });
  const watchModel = (m: monaco.editor.ITextModel) => {
    if (m.uri.scheme !== "tmcode") return;
    render(m);
    m.onDidChangeContent(() => queueMicrotask(() => !m.isDisposed() && trackMoves(m)));
    m.onWillDispose(() => modelState.delete(m.uri.toString()));
  };
  monaco.editor.getModels().forEach(watchModel);
  monaco.editor.onDidCreateModel(watchModel);

  // Hover evaluation while paused (VS Code's debug hover).
  monaco.languages.registerHoverProvider("*", {
    async provideHover(model, position) {
      if (useDebug.getState().phase !== "stopped") return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      // Include a dotted / indexed prefix (obj.field, list[0]).
      const line = model.getLineContent(position.lineNumber);
      let start = word.startColumn - 1;
      while (start > 0 && /[\w.\]\[]/.test(line[start - 1])) start--;
      const expr = line.slice(start, word.endColumn - 1).replace(/^[.\]]+/, "");
      const r = await evaluateForHover(expr);
      if (!r) return null;
      return {
        range: new monaco.Range(position.lineNumber, start + 1, position.lineNumber, word.endColumn),
        contents: [{ value: `\`${expr}\` = \`${r.result.replace(/`/g, "'")}\`${r.type ? ` *(${r.type})*` : ""}` }],
      };
    },
  });
}

/** Breakpoints need the glyph margin: shown for files a debugger can take, while debugging is allowed. */
function updateGlyphMargin(ed: monaco.editor.IStandaloneCodeEditor) {
  const model = ed.getModel();
  const show = !!model && model.uri.scheme === "tmcode" && debugAllowed() && !!debugKindForPath(pathOfUri(model.uri));
  if (ed.getOption(monaco.editor.EditorOption.glyphMargin) !== show) ed.updateOptions({ glyphMargin: show });
}

/** Per editor: gutter clicks, the hover hint dot and the gutter context menu. */
export function attachDebugEditor(ed: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  wireDebugDecorations();
  updateGlyphMargin(ed);
  const offPolicy = useWorkbench.subscribe((s, prev) => s.policy !== prev.policy && updateGlyphMargin(ed));
  const offExam = useExam.subscribe((s, prev) => s.phase !== prev.phase && updateGlyphMargin(ed));
  let hint: string[] = [];
  const setHint = (line: number | null) => {
    const path = ed.getModel() ? pathOfUri(ed.getModel()!.uri) : null;
    const show = line !== null && path !== null && debugAllowed() && !breakpointsFor(path).some((b) => b.line === line);
    hint = ed.deltaDecorations(hint, show ? [{ range: new monaco.Range(line!, 1, line!, 1), options: { glyphMarginClassName: "codicon codicon-debug-hint tm-bp-hint" } }] : []);
  };
  const isGutter = (t: monaco.editor.IMouseTarget) => t.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || t.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS;
  const pathOf = () => (ed.getModel() ? pathOfUri(ed.getModel()!.uri) : null);

  const disposables = [
    ed.onDidChangeModel(() => updateGlyphMargin(ed)),
    { dispose: offPolicy },
    { dispose: offExam },
    ed.onMouseDown((e) => {
      if (!e.event.leftButton || !isGutter(e.target) || !e.target.position || !debugAllowed()) return;
      const path = pathOf();
      if (!path) return;
      e.event.preventDefault();
      toggleBreakpoint(path, e.target.position.lineNumber);
      setHint(null);
    }),
    ed.onMouseMove((e) => setHint(isGutter(e.target) && e.target.position ? e.target.position.lineNumber : null)),
    ed.onMouseLeave(() => setHint(null)),
    ed.onContextMenu((e) => {
      if (!isGutter(e.target) && e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
      const path = pathOf();
      const line = e.target.position?.lineNumber;
      if (!path || !line || !debugAllowed()) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      openContextMenu(e.event.posx, e.event.posy, gutterMenu(path, line));
    }),
  ];
  return { dispose: () => disposables.forEach((d) => d.dispose()) };
}

export async function editBreakpointCondition(path: string, line: number, kind: "condition" | "logMessage" | "hitCondition") {
  const existing = breakpointsFor(path).find((b) => b.line === line);
  const prompt =
    kind === "condition"
      ? "Expression: break when the expression evaluates to true."
      : kind === "logMessage"
        ? "Log Message: message to log when the breakpoint is hit. Expressions within {} are interpolated."
        : "Hit Count: break when the hit count condition is met (e.g. 3 or >= 5).";
  const value = await showInputBox({ title: `Line ${line}`, prompt, value: existing?.[kind] ?? "", placeholder: kind === "condition" ? "e.g. total > 100" : kind === "logMessage" ? "e.g. total is {total}" : "e.g. 3" });
  if (value === undefined) return;
  if (existing) updateBreakpoint(existing.id, { [kind]: value.trim() || undefined, enabled: true });
  else addBreakpoint(path, line, { [kind]: value.trim() || undefined });
}

export function gutterMenu(path: string, line: number) {
  const os = getPlatform().os;
  const bp = breakpointsFor(path).find((b) => b.line === line);
  if (bp) {
    return [
      { kind: "item" as const, label: "Remove Breakpoint", run: () => removeBreakpoint(bp.id) },
      { kind: "item" as const, label: "Edit Breakpoint...", run: () => void editBreakpointCondition(path, line, bp.logMessage ? "logMessage" : bp.hitCondition && !bp.condition ? "hitCondition" : "condition") },
      { kind: "item" as const, label: bp.enabled ? "Disable Breakpoint" : "Enable Breakpoint", run: () => updateBreakpoint(bp.id, { enabled: !bp.enabled }) },
    ];
  }
  return [
    { kind: "item" as const, label: "Add Breakpoint", keybinding: formatKeybinding("f9", os), run: () => addBreakpoint(path, line) },
    { kind: "item" as const, label: "Add Conditional Breakpoint...", run: () => void editBreakpointCondition(path, line, "condition") },
    { kind: "item" as const, label: "Add Logpoint...", run: () => void editBreakpointCondition(path, line, "logMessage") },
  ];
}
