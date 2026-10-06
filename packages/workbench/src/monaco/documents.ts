import { monaco, setupMonaco } from "./setup";
import {
  getPlatform,
  log,
  notify,
  onEditorsClosed,
  onEntryDeleted,
  onEntryRenamed,
  saveHandlers,
  setDirty,
  setProblems,
  useWorkbench,
  type Problem,
} from "../state/store";
import { basename, extname, isWithin, rebase } from "../util/paths";
import { setIconLanguageResolver } from "../themes/iconThemes";

/**
 * One Monaco text model per open file. The workbench store only knows paths
 * and dirty flags; contents live here.
 */
interface Doc {
  model: monaco.editor.ITextModel;
  savedVersion: number;
}

const docs = new Map<string, Doc>();
const pending = new Map<string, Promise<monaco.editor.ITextModel>>();
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

const SCHEME = "tmcode";
export function uriFor(path: string) {
  return monaco.Uri.from({ scheme: SCHEME, path: `/${path}` });
}
export function pathOfUri(uri: monaco.Uri) {
  return uri.path.replace(/^\//, "");
}

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

export function getDocument(path: string) {
  return docs.get(path)?.model ?? null;
}

/** Loads (once) and returns the model for `path`. */
export function ensureDocument(path: string): Promise<monaco.editor.ITextModel> {
  setupMonaco();
  const existing = docs.get(path);
  if (existing) return Promise.resolve(existing.model);
  const inflight = pending.get(path);
  if (inflight) return inflight;
  const p = getPlatform()
    .fs.readFile(path)
    .then((content) => {
      const model = createTrackedModel(path, content);
      docs.set(path, { model, savedVersion: model.getAlternativeVersionId() });
      return model;
    })
    .finally(() => pending.delete(path));
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

function createTrackedModel(path: string, content: string) {
  const model = monaco.editor.createModel(content, languageForPath(path), uriFor(path));
  model.onDidChangeContent(() => {
    changeListeners.forEach((l) => l(pathOfUri(model.uri)));
    const d = docs.get(pathOfUri(model.uri));
    if (!d) return;
    const isDirty = model.getAlternativeVersionId() !== d.savedVersion;
    setDirty(pathOfUri(model.uri), isDirty);
    if (isDirty) scheduleAutoSave();
  });
  return model;
}

export async function saveDocument(path: string) {
  const doc = docs.get(path);
  if (!doc) return;
  const value = doc.model.getValue();
  const version = doc.model.getAlternativeVersionId();
  try {
    await getPlatform().fs.writeFile(path, value);
    doc.savedVersion = version;
    changeListeners.forEach((l) => l(path));
    setDirty(path, doc.model.getAlternativeVersionId() !== doc.savedVersion);
  } catch (e) {
    notify("error", `Failed to save '${path}': ${String((e as Error)?.message ?? e)}`);
    throw e;
  }
}

export async function saveAll() {
  const dirty = Object.keys(useWorkbench.getState().dirty);
  for (const p of dirty) await saveDocument(p).catch(() => {});
}

/** The model's current text is what's on disk (after an outside change was loaded). */
export function markSaved(path: string) {
  const doc = docs.get(path);
  if (!doc) return;
  doc.savedVersion = doc.model.getAlternativeVersionId();
  setDirty(path, false);
}

export function revertDocument(path: string) {
  const doc = docs.get(path);
  if (!doc) return;
  void getPlatform()
    .fs.readFile(path)
    .then((content) => {
      doc.model.setValue(content);
      doc.savedVersion = doc.model.getAlternativeVersionId();
      setDirty(path, false);
    })
    .catch(() => setDirty(path, false));
}

function scheduleAutoSave() {
  const { settings } = useWorkbench.getState();
  if (settings["files.autoSave"] !== "afterDelay") return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => void saveAll(), settings["files.autoSaveDelay"]);
}

/** Auto save "onFocusChange": called when the editor loses focus or the window blurs. */
export function saveOnFocusChange() {
  if (useWorkbench.getState().settings["files.autoSave"] === "onFocusChange") void saveAll();
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
  setIconLanguageResolver((p) => languageForPath(p));
  saveHandlers.save = saveDocument;
  saveHandlers.revert = (path) => {
    // Closing without saving: drop the model so the next open re-reads disk.
    setDirty(path, false);
    disposeDoc(path);
  };

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
      docs.set(next, { model, savedVersion: dirty ? -1 : model.getAlternativeVersionId() });
    }
  });

  onEntryDeleted((path) => {
    for (const p of [...docs.keys()]) if (isWithin(p, path)) disposeDoc(p);
  });

  monaco.editor.onDidChangeMarkers(() => {
    const problems: Problem[] = monaco.editor
      .getModelMarkers({})
      // Hints (unused variables etc.) show in the editor but not in Problems, as in VS Code.
      .filter((m) => m.resource.scheme === SCHEME && m.severity !== monaco.MarkerSeverity.Hint)
      .map((m) => ({
        path: pathOfUri(m.resource),
        message: m.message,
        severity: m.severity === monaco.MarkerSeverity.Error ? "error" : m.severity === monaco.MarkerSeverity.Warning ? "warning" : "info",
        line: m.startLineNumber,
        column: m.startColumn,
        source: m.source,
      }));
    setProblems(problems);
  });

  window.addEventListener("blur", saveOnFocusChange);
  log("Workbench", "Editor services ready");
}
