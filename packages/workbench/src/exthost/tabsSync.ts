import { titleOf } from "../parts/editor/EditorGroupView";
import { closeEditors, useWorkbench, type EditorInput } from "../state/store";
import { useWebviews } from "./views/webviews";

/**
 * `window.tabGroups` for extensions: a snapshot of the editor groups and their tabs
 * (packages/exthost/src/host/tabs.ts), sent whenever tabs change, and closing tabs
 * on an extension's request.
 */

export interface TabDTO {
  id: string;
  label: string;
  kind: "text" | "diff" | "webview" | "other";
  path?: string;
  original?: string;
  modified?: string;
  viewType?: string;
  isActive: boolean;
  isDirty: boolean;
  isPinned: boolean;
  isPreview: boolean;
}

function tab(e: EditorInput, active: boolean, dirty: Record<string, true>): TabDTO {
  const base = { id: e.id, label: titleOf(e), isActive: active, isPinned: !!e.sticky, isPreview: !!e.preview };
  if (e.kind === "file") return { ...base, kind: "text", path: e.path, isDirty: !!dirty[e.path] };
  // Diffs whose sides are documents (Compare, extensions' vscode.diff): a TabInputTextDiff.
  if (e.kind === "historyDiff" && (e.source === "file" || e.source === "extension")) return { ...base, kind: "diff", original: e.entry, modified: e.path, isDirty: !!dirty[e.path] };
  if (e.kind === "historyDiff" && e.source === "saved") return { ...base, kind: "diff", original: e.path, modified: e.path, isDirty: !!dirty[e.path] };
  if (e.kind === "webview") return { ...base, kind: "webview", viewType: useWebviews.getState().entries[e.handle]?.viewType ?? "", isDirty: false };
  return { ...base, kind: "other", isDirty: false };
}

export function tabsSnapshot() {
  const s = useWorkbench.getState();
  return s.groups.map((g, i) => ({
    id: g.id,
    viewColumn: i + 1,
    isActive: s.activeGroup === g.id,
    tabs: g.editors.map((e) => tab(e, g.activeId === e.id, s.dirty)),
  }));
}

/** `tabGroups.close`: [group, tab id | null (the whole group)][]. */
export async function closeTabs(list: [number, string | null][]): Promise<boolean> {
  let any = false;
  for (const [groupId, tabId] of list) {
    const g = useWorkbench.getState().groups.find((x) => x.id === groupId);
    if (!g) continue;
    const ids = tabId === null ? g.editors.map((e) => e.id) : g.editors.some((e) => e.id === tabId) ? [tabId] : [];
    if (!ids.length) continue;
    await closeEditors(groupId, ids);
    any = true;
  }
  return any;
}
