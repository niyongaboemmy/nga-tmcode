import type { ContentChangeDTO, DocumentDTO, EditorDTO, RangeDTO, SelectionDTO } from "@tmcode/exthost";
import { onActivity } from "../activity/log";
import { tabsSnapshot } from "./tabsSync";
import { virtualIO } from "../util/virtual";
import { monaco, setupMonaco } from "../monaco/setup";
import { onDocumentSaved, pathOfUri } from "../monaco/documents";
import { diffEditorFor, codeEditorFor, onCodeEditor } from "../monaco/editors";
import { activeEditor, useWorkbench } from "../state/store";

/**
 * Keeps every extension host's copy of the open documents and editors in sync
 * with Monaco: models open/close, incremental content changes (Monaco's own
 * change events, 0-based), language changes, saves, dirty state, and the
 * visible editors with their selections.
 */

type Broadcast = (method: string, params: unknown[]) => void;

let broadcast: Broadcast = () => {};
let wired = false;

// Workspace files, and extensions' documents (content / file system providers).
const isDoc = (m: monaco.editor.ITextModel) => m.uri.scheme === "tmcode" || virtualIO.schemes.has(m.uri.scheme);

export function toRange(r: monaco.IRange): RangeDTO {
  return [r.startLineNumber - 1, r.startColumn - 1, r.endLineNumber - 1, r.endColumn - 1];
}

export function fromRange(r: RangeDTO): monaco.IRange {
  return { startLineNumber: r[0] + 1, startColumn: r[1] + 1, endLineNumber: r[2] + 1, endColumn: r[3] + 1 };
}

function selectionDto(s: monaco.Selection): SelectionDTO {
  return { anchor: [s.selectionStartLineNumber - 1, s.selectionStartColumn - 1], active: [s.positionLineNumber - 1, s.positionColumn - 1] };
}

function documentDto(model: monaco.editor.ITextModel): DocumentDTO {
  const path = pathOfUri(model.uri);
  return { path, languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue(), eol: model.getEOL() === "\r\n" ? "\r\n" : "\n", isDirty: !!useWorkbench.getState().dirty[path] };
}

export function documentSnapshot(): DocumentDTO[] {
  setupMonaco();
  return monaco.editor.getModels().filter((m) => isDoc(m) && !m.isDisposed()).map(documentDto);
}

/** The code editor of each group whose active tab is a file. */
function visible(): { id: string; ed: monaco.editor.IStandaloneCodeEditor; viewColumn: number }[] {
  const s = useWorkbench.getState();
  const out: { id: string; ed: monaco.editor.IStandaloneCodeEditor; viewColumn: number }[] = [];
  s.groups.forEach((g, i) => {
    const active = g.editors.find((e) => e.id === g.activeId);
    if (active?.kind !== "file" && active?.kind !== "historyDiff") return;
    // A diff tab: its right side is the visible text editor (Claude Code's proposed edits, Compare).
    const ed = active.kind === "historyDiff" ? diffEditorFor(g.id) : codeEditorFor(g.id);
    const model = ed?.getModel();
    if (ed && model && isDoc(model) && pathOfUri(model.uri) === active.path) out.push({ id: `g${g.id}`, ed, viewColumn: i + 1 });
  });
  return out;
}

export function editorSnapshot(): { editors: EditorDTO[]; active: string | null } {
  const editors: EditorDTO[] = visible().map(({ id, ed, viewColumn }) => {
    const model = ed.getModel()!;
    const opts = model.getOptions();
    return {
      id,
      path: pathOfUri(model.uri),
      selections: (ed.getSelections() ?? []).map(selectionDto),
      visibleRanges: ed.getVisibleRanges().map(toRange),
      options: { tabSize: opts.tabSize, insertSpaces: opts.insertSpaces },
      viewColumn,
    };
  });
  const s = useWorkbench.getState();
  const activeKind = activeEditor(s)?.kind;
  const activeId = activeKind === "file" || activeKind === "historyDiff" ? `g${s.activeGroup}` : null;
  return { editors, active: editors.some((e) => e.id === activeId) ? activeId : null };
}

/** The editor showing `path` (the active group first). */
export function editorFor(path: string): monaco.editor.IStandaloneCodeEditor | null {
  const list = visible();
  const s = useWorkbench.getState();
  const hit = list.find((v) => v.id === `g${s.activeGroup}` && pathOfUri(v.ed.getModel()!.uri) === path) ?? list.find((v) => pathOfUri(v.ed.getModel()!.uri) === path);
  return hit?.ed ?? null;
}

let tabsTimer: ReturnType<typeof setTimeout> | null = null;
/** Sends the tabs now: before answering a request that changed them (tabGroups.close, vscode.diff). */
export function flushTabs() {
  if (tabsTimer) clearTimeout(tabsTimer);
  tabsTimer = null;
  broadcast("$tabsChanged", [tabsSnapshot()]);
}
/** Tabs opened, closed, moved, activated or dirtied: one snapshot per tick (window.tabGroups). */
function tabsChanged() {
  if (tabsTimer) return;
  tabsTimer = setTimeout(() => {
    tabsTimer = null;
    broadcast("$tabsChanged", [tabsSnapshot()]);
  }, 0);
}

let editorsTimer: ReturnType<typeof setTimeout> | null = null;
function editorsChanged() {
  if (editorsTimer) return;
  editorsTimer = setTimeout(flushEditors, 0);
}

/** Sends the editors now (before answering a request that changed them). */
export function flushEditors() {
  if (editorsTimer) clearTimeout(editorsTimer);
  editorsTimer = null;
  const snap = editorSnapshot();
  broadcast("$editorsChanged", [snap.editors, snap.active]);
}

function trackModel(model: monaco.editor.ITextModel) {
  if (!isDoc(model)) return;
  const path = () => pathOfUri(model.uri);
  broadcast("$documentOpened", [documentDto(model)]);
  model.onDidChangeContent((e) => {
    const changes: ContentChangeDTO[] = e.changes.map((c) => ({ range: toRange(c.range), rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, text: c.text }));
    broadcast("$documentChanged", [path(), model.getVersionId(), changes, true]);
  });
  model.onDidChangeLanguage(() => broadcast("$documentLanguageChanged", [path(), model.getLanguageId()]));
}

/** Installs the Monaco listeners once; `send` reaches every running host. */
export function wireDocumentSync(send: Broadcast) {
  broadcast = send;
  if (wired) return;
  wired = true;
  setupMonaco();
  for (const m of monaco.editor.getModels()) {
    // Already known to the hosts through $init; only listen for changes.
    if (!isDoc(m)) continue;
    const path = () => pathOfUri(m.uri);
    m.onDidChangeContent((e) => broadcast("$documentChanged", [path(), m.getVersionId(), e.changes.map((c) => ({ range: toRange(c.range), rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, text: c.text })), true]));
    m.onDidChangeLanguage(() => broadcast("$documentLanguageChanged", [path(), m.getLanguageId()]));
  }
  monaco.editor.onDidCreateModel((m) => {
    trackModel(m);
    editorsChanged();
  });
  monaco.editor.onWillDisposeModel((m) => {
    if (isDoc(m)) broadcast("$documentClosed", [pathOfUri(m.uri)]);
    editorsChanged();
  });
  onDocumentSaved((path) => broadcast("$documentSaved", [path]));
  useWorkbench.subscribe((s, prev) => {
    if (s.dirty !== prev.dirty) {
      for (const p of new Set([...Object.keys(s.dirty), ...Object.keys(prev.dirty)])) {
        if (!!s.dirty[p] !== !!prev.dirty[p]) broadcast("$documentDirty", [p, !!s.dirty[p]]);
      }
    }
    if (s.activeGroup !== prev.activeGroup || s.groups !== prev.groups) editorsChanged();
    if (s.activeGroup !== prev.activeGroup || s.groups !== prev.groups || s.dirty !== prev.dirty) tabsChanged();
  });
  const seen = new WeakSet<object>();
  onCodeEditor((ed) => {
    if (seen.has(ed)) return;
    seen.add(ed);
    const idOf = () => {
      for (const g of useWorkbench.getState().groups) if (codeEditorFor(g.id) === ed || diffEditorFor(g.id) === ed) return `g${g.id}`;
      return null;
    };
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    ed.onDidChangeModel(() => editorsChanged());
    ed.onDidFocusEditorText(() => editorsChanged());
    ed.onDidChangeCursorSelection((e) => {
      const id = idOf();
      if (!id) return;
      const kind = e.source === "keyboard" ? 1 : e.source === "mouse" ? 2 : 3;
      broadcast("$editorSelection", [id, [e.selection, ...e.secondarySelections].map(selectionDto), kind]);
    });
    ed.onDidScrollChange(() => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        const id = idOf();
        if (id) broadcast("$editorVisibleRanges", [id, ed.getVisibleRanges().map(toRange)]);
      }, 150);
    });
    ed.onDidDispose(() => editorsChanged());
    editorsChanged();
  });
  // File operations, as workspace.onDid{Create,Delete,Rename}Files (an extension's own are reported to it too).
  onActivity((e) => {
    if (e.kind !== "file" || !e.path || e.action === "save" || e.action === "outside-change") return;
    if (e.action === "create" || e.action === "create-folder" || e.action === "import") broadcast("$filesEvent", ["create", [e.path]]);
    else if (e.action === "delete") broadcast("$filesEvent", ["delete", [e.path]]);
    else if ((e.action === "rename" || e.action === "move") && e.to) broadcast("$filesEvent", ["rename", [[e.path, e.to]]]);
    else if (e.action === "copy" && e.to) broadcast("$filesEvent", ["create", [e.to]]);
  });
  window.addEventListener("focus", () => broadcast("$windowFocus", [true]));
  window.addEventListener("blur", () => broadcast("$windowFocus", [false]));
}
