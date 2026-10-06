import { useSyncExternalStore } from "react";
import { create } from "zustand";
import type { RpcConnection, TreeItemDTO, TreeViewOptionsDTO } from "@tmcode/exthost";
import { log } from "../../state/store";
import { HOST_CHANNEL } from "../output";
import type { HostKind } from "../state";

/**
 * The workbench's copy of the extension tree views ("MainThreadTreeViews"):
 * items by handle, children fetched lazily from the host ($treeChildren) and
 * cached per parent, expansion and selection. A host refresh drops the cached
 * children it invalidates and fetches again what is expanded.
 */

export interface HostLink {
  kind: HostKind;
  rpc: RpcConnection;
}

type Children = { state: "loading" } | { state: "done"; handles: string[] } | { state: "error"; message: string };

export interface TreeModel {
  viewId: string;
  link: HostLink;
  options: TreeViewOptionsDTO;
  items: Map<string, TreeItemDTO>;
  /** "" = the roots. */
  children: Map<string, Children>;
  expanded: Set<string>;
  /** Handles the user expanded or collapsed (their state wins over the item's collapsibleState). */
  touched: Set<string>;
  selection: string[];
  focus: string | null;
  visible: boolean;
  /** Bumps on every change (React re-renders on it). */
  version: number;
  /** Set by reveal: the row to scroll into view. */
  scrollTo: string | null;
}

const trees = new Map<string, TreeModel>();
const listeners = new Map<string, Set<() => void>>();

/** Which tree views are registered now (view id → host). */
export const useTreeRegistry = create<{ registered: Record<string, HostKind> }>()(() => ({ registered: {} }));

function changed(t: TreeModel) {
  t.version++;
  listeners.get(t.viewId)?.forEach((l) => l());
}

function request<T>(t: TreeModel, method: string, params: unknown[]): Promise<T> {
  return t.link.rpc.request<T>(method, params);
}

function notify(t: TreeModel, method: string, params: unknown[]) {
  void t.link.rpc.request(method, params).catch((e) => log(HOST_CHANNEL, `${method} (${t.viewId}) failed: ${String((e as Error)?.message ?? e)}`, "warn"));
}

export function registerTree(link: HostLink, viewId: string, options: TreeViewOptionsDTO) {
  const prev = trees.get(viewId);
  const t: TreeModel = { viewId, link, options, items: new Map(), children: new Map(), expanded: new Set(), touched: new Set(), selection: [], focus: null, visible: false, version: (prev?.version ?? 0) + 1, scrollTo: null };
  trees.set(viewId, t);
  useTreeRegistry.setState((s) => ({ registered: { ...s.registered, [viewId]: link.kind } }));
  changed(t);
  if (prev?.visible) setTreeVisible(viewId, true);
}

export function disposeTree(viewId: string) {
  const t = trees.get(viewId);
  if (!t) return;
  trees.delete(viewId);
  useTreeRegistry.setState((s) => {
    const registered = { ...s.registered };
    delete registered[viewId];
    return { registered };
  });
  changed(t);
}

export function disposeTreesOf(kind: HostKind) {
  for (const [id, t] of [...trees]) if (t.link.kind === kind) disposeTree(id);
}

export function getTree(viewId: string): TreeModel | undefined {
  return trees.get(viewId);
}

export function useTree(viewId: string): TreeModel | undefined {
  useSyncExternalStore(
    (l) => {
      let set = listeners.get(viewId);
      if (!set) listeners.set(viewId, (set = new Set()));
      set.add(l);
      return () => set!.delete(l);
    },
    () => (trees.get(viewId)?.version ?? 0) + (trees.has(viewId) ? 0 : -1),
  );
  return trees.get(viewId);
}

function isExpanded(t: TreeModel, item: TreeItemDTO) {
  if (t.touched.has(item.handle)) return t.expanded.has(item.handle);
  return item.collapsible === 2;
}

/** Fetches the children of `parent` ("" = roots); expanded children are fetched too. */
export async function loadChildren(viewId: string, parent: string): Promise<void> {
  const t = trees.get(viewId);
  if (!t) return;
  const prev = t.children.get(parent);
  if (!prev || prev.state !== "done") t.children.set(parent, { state: "loading" });
  changed(t);
  try {
    const list = await request<TreeItemDTO[]>(t, "$treeChildren", [viewId, parent === "" ? null : parent]);
    if (trees.get(viewId) !== t) return;
    // The host released the old children (and their subtrees): forget them here too.
    if (prev?.state === "done") for (const h of prev.handles) if (!list.some((i) => i.handle === h)) forget(t, h);
    for (const item of list ?? []) t.items.set(item.handle, item);
    t.children.set(parent, { state: "done", handles: (list ?? []).map((i) => i.handle) });
    const again: Promise<void>[] = [];
    for (const item of list ?? []) {
      if (item.collapsible && isExpanded(t, item)) {
        t.expanded.add(item.handle);
        if (!t.children.has(item.handle) || prev?.state === "done") again.push(loadChildren(viewId, item.handle));
      } else {
        t.expanded.delete(item.handle);
        // Collapsed: fetched again on expand.
        dropChildren(t, item.handle);
      }
    }
    changed(t);
    await Promise.all(again);
  } catch (e) {
    if (trees.get(viewId) !== t) return;
    t.children.set(parent, { state: "error", message: String((e as Error)?.message ?? e) });
    changed(t);
  }
}

function dropChildren(t: TreeModel, handle: string) {
  const c = t.children.get(handle);
  if (c?.state === "done") for (const h of c.handles) forget(t, h);
  t.children.delete(handle);
}

function forget(t: TreeModel, handle: string) {
  dropChildren(t, handle);
  t.items.delete(handle);
}

export function childrenOf(t: TreeModel, parent: string): Children | undefined {
  return t.children.get(parent);
}

/** `onDidChangeTreeData`: the whole tree (null) or some items. */
export function refreshTree(viewId: string, data: { items: TreeItemDTO[] } | null) {
  const t = trees.get(viewId);
  if (!t) return;
  if (!data) {
    if (t.visible || t.children.has("")) void loadChildren(viewId, "");
    return;
  }
  for (const item of data.items) {
    if (!t.items.has(item.handle)) continue;
    t.items.set(item.handle, item);
    if (t.expanded.has(item.handle) || (!t.touched.has(item.handle) && item.collapsible === 2)) void loadChildren(viewId, item.handle);
    else dropChildren(t, item.handle);
  }
  changed(t);
}

export function revealInTree(viewId: string, data: { path: string[]; items: Record<string, TreeItemDTO[]>; select: boolean; focus: boolean; expand: number }) {
  const t = trees.get(viewId);
  if (!t) return;
  for (const [parent, list] of Object.entries(data.items)) {
    for (const item of list) t.items.set(item.handle, item);
    t.children.set(parent, { state: "done", handles: list.map((i) => i.handle) });
  }
  const target = data.path[data.path.length - 1];
  for (const h of data.path.slice(0, -1)) {
    t.expanded.add(h);
    t.touched.add(h);
  }
  if (data.expand && target) {
    t.expanded.add(target);
    t.touched.add(target);
  }
  // Expanded ancestors whose children the host did not send are fetched.
  for (const h of t.expanded) if (!t.children.has(h)) void loadChildren(viewId, h);
  if (data.select && target) {
    t.selection = [target];
    t.focus = target;
    notify(t, "$treeSelection", [viewId, t.selection]);
  }
  t.scrollTo = target ?? null;
  changed(t);
}

export function toggleExpanded(viewId: string, handle: string, expand?: boolean) {
  const t = trees.get(viewId);
  const item = t?.items.get(handle);
  if (!t || !item?.collapsible) return;
  const open = expand ?? !t.expanded.has(handle);
  if (open === t.expanded.has(handle)) return;
  t.touched.add(handle);
  if (open) {
    t.expanded.add(handle);
    if (!t.children.has(handle)) void loadChildren(viewId, handle);
  } else t.expanded.delete(handle);
  notify(t, "$treeExpanded", [viewId, handle, open]);
  changed(t);
}

export function collapseAll(viewId: string) {
  const t = trees.get(viewId);
  if (!t) return;
  for (const h of t.expanded) {
    t.touched.add(h);
    notify(t, "$treeExpanded", [viewId, h, false]);
  }
  t.expanded.clear();
  changed(t);
}

export function selectItems(viewId: string, handles: string[], focus?: string) {
  const t = trees.get(viewId);
  if (!t) return;
  t.selection = handles;
  t.focus = focus ?? handles[handles.length - 1] ?? null;
  notify(t, "$treeSelection", [viewId, handles]);
  changed(t);
}

export function setTreeVisible(viewId: string, visible: boolean) {
  const t = trees.get(viewId);
  if (!t || t.visible === visible) return;
  t.visible = visible;
  notify(t, "$treeVisible", [viewId, visible]);
  if (visible && !t.children.has("")) void loadChildren(viewId, "");
}

export function runItemCommand(viewId: string, handle: string) {
  const t = trees.get(viewId);
  if (t) notify(t, "$treeCommand", [viewId, handle]);
}

export function runItemMenuCommand(viewId: string, command: string, handle: string) {
  const t = trees.get(viewId);
  if (!t) return;
  const selected = t.selection.includes(handle) ? t.selection : [handle];
  notify(t, "$treeMenuCommand", [viewId, command, handle, selected]);
}

export function setCheckbox(viewId: string, handle: string, checked: boolean) {
  const t = trees.get(viewId);
  const item = t?.items.get(handle);
  if (!t || !item?.checkbox) return;
  if (!t.options.manageCheckboxStateManually) t.items.set(handle, { ...item, checkbox: { ...item.checkbox, checked } });
  notify(t, "$treeCheckbox", [viewId, [[handle, checked]]]);
  changed(t);
}

export async function resolveTooltip(viewId: string, handle: string): Promise<TreeItemDTO["tooltip"] | undefined> {
  const t = trees.get(viewId);
  const item = t?.items.get(handle);
  if (!t || !item?.resolvable) return item?.tooltip;
  const res = await request<{ tooltip?: TreeItemDTO["tooltip"] } | null>(t, "$treeResolve", [viewId, handle]).catch(() => null);
  if (res?.tooltip !== undefined) t.items.set(handle, { ...item, tooltip: res.tooltip, resolvable: false });
  return res?.tooltip;
}
