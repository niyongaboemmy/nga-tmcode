import { onCodeEditor } from "../monaco/editors";
import { pathOfUri } from "../monaco/documents";
import { monaco } from "../monaco/setup";
import { gitAllowed, useGit } from "./gitService";
import { gutterMarks, splitLines, type GutterKind } from "./lineDiff";

/**
 * VS Code's quick diff in the editor gutter: a green bar for added lines, a
 * blue bar for modified lines and a red triangle where lines were deleted,
 * comparing the editor's text with the file's version in the index.
 */

const CLASS: Record<GutterKind, string> = { added: "tm-dirty-diff-added", modified: "tm-dirty-diff-modified", deleted: "tm-dirty-diff-deleted" };
const RULER: Record<GutterKind, string> = { added: "#2ea04399", modified: "#0078d499", deleted: "#f8514999" };

/** Base text per path for the current status version (null = untracked / not in git). */
const bases = new Map<string, { version: number; text: Promise<string | null> }>();

function baseFor(path: string): Promise<string | null> {
  const { version, status } = useGit.getState();
  const hit = bases.get(path);
  if (hit && hit.version === version) return hit.text;
  const entry = status?.entries.find((e) => e.path === path);
  const host = gitAllowed() && status ? getHost() : undefined;
  const text: Promise<string | null> =
    !host || entry?.kind === "untracked" || entry?.kind === "ignored" || entry?.kind === "unmerged" ? Promise.resolve(null) : host.show(path, "index").catch(() => null);
  bases.set(path, { version, text });
  return text;
}

let getHost: () => import("../platform/types").GitHost | undefined = () => undefined;

export function decorationsFor(base: string | null, current: string): monaco.editor.IModelDeltaDecoration[] {
  if (base === null) return [];
  return gutterMarks(splitLines(base), splitLines(current)).map((m) => {
    const line = Math.max(1, m.startLine);
    return {
      range: new monaco.Range(m.kind === "deleted" ? line : m.startLine, 1, m.kind === "deleted" ? line : m.endLine, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: m.kind === "deleted" && m.startLine === 0 ? `${CLASS.deleted} is-top` : CLASS[m.kind],
        overviewRuler: { color: RULER[m.kind], position: monaco.editor.OverviewRulerLane.Left },
        minimap: { color: RULER[m.kind], position: monaco.editor.MinimapPosition.Gutter },
        description: `git-${m.kind}`,
      },
    };
  });
}

let wired = false;
export function wireGitGutter(host: () => import("../platform/types").GitHost | undefined) {
  if (wired) return;
  wired = true;
  getHost = host;
  const all = new Set<(delay?: number) => void>();
  onCodeEditor((editor) => {
    const collection = editor.createDecorationsCollection();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let seq = 0;
    const update = (delay = 250) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const model = editor.getModel();
        const mine = ++seq;
        if (!model || !gitAllowed() || !useGit.getState().status) return collection.clear();
        const path = pathOfUri(model.uri);
        const base = await baseFor(path);
        if (mine !== seq || editor.getModel() !== model || model.isDisposed()) return;
        collection.set(decorationsFor(base, model.getValue()));
      }, delay);
    };
    all.add(update);
    const subs = [editor.onDidChangeModel(() => update(0)), editor.onDidChangeModelContent(() => update())];
    editor.onDidDispose(() => {
      all.delete(update);
      subs.forEach((d) => d.dispose());
      if (timer) clearTimeout(timer);
    });
    update(0);
  });
  // New repository state (stage, commit, checkout…): re-read the bases.
  useGit.subscribe((s, prev) => {
    if (s.version !== prev.version || s.status !== prev.status) all.forEach((u) => u(50));
  });
}
