import { monaco, setupMonaco } from "./setup";
import {
  getPlatform,
  log,
  notify,
  onEditorsClosed,
  onEntryDeleted,
  onEntryRenamed,
  onWorkspaceChanged,
  beforeDeleteHooks,
  saveHandlers,
  setDirty,
  setProblems,
  useWorkbench,
  type Problem,
} from "../state/store";
import { basename, extname, isWithin, rebase } from "../util/paths";
import { setIconLanguageResolver } from "../themes/iconThemes";
import { recordSave, snapshotBeforeDelete } from "../history/localHistory";
import { isUntitled, untitledName, UNTITLED_SCHEME } from "../util/untitled";

/**
 * One Monaco text model per open file. The workbench store only knows paths
 * and dirty flags; contents live here.
 */
interface Doc {
  model: monaco.editor.ITextModel;
  savedVersion: number;
  /** The text TMCode last read from or wrote to disk: a watcher event for exactly this is our own echo. */
  diskText: string;
  /**
   * Loaded for a language feature, not shown by an editor: a file Go to
   * Definition or Find References looked into, or one a rename edits. Edits
   * to it are saved at once (VS Code's `files.refactoring.autoSave`), and its
   * diagnostics stay out of Problems until an editor opens it.
   */
  background?: boolean;
}

const docs = new Map<string, Doc>();
const pending = new Map<string, Promise<monaco.editor.ITextModel>>();
/** Bumped when another folder opens: a read still in flight belongs to the old folder. */
let generation = 0;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

const SCHEME = "tmcode";
export function uriFor(path: string) {
  if (isUntitled(path)) return monaco.Uri.from({ scheme: UNTITLED_SCHEME, path: untitledName(path) });
  return monaco.Uri.from({ scheme: SCHEME, path: `/${path}` });
}
export function pathOfUri(uri: monaco.Uri) {
  if (uri.scheme === UNTITLED_SCHEME) return `${UNTITLED_SCHEME}:${uri.path.replace(/^\//, "")}`;
  return uri.path.replace(/^\//, "");
}

/** Untitled buffers have no file: Save asks for a path (commands/untitled.ts sets this). */
export const untitledSave: { run: (path: string) => Promise<void> } = { run: async () => {} };

const EXTRA_LANGS: Record<string, string> = { jsx: "javascript", tsx: "typescript", mjs: "javascript", cjs: "javascript", h: "c", hpp: "cpp" };

export function languageForPath(path: string): string {
  const ext = extname(path);
  if (EXTRA_LANGS[ext]) return EXTRA_LANGS[ext];
  // File names first (Makefile), then the longest matching extension (".blade.php" before ".php");
  // on a tie the later registration (an extension's language) wins, as in VS Code.
  const name = basename(path).toLowerCase();
  let best: { id: string; len: number } | null = null;
  for (const l of monaco.languages.getLanguages()) {
    if (l.filenames?.some((f) => f.toLowerCase() === name)) return l.id;
    for (const e of l.extensions ?? []) {
      const el = e.toLowerCase();
      if (name.endsWith(el) && (!best || el.length >= best.len)) best = { id: l.id, len: el.length };
    }
  }
  return best?.id ?? "plaintext";
}

export function languageLabel(id: string | null): string {
  if (!id) return "";
  const lang = monaco.languages.getLanguages().find((l) => l.id === id);
  return lang?.aliases?.[0] ?? id;
}

/** What TMCode last read from or wrote to disk for an open file (null when not open). */
export function lastDiskText(path: string): string | null {
  return docs.get(path)?.diskText ?? null;
}

export function getDocument(path: string) {
  return docs.get(path)?.model ?? null;
}

/** Loads (once) and returns the model for `path`. `background`: for a language feature, not an editor. */
export function ensureDocument(path: string, opts: { background?: boolean } = {}): Promise<monaco.editor.ITextModel> {
  setupMonaco();
  const existing = docs.get(path);
  if (existing) {
    // An editor opens a file a language feature loaded earlier: it is a normal document from now on.
    if (!opts.background && existing.background) {
      existing.background = false;
      recomputeProblemsSoon();
    }
    return Promise.resolve(existing.model);
  }
  const inflight = pending.get(path);
  if (inflight) return inflight;
  const gen = generation;
  const p = (isUntitled(path) ? Promise.resolve("") : getPlatform().fs.readFile(path))
    .then((content): monaco.editor.ITextModel | Promise<monaco.editor.ITextModel> => {
      // Read from the folder that was open before: read it again from the new one.
      if (gen !== generation) return ensureDocument(path, opts);
      // Monaco created it meanwhile (a definition in this file): adopted already.
      const adopted = docs.get(path);
      if (adopted) return ensureDocument(path, opts);
      const model = createTrackedModel(path, content);
      docs.set(path, { model, savedVersion: model.getAlternativeVersionId(), diskText: content, background: opts.background });
      return model;
    })
    .finally(() => {
      if (pending.get(path) === p) pending.delete(path);
    });
  pending.set(path, p);
  return p;
}

const changeListeners = new Set<(path: string) => void>();
/** Fires on every edit and save of an open file (live preview, test file reload). */
export function onDocumentChanged(l: (path: string) => void) {
  changeListeners.add(l);
  return () => {
    changeListeners.delete(l);
  };
}

const saveListeners = new Set<(path: string) => void>();
/** Fires after a file is written by TMCode (live preview "on save"). */
export function onDocumentSaved(l: (path: string) => void) {
  saveListeners.add(l);
  return () => {
    saveListeners.delete(l);
  };
}

// ── extension host (feat/exthost) ──
/** Problems for files that have no model (extension diagnostics of unopened files). */
export const extraProblems: { get: () => Problem[] } = { get: () => [] };
// ── end extension host ──

/** Set while TMCode creates a model itself, so the adoption below leaves it alone. */
let creatingModel = false;

function createTrackedModel(path: string, content: string) {
  creatingModel = true;
  let model: monaco.editor.ITextModel;
  try {
    model = monaco.editor.createModel(content, languageForPath(path), uriFor(path));
  } finally {
    creatingModel = false;
  }
  trackModel(model);
  return model;
}

function trackModel(model: monaco.editor.ITextModel) {
  model.onDidChangeContent(() => {
    changeListeners.forEach((l) => l(pathOfUri(model.uri)));
    const d = docs.get(pathOfUri(model.uri));
    if (!d || d.model !== model) return;
    const isDirty = model.getAlternativeVersionId() !== d.savedVersion;
    if (d.background) {
      if (isDirty) saveBackgroundSoon(pathOfUri(model.uri));
      return;
    }
    setDirty(pathOfUri(model.uri), isDirty);
    if (isDirty) scheduleAutoSave();
  });
}

const backgroundSaves = new Set<string>();
/** A refactoring changed a file no editor shows: write it (once per burst of edits). */
function saveBackgroundSoon(path: string) {
  if (backgroundSaves.has(path)) return;
  backgroundSaves.add(path);
  setTimeout(() => {
    backgroundSaves.delete(path);
    const d = docs.get(path);
    if (!d?.background || d.model.isDisposed()) return;
    if (d.model.getValue() === d.diskText) {
      d.savedVersion = d.model.getAlternativeVersionId();
      return;
    }
    void saveDocument(path).catch(() => {});
  }, 0);
}

/**
 * Monaco creates models of its own for workspace files that are not open
 * (TypeScript's Go to Definition, Find References and Rename read them from
 * the project copies in monaco/workspaceSources.ts). Adopt them as background
 * documents: an editor opening the file reuses the model, and a rename's
 * edits to them are saved.
 */
function adoptForeignModel(model: monaco.editor.ITextModel) {
  if (creatingModel || model.uri.scheme !== SCHEME) return;
  const path = pathOfUri(model.uri);
  if (docs.has(path)) return;
  const lang = languageForPath(path);
  if (model.getLanguageId() !== lang) monaco.editor.setModelLanguage(model, lang);
  docs.set(path, { model, savedVersion: model.getAlternativeVersionId(), diskText: model.getValue(), background: true });
  trackModel(model);
  model.onWillDispose(() => {
    if (docs.get(path)?.model === model) docs.delete(path);
  });
}

let problemsTimer: ReturnType<typeof setTimeout> | undefined;
function recomputeProblemsSoon() {
  clearTimeout(problemsTimer);
  problemsTimer = setTimeout(() => recomputeProblems(), 0);
}

/** Run before a file is written (extensions' onWillSaveTextDocument edits); each may change the model. */
/** "explicit": ⌘S, Save All, a command; "auto": auto save (VS Code skips some save actions then). */
export type SaveReason = "explicit" | "auto";
export const willSaveParticipants: ((path: string, model: monaco.editor.ITextModel, reason: SaveReason) => Promise<void>)[] = [];

export async function saveDocument(path: string, reason: SaveReason = "explicit") {
  if (isUntitled(path)) return untitledSave.run(path);
  const doc = docs.get(path);
  if (!doc) return;
  for (const participant of willSaveParticipants) {
    try {
      await participant(path, doc.model, reason);
    } catch {
      /* a participant never blocks saving */
    }
  }
  const value = doc.model.getValue();
  const version = doc.model.getAlternativeVersionId();
  try {
    // Set before the write: the watcher may report it before writeFile resolves.
    const previous = doc.diskText;
    doc.diskText = value;
    await getPlatform().fs.writeFile(path, value).catch((e) => {
      doc.diskText = previous;
      throw e;
    });
    void recordSave(path, value);
    doc.savedVersion = version;
    changeListeners.forEach((l) => l(path));
    setDirty(path, doc.model.getAlternativeVersionId() !== doc.savedVersion);
    saveListeners.forEach((l) => l(path));
  } catch (e) {
    notify("error", `Failed to save '${path}': ${String((e as Error)?.message ?? e)}`);
    throw e;
  }
}

export async function saveAll(reason: SaveReason = "explicit") {
  // Untitled buffers wait for an explicit Save (auto save would keep asking for a path).
  const dirty = Object.keys(useWorkbench.getState().dirty).filter((p) => !isUntitled(p));
  for (const p of dirty) await saveDocument(p, reason).catch(() => {});
}

/** The model's current text is what's on disk (after an outside change was loaded). */
export function markSaved(path: string) {
  const doc = docs.get(path);
  if (!doc) return;
  doc.savedVersion = doc.model.getAlternativeVersionId();
  doc.diskText = doc.model.getValue();
  setDirty(path, false);
}

export function revertDocument(path: string): Promise<void> {
  const doc = docs.get(path);
  if (!doc) return Promise.resolve();
  return getPlatform()
    .fs.readFile(path)
    .then((content) => {
      doc.model.setValue(content);
      doc.diskText = content;
      doc.savedVersion = doc.model.getAlternativeVersionId();
      setDirty(path, false);
    })
    .catch(() => setDirty(path, false));
}

/** Exams always auto-save soon after typing, whatever the setting (review E9): unsaved buffers never reach Task Mentor. */
const EXAM_AUTOSAVE_MS = 1000;

function scheduleAutoSave() {
  const { settings, policy } = useWorkbench.getState();
  const exam = policy.mode !== "practice";
  if (!exam && settings["files.autoSave"] !== "afterDelay") return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  const delay = exam ? Math.min(settings["files.autoSaveDelay"] || EXAM_AUTOSAVE_MS, EXAM_AUTOSAVE_MS) : settings["files.autoSaveDelay"];
  autoSaveTimer = setTimeout(() => void saveAll("auto"), delay);
}

/** Auto save "onFocusChange": called when the editor loses focus or the window blurs. */
export function saveOnFocusChange() {
  if (useWorkbench.getState().settings["files.autoSave"] === "onFocusChange") void saveAll("auto");
}

function disposeDoc(path: string) {
  const doc = docs.get(path);
  if (!doc) return;
  doc.model.dispose();
  docs.delete(path);
}

let wired = false;
/** Connects the document store to workbench events. Idempotent. */
export function wireDocuments() {
  if (wired) return;
  wired = true;
  setupMonaco();
  // Icons are cached per file name until the set of languages changes (an extension adds one).
  let languageCount = 0;
  let countedAt = -Infinity;
  setIconLanguageResolver(
    (p) => languageForPath(p),
    () => {
      const now = performance.now();
      if (now - countedAt > 500) {
        countedAt = now;
        languageCount = monaco.languages.getLanguages().length;
      }
      return String(languageCount);
    },
  );
  saveHandlers.save = saveDocument;
  saveHandlers.revert = (path) => {
    // Closing without saving: drop the model so the next open re-reads disk.
    setDirty(path, false);
    disposeDoc(path);
  };
  saveHandlers.discard = revertDocument;

  // Models are keyed by workspace-relative path: a new folder starts with none.
  onWorkspaceChanged(() => {
    generation++;
    pending.clear();
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    for (const p of [...docs.keys()]) disposeDoc(p);
  });

  beforeDeleteHooks.push(snapshotBeforeDelete);

  onEditorsClosed((paths) => {
    for (const p of paths) disposeDoc(p);
  });

  onEntryRenamed((from, to) => {
    for (const [path, doc] of [...docs]) {
      if (!isWithin(path, from)) continue;
      const next = rebase(path, from, to);
      const dirty = doc.model.getAlternativeVersionId() !== doc.savedVersion;
      const model = createTrackedModel(next, doc.model.getValue());
      doc.model.dispose();
      docs.delete(path);
      // A model can't change its URI, so a renamed file gets a fresh one that keeps the dirty state.
      docs.set(next, { model, savedVersion: dirty ? -1 : model.getAlternativeVersionId(), diskText: doc.diskText, background: doc.background });
    }
  });

  onEntryDeleted((path) => {
    for (const p of [...docs.keys()]) if (isWithin(p, path)) disposeDoc(p);
  });

  monaco.editor.onDidCreateModel(adoptForeignModel);
  monaco.editor.onDidChangeMarkers(() => recomputeProblems());

  window.addEventListener("blur", saveOnFocusChange);
  // Built-in language servers (Pyright) start when a file of their language opens.
  void import("../lsp/servers").then((m) => m.wireLanguageServers()).catch(() => {});
  log("Workbench", "Editor services ready");
}

/** Problems = Monaco markers of open files (+ extension diagnostics of files that are not open). */
export function recomputeProblems() {
  const problems: Problem[] = monaco.editor
    .getModelMarkers({})
    // Hints (unused variables etc.) show in the editor but not in Problems, as in VS Code.
    // Files only a language feature loaded (background) report once an editor opens them, as in VS Code.
    .filter((m) => m.resource.scheme === SCHEME && m.severity !== monaco.MarkerSeverity.Hint && !docs.get(pathOfUri(m.resource))?.background)
    .map((m) => ({
      path: pathOfUri(m.resource),
      message: m.message,
      severity: m.severity === monaco.MarkerSeverity.Error ? "error" : m.severity === monaco.MarkerSeverity.Warning ? "warning" : "info",
      line: m.startLineNumber,
      column: m.startColumn,
      source: m.source,
    }));
  const open = new Set(problems.map((p) => p.path));
  const shown = (p: string) => !!docs.get(p) && !docs.get(p)!.background;
  setProblems([...problems, ...extraProblems.get().filter((p) => !open.has(p.path) && !shown(p.path))]);
}
