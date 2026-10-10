import { pathOfUri } from "../monaco/documents";
import { codeEditorFor, onCodeEditor } from "../monaco/editors";
import { monaco } from "../monaco/setup";
import { getPlatform, openFile, useWorkbench } from "../state/store";
import { formatKeybinding } from "../commands/registry";
import { currentDraft, draftFrom, draftKey, putDraft, useDrafts } from "./drafts";
import { useGrading, type Annotation, type Roster, type RosterRow } from "./service";

/**
 * Line comments in the review folder (G1): a "+" in the gutter, "Add Comment"
 * in the editor's context menu or Grading: Add Line Comment start one; each
 * comment shows under its line as a Monaco view zone with Edit / Delete. They
 * live in the grade draft (`annotations`) and are saved with the grade.
 */

interface Target {
  gkey: string;
  studentId: number;
  roster: Roster;
  row: RosterRow;
  canEdit: boolean;
}

/** The student whose submission is open in the review folder, with their roster row. */
export function reviewTarget(): Target | null {
  const { review, rosters } = useGrading.getState();
  if (!review) return null;
  const roster = rosters[review.key];
  const row = roster?.rows.find((r) => r.student?.id === review.student_id);
  if (!roster || !row) return null;
  const canEdit = roster.activity.can_grade && (row.state === "submitted" || row.state === "graded");
  return { gkey: review.key, studentId: review.student_id, roster, row, canEdit };
}

function annotations(t: Target): Annotation[] {
  return currentDraft(t.roster, t.gkey, t.studentId)?.annotations ?? [];
}

function writeAnnotations(t: Target, change: (list: Annotation[]) => Annotation[]) {
  const pristine = draftFrom(t.roster, t.row);
  const cur = currentDraft(t.roster, t.gkey, t.studentId) ?? pristine;
  putDraft(draftKey(t.gkey, t.studentId), { ...cur, annotations: change(cur.annotations) }, pristine, t.row.grade?.version ?? null);
}

// ── The comment being written (one at a time) ─────────────────────────────

let editing: { path: string; line: number; index: number | null; text: string } | null = null;
let focusEditor = false;
const renderers = new Set<() => void>();
const renderAll = () => renderers.forEach((r) => r());

/** Opens the comment box under `line` (index: edit that comment). */
export function startComment(path: string, line: number, index: number | null = null) {
  const t = reviewTarget();
  if (!t?.canEdit) return;
  editing = { path, line, index, text: index === null ? "" : (annotations(t)[index]?.text ?? "") };
  focusEditor = true;
  renderAll();
}

function finishComment(save: boolean) {
  const t = reviewTarget();
  const e = editing;
  editing = null;
  if (save && t && e) {
    const text = e.text.trim();
    writeAnnotations(t, (list) => {
      if (e.index === null) return text ? [...list, { path: e.path, line: e.line, text }].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line) : list;
      return text ? list.map((a, i) => (i === e.index ? { ...a, text } : a)) : list.filter((_, i) => i !== e.index);
    });
  }
  renderAll();
}

function deleteComment(index: number) {
  const t = reviewTarget();
  if (!t) return;
  if (editing?.index === index) editing = null;
  writeAnnotations(t, (list) => list.filter((_, i) => i !== index));
}

/** Shows a comment's line in the code group (from the grade panel's list). */
export function revealComment(a: Annotation) {
  const groups = useWorkbench.getState().groups;
  const group = groups.find((g) => !g.editors.some((e) => e.kind === "grading"))?.id ?? groups[0].id;
  openFile(a.path, { pinned: true, group });
  const go = (n = 0) => {
    const ed = codeEditorFor(group);
    const model = ed?.getModel();
    if (ed && model && pathOfUri(model.uri) === a.path) {
      ed.setPosition({ lineNumber: a.line, column: 1 });
      ed.revealLineInCenter(a.line);
    } else if (n < 40) setTimeout(() => go(n + 1), 25);
  };
  go();
}

/** Grading: Add Line Comment, at the cursor of the active editor. */
export function addCommentAtCursor() {
  const ed = codeEditorFor(useWorkbench.getState().activeGroup);
  const model = ed?.getModel();
  if (!ed || !model || model.uri.scheme !== "tmcode") return;
  startComment(pathOfUri(model.uri), ed.getPosition()?.lineNumber ?? 1);
}

export function canAddCommentHere() {
  if (!reviewTarget()?.canEdit) return false;
  const model = codeEditorFor(useWorkbench.getState().activeGroup)?.getModel();
  return !!model && model.uri.scheme === "tmcode";
}

/** Focus is in a comment box: its own keys (⌘Enter, Escape) win over the grading shortcuts. */
export const typingComment = () => !!(document.activeElement as HTMLElement | null)?.closest?.(".tm-review-comment");

// ── The widgets ───────────────────────────────────────────────────────────

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function iconButton(icon: string, label: string, onClick: () => void) {
  const b = el("button", "tm-action");
  const glyph = el("span", `codicon codicon-${icon}`);
  glyph.setAttribute("aria-hidden", "true");
  b.append(glyph);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

let seq = 0;
function commentBox(path: string, a: Annotation | null, index: number | null, canEdit: boolean): HTMLElement {
  const box = el("div", "tm-review-comment");
  box.dataset.testid = "review-comment";
  const isEditing = !!editing && editing.path === path && editing.index === index;
  const line = a?.line ?? editing?.line ?? 1;
  if (isEditing && canEdit) {
    box.classList.add("is-editing");
    const id = `tm-review-comment-${++seq}`;
    const label = el("label", "tm-review-comment-label", `${index === null ? "New comment" : "Edit comment"} on line ${line} (the student reads it)`);
    label.htmlFor = id;
    const input = el("textarea", "tm-input");
    input.id = id;
    input.rows = 3;
    input.value = editing!.text;
    input.placeholder = "What to fix or keep on this line";
    input.dataset.testid = "review-comment-input";
    input.addEventListener("input", () => editing && (editing.text = input.value));
    input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        finishComment(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finishComment(false);
      }
    });
    const buttons = el("div", "tm-review-comment-buttons");
    const save = el("button", "tm-button tm-button--small", index === null ? "Comment" : "Save");
    save.type = "button";
    save.title = `Keep this comment (${formatKeybinding("mod+enter", getPlatform().os)}). It's saved to Task Mentor with the grade.`;
    save.dataset.testid = "review-comment-save";
    save.addEventListener("click", () => finishComment(true));
    const cancel = el("button", "tm-button tm-button--small tm-button--secondary", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => finishComment(false));
    buttons.append(save, cancel);
    box.append(label, input, buttons);
    if (focusEditor) {
      focusEditor = false;
      setTimeout(() => input.focus(), 0);
    }
  } else if (a) {
    box.setAttribute("role", "note");
    box.setAttribute("aria-label", `Comment on line ${a.line}`);
    const head = el("div", "tm-review-comment-head");
    const icon = el("span", "codicon codicon-comment");
    icon.setAttribute("aria-hidden", "true");
    head.append(icon, el("b", "", "Comment"), el("span", "tm-muted", `line ${a.line}`));
    if (canEdit && index !== null) {
      const actions = el("span", "tm-review-comment-actions");
      actions.append(
        iconButton("edit", "Edit comment", () => startComment(path, a.line, index)),
        iconButton("trash", "Delete comment", () => deleteComment(index)),
      );
      head.append(actions);
    }
    box.append(head, el("div", "tm-review-comment-body", a.text));
  }
  // Monaco must not take these clicks and keys (focus, selection, its shortcuts).
  for (const type of ["pointerdown", "mousedown", "keydown", "contextmenu", "dblclick"]) box.addEventListener(type, (e) => e.stopPropagation());
  return box;
}

function attach(ed: monaco.editor.IStandaloneCodeEditor) {
  let zones: { id: string; zone: monaco.editor.IViewZone; node: HTMLElement; widget: monaco.editor.IOverlayWidget; overlay: HTMLElement }[] = [];
  /** Over the text area: from the content's left edge to the scrollbar. */
  const place = (overlay: HTMLElement) => {
    const l = ed.getLayoutInfo();
    overlay.style.left = `${l.contentLeft}px`;
    overlay.style.width = `${Math.max(120, l.width - l.contentLeft - l.verticalScrollbarWidth - l.minimap.minimapWidth)}px`;
  };
  const marks = ed.createDecorationsCollection();
  const hover = ed.createDecorationsCollection();
  const reviewing = ed.createContextKey<boolean>("tmcodeReviewComments", false);
  let hoverLine: number | null = null;
  let signature = "";
  const pathNow = () => {
    const m = ed.getModel();
    return m && m.uri.scheme === "tmcode" ? pathOfUri(m.uri) : null;
  };

  const render = () => {
    const path = pathNow();
    const t = path ? reviewTarget() : null;
    const all = t ? annotations(t) : [];
    const mine = all.map((a, index) => ({ a, index })).filter((x) => x.a.path === path);
    const sig = JSON.stringify([ed.getModel()?.uri.toString(), !!t, t?.canEdit, mine, editing && editing.path === path ? editing.index ?? `new:${editing.line}` : null]);
    reviewing.set(!!t?.canEdit);
    if (sig === signature && !focusEditor) return;
    signature = sig;
    ed.changeViewZones((acc) => {
      for (const z of zones) {
        acc.removeZone(z.id);
        ed.removeOverlayWidget(z.widget);
      }
      zones = [];
      if (!t || !path) return;
      // Like VS Code's zone widgets: an empty view zone makes room under the line, an overlay widget
      // on top of it holds the comment (view zones sit under the text layer, hidden from screen readers).
      const add = (line: number, node: HTMLElement) => {
        const overlay = el("div", "tm-review-comment-zone");
        overlay.append(node);
        const widgetId = `tmcode.review.comment.${++seq}`;
        const widget: monaco.editor.IOverlayWidget = { getId: () => widgetId, getDomNode: () => overlay, getPosition: () => null };
        ed.addOverlayWidget(widget);
        place(overlay);
        const zone: monaco.editor.IViewZone = {
          afterLineNumber: line,
          heightInPx: 96,
          domNode: el("div", ""),
          onDomNodeTop: (top) => {
            overlay.style.top = `${top}px`;
          },
        };
        zones.push({ id: acc.addZone(zone), zone, node, widget, overlay });
      };
      for (const { a, index } of mine) add(a.line, commentBox(path, a, index, t.canEdit));
      if (editing && editing.path === path && editing.index === null) add(editing.line, commentBox(path, null, null, t.canEdit));
    });
    // Fit each zone to its box once it is laid out.
    requestAnimationFrame(() => {
      ed.changeViewZones((acc) => {
        for (const z of zones) {
          const h = z.node.offsetHeight + 10;
          if (h > 10 && h !== z.zone.heightInPx) {
            z.zone.heightInPx = h;
            acc.layoutZone(z.id);
          }
        }
      });
    });
    marks.set(t ? [...new Set(mine.map((x) => x.a.line))].map((line) => ({ range: new monaco.Range(line, 1, line, 1), options: { linesDecorationsClassName: "codicon codicon-comment tm-review-comment-mark", linesDecorationsTooltip: "Line comment" } })) : []);
    const width = t ? 18 : undefined;
    if (width !== undefined) ed.updateOptions({ lineDecorationsWidth: width });
    else if (ed.getOption(monaco.editor.EditorOption.lineDecorationsWidth) === 18) ed.updateOptions({ lineDecorationsWidth: 10 });
  };

  const showHover = (line: number | null) => {
    hoverLine = line;
    const t = line !== null && pathNow() ? reviewTarget() : null;
    hover.set(t?.canEdit && line !== null ? [{ range: new monaco.Range(line, 1, line, 1), options: { linesDecorationsClassName: "codicon codicon-add tm-review-comment-add", linesDecorationsTooltip: "Add a comment on this line" } }] : []);
  };

  // The "+" in the gutter: taken before Monaco sees the click (no breakpoint, no selection).
  const onDown = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest?.(".tm-review-comment-add")) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.type !== "pointerdown" && (e as MouseEvent).button !== 0) return;
    const path = pathNow();
    if (path && hoverLine !== null && e.type === "pointerdown") startComment(path, hoverLine);
  };
  // The container (getDomNode() is null until the editor has a model).
  const dom = ed.getContainerDomNode();
  dom?.addEventListener("pointerdown", onDown, true);
  dom?.addEventListener("mousedown", onDown, true);

  renderers.add(render);
  const disposables = [
    ed.onDidLayoutChange(() => zones.forEach((z) => place(z.overlay))),
    ed.onDidChangeModel(() => {
      signature = "";
      render();
    }),
    ed.onMouseMove((e) => showHover(e.target.position ? e.target.position.lineNumber : null)),
    ed.onMouseLeave(() => showHover(null)),
    ed.addAction({
      id: "tmcode.grading.addComment",
      label: "Add Comment",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      precondition: "tmcodeReviewComments",
      run: (e) => {
        const path = pathNow();
        if (path) startComment(path, e.getPosition()?.lineNumber ?? 1);
      },
    }),
  ];
  render();
  ed.onDidDispose(() => {
    renderers.delete(render);
    dom?.removeEventListener("pointerdown", onDown, true);
    dom?.removeEventListener("mousedown", onDown, true);
    disposables.forEach((d) => d.dispose());
  });
}

let wired = false;
export function wireReviewComments() {
  if (wired) return;
  wired = true;
  onCodeEditor(attach);
  useGrading.subscribe((s, prev) => {
    if (s.review !== prev.review) editing = null;
    if (s.review !== prev.review || s.rosters !== prev.rosters) renderAll();
  });
  useDrafts.subscribe((s, prev) => s.drafts !== prev.drafts && renderAll());
}
