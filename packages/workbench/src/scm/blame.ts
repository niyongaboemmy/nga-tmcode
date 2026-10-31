import { create } from "zustand";
import { registerCommand } from "../commands/registry";
import { codeEditorFor } from "../monaco/editors";
import { onDocumentSaved } from "../monaco/documents";
import { monaco } from "../monaco/setup";
import type { BlameLine } from "../platform/types";
import { activeFilePath, updateSetting, useWorkbench, workbench } from "../state/store";
import { isUntitled } from "../util/untitled";
import { isVirtualPath } from "../util/virtual";
import { gitHost } from "./gitService";

/**
 * Git blame, as VS Code shows it: the current line's author and age in the
 * status bar, and (git.blame.editorDecoration.enabled) after the line itself.
 * Nothing while the file has unsaved changes (its lines no longer match).
 */

const NOT_COMMITTED = /^0+$/;

export function relativeTime(ts: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} minute${Math.floor(s / 60) === 1 ? "" : "s"} ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hour${Math.floor(s / 3600) === 1 ? "" : "s"} ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} day${Math.floor(s / 86400) === 1 ? "" : "s"} ago`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)} month${Math.floor(s / 86400 / 30) === 1 ? "" : "s"} ago`;
  return `${Math.floor(s / 86400 / 365)} year${Math.floor(s / 86400 / 365) === 1 ? "" : "s"} ago`;
}

/** "Ada, 3 days ago" (and the commit's summary for the inline text). */
export function blameText(b: BlameLine, withSummary: boolean, now?: number): string {
  if (NOT_COMMITTED.test(b.hash)) return "You, Uncommitted changes";
  return `${b.author}, ${relativeTime(b.date, now)}${withSummary && b.summary ? ` • ${b.summary}` : ""}`;
}

export const useBlame = create<{ path: string | null; line: BlameLine | null }>(() => ({ path: null, line: null }));

const cache = new Map<string, Promise<BlameLine[]>>();

function blameOf(path: string): Promise<BlameLine[]> {
  let p = cache.get(path);
  if (!p) {
    p = gitHost()?.blame?.(path).catch(() => [] as BlameLine[]) ?? Promise.resolve([]);
    cache.set(path, p);
  }
  return p;
}

let decorations: monaco.editor.IEditorDecorationsCollection | null = null;
let seq = 0;

async function update() {
  const my = ++seq;
  const s = useWorkbench.getState();
  const path = activeFilePath(s);
  const ed = codeEditorFor(workbench.get().activeGroup);
  const line = ed?.getPosition()?.lineNumber;
  decorations?.clear();
  if (!path || !line || isUntitled(path) || isVirtualPath(path) || s.dirty[path] || !gitHost()?.blame) {
    useBlame.setState({ path: null, line: null });
    return;
  }
  const lines = await blameOf(path);
  if (my !== seq) return;
  const b = lines.find((l) => l.line === line) ?? null;
  useBlame.setState({ path, line: b });
  const model = ed?.getModel();
  if (!b || !ed || !model || !s.settings["git.blame.editorDecoration.enabled"]) return;
  const end = model.getLineMaxColumn(line);
  decorations = ed.createDecorationsCollection([
    {
      range: new monaco.Range(line, end, line, end),
      // An empty range at the line's end: shown only with showIfCollapsed.
      options: { after: { content: `    ${blameText(b, true)}`, inlineClassName: "tm-inline-blame" }, showIfCollapsed: true },
    },
  ]);
}

let wired = false;
export function wireBlame() {
  if (wired) return;
  wired = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void update(), 150);
  };
  // The cursor moves (Ln/Col in the store), another file opens, a file is saved or settings change.
  useWorkbench.subscribe((st, prev) => {
    if (st.cursor !== prev.cursor || st.groups !== prev.groups || st.activeGroup !== prev.activeGroup || st.dirty !== prev.dirty || st.settings !== prev.settings) soon();
  });
  onDocumentSaved((p) => {
    cache.delete(p);
    soon();
  });
  // A commit, checkout or pull changes the history: forget it all.
  gitHost()?.onRepoChange?.(() => {
    cache.clear();
    soon();
  });
  registerCommand({
    id: "git.blame.toggleEditorDecoration",
    title: "Toggle Git Blame Editor Decoration",
    category: "Git",
    enabled: () => !!gitHost()?.blame,
    run: () => updateSetting("git.blame.editorDecoration.enabled", !useWorkbench.getState().settings["git.blame.editorDecoration.enabled"]),
  });
  registerCommand({
    id: "git.blame.toggleStatusBarItem",
    title: "Toggle Git Blame Status Bar Item",
    category: "Git",
    enabled: () => !!gitHost()?.blame,
    run: () => updateSetting("git.blame.statusBarItem.enabled", !useWorkbench.getState().settings["git.blame.statusBarItem.enabled"]),
  });
}

/** For tests: forget cached blame. */
export function clearBlameCache() {
  cache.clear();
}
