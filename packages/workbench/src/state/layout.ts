/**
 * Editor groups as a grid, like VS Code's: a tree of rows and columns whose
 * leaves are editor groups. Splitting a group the same way as its parent adds
 * a sibling; splitting it the other way wraps it in a new branch. Pure
 * functions only, so the layout can be tested, saved and restored.
 */

export type GridNode = { type: "leaf"; group: number } | { type: "branch"; dir: "row" | "column"; children: GridNode[] };

export type SplitDirection = "right" | "left" | "down" | "up";

export const MAX_GROUPS = 8;

export const leaf = (group: number): GridNode => ({ type: "leaf", group });

/** Group ids in reading order (left to right, top to bottom). */
export function groupOrder(node: GridNode): number[] {
  return node.type === "leaf" ? [node.group] : node.children.flatMap(groupOrder);
}

/** A stable key for a node: leaves by group, branches by their first group. */
export function nodeKey(node: GridNode): string {
  return node.type === "leaf" ? `g${node.group}` : `${node.dir}:${groupOrder(node)[0]}`;
}

/** Collapses one-child branches and merges a branch into a parent of the same direction. */
export function normalize(node: GridNode): GridNode {
  if (node.type === "leaf") return node;
  const children: GridNode[] = [];
  for (const c of node.children.map(normalize)) {
    if (c.type === "branch" && c.dir === node.dir) children.push(...c.children);
    else children.push(c);
  }
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/** Puts `group` next to `target` in the given direction. */
export function splitNode(root: GridNode, target: number, group: number, direction: SplitDirection): GridNode {
  const dir = direction === "right" || direction === "left" ? "row" : "column";
  const before = direction === "left" || direction === "up";
  // A same-direction pair is merged into its parent by normalize(): a sibling, not a new branch.
  const visit = (node: GridNode): GridNode => {
    if (node.type === "leaf") {
      if (node.group !== target) return node;
      return { type: "branch", dir, children: before ? [leaf(group), node] : [node, leaf(group)] };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return normalize(visit(root));
}

/** Removes a group; its neighbours take the space. */
export function removeNode(root: GridNode, group: number): GridNode | null {
  if (root.type === "leaf") return root.group === group ? null : root;
  const children = root.children.map((c) => removeNode(c, group)).filter((c): c is GridNode => !!c);
  if (!children.length) return null;
  return normalize({ ...root, children });
}

/**
 * Makes the tree match the groups that exist: leaves without a group go,
 * groups the tree doesn't know (added by older code paths) join the top row.
 */
export function reconcile(root: GridNode | null, groups: number[]): GridNode {
  let tree: GridNode | null = root;
  for (const g of root ? groupOrder(root) : []) if (!groups.includes(g)) tree = tree && removeNode(tree, g);
  const known = tree ? groupOrder(tree) : [];
  const missing = groups.filter((g) => !known.includes(g));
  if (!tree) tree = missing.length > 1 ? { type: "branch", dir: "row", children: missing.map(leaf) } : leaf(missing[0] ?? groups[0] ?? 0);
  else if (missing.length) tree = normalize({ type: "branch", dir: "row", children: [tree, ...missing.map(leaf)] });
  return tree;
}

/** Renames the groups in a tree (restoring a saved layout gives groups new ids). */
export function mapGroups(node: GridNode, map: (id: number) => number | null): GridNode | null {
  if (node.type === "leaf") {
    const id = map(node.group);
    return id == null ? null : leaf(id);
  }
  const children = node.children.map((c) => mapGroups(c, map)).filter((c): c is GridNode => !!c);
  return children.length ? normalize({ ...node, children }) : null;
}

/** The group next to `from` in a direction, by on-screen position (for "Focus Group Below" and drops). */
export function neighbour(root: GridNode, from: number, direction: SplitDirection): number | null {
  const path: { node: Extract<GridNode, { type: "branch" }>; index: number }[] = [];
  const find = (node: GridNode): boolean => {
    if (node.type === "leaf") return node.group === from;
    for (let i = 0; i < node.children.length; i++) {
      path.push({ node, index: i });
      if (find(node.children[i])) return true;
      path.pop();
    }
    return false;
  };
  if (!find(root)) return null;
  const dir = direction === "right" || direction === "left" ? "row" : "column";
  const step = direction === "right" || direction === "down" ? 1 : -1;
  for (let i = path.length - 1; i >= 0; i--) {
    const { node, index } = path[i];
    if (node.dir !== dir) continue;
    const next = node.children[index + step];
    if (!next) continue;
    const order = groupOrder(next);
    return step > 0 ? order[0] : order[order.length - 1];
  }
  return null;
}

// ───────────── saved layout (per folder) ─────────────

export interface SavedEditor {
  path: string;
  /** Pinned (sticky) tab. */
  pinned?: boolean;
}

export interface SavedLayout {
  version: 2;
  tree: GridNode;
  groups: { id: number; editors: SavedEditor[]; active: string | null }[];
  activeGroup: number;
  /** Pane sizes (px) per branch key. */
  sizes?: Record<string, number[]>;
  /** Monaco view state (cursor, selections, scroll) per "<group>:<path>". */
  viewStates?: Record<string, unknown>;
}

/** The pre-0.13 format: just the open files. */
export interface LegacySavedEditors {
  paths: string[];
  active: string | null;
}

interface GroupLike {
  id: number;
  editors: { kind: string; id: string; path?: string; preview: boolean; sticky?: boolean }[];
  activeId: string | null;
}

/** What a folder's layout looks like on disk: file editors only (other editors don't survive a restart). */
export function serializeLayout(
  tree: GridNode,
  groups: GroupLike[],
  activeGroup: number,
  extra: { sizes?: Record<string, number[]>; viewStates?: Record<string, unknown> } = {},
): SavedLayout {
  const saved = groups.map((g) => {
    const editors = g.editors.filter((e) => e.kind === "file" && !e.preview && e.path).map((e) => ({ path: e.path!, ...(e.sticky ? { pinned: true } : {}) }));
    const active = g.editors.find((e) => e.id === g.activeId);
    return { id: g.id, editors: editors.slice(0, 30), active: active?.kind === "file" && !active.preview ? active.path! : (editors[editors.length - 1]?.path ?? null) };
  });
  const keep = new Set(saved.filter((g) => g.editors.length).map((g) => g.id));
  const pruned = mapGroups(reconcile(tree, groups.map((g) => g.id)), (id) => (keep.has(id) ? id : null));
  const viewStates: Record<string, unknown> = {};
  for (const g of saved) for (const e of g.editors) if (extra.viewStates?.[`${g.id}:${e.path}`]) viewStates[`${g.id}:${e.path}`] = extra.viewStates[`${g.id}:${e.path}`];
  return {
    version: 2,
    tree: pruned ?? leaf(groups[0]?.id ?? 0),
    groups: saved.filter((g) => keep.has(g.id)),
    activeGroup: keep.has(activeGroup) ? activeGroup : (saved.find((g) => keep.has(g.id))?.id ?? 0),
    ...(extra.sizes && Object.keys(extra.sizes).length ? { sizes: extra.sizes } : {}),
    ...(Object.keys(viewStates).length ? { viewStates } : {}),
  };
}

/** Accepts both formats; returns null for anything unreadable. */
export function readSavedLayout(raw: unknown): SavedLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SavedLayout> & Partial<LegacySavedEditors>;
  if (r.version === 2 && r.tree && Array.isArray(r.groups)) return r as SavedLayout;
  if (Array.isArray(r.paths)) {
    return { version: 2, tree: leaf(0), groups: [{ id: 0, editors: r.paths.map((path) => ({ path })), active: r.active ?? null }], activeGroup: 0 };
  }
  return null;
}
