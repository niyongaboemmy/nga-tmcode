/**
 * Where the schema diagram's tables go (SqlDiagram.tsx), without a layout library: each group of related tables is laid
 * out in layers (a referenced table left of the tables that reference it), crossings reduced by barycentres and rows
 * lined up with their neighbours; tall layers wrap into several columns so 50 children of `users` don't make one
 * endless column. Groups are then packed in rows, tables without relationships last.
 */

export interface LayoutNode {
  id: string;
  w: number;
  h: number;
}

/** From the referencing table to the referenced one (a foreign key), or a view to a table it reads. */
export interface LayoutEdge {
  from: string;
  to: string;
}

export type Positions = Record<string, { x: number; y: number }>;

const GAP_LAYER = 120;
const GAP_SUB = 56;
const GAP_Y = 36;
const GAP_GROUP = 140;

export function layoutDiagram(nodes: LayoutNode[], edges: LayoutEdge[]): Positions {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const valid = edges.filter((e) => e.from !== e.to && byId.has(e.from) && byId.has(e.to));
  // Connected groups (union-find).
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  for (const e of valid) parent.set(find(e.from), find(e.to));
  const groups = new Map<string, LayoutNode[]>();
  for (const n of nodes) {
    const r = find(n.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(n);
  }
  const blocks: { pos: Positions; w: number; h: number }[] = [];
  const singles: LayoutNode[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) singles.push(g[0]);
    else {
      const ids = new Set(g.map((n) => n.id));
      blocks.push(normalise(layered(g, valid.filter((e) => ids.has(e.from))), byId));
    }
  }
  blocks.sort((a, b) => b.w * b.h - a.w * a.h);
  const area = nodes.reduce((s, n) => s + n.w * n.h, 0);
  const rowWidth = Math.max(1400, Math.sqrt(area) * 1.7, ...blocks.map((b) => b.w));
  if (singles.length) blocks.push(flow(singles, Math.max(1200, Math.min(rowWidth, Math.sqrt(singles.reduce((s, n) => s + n.w * n.h, 0)) * 1.8))));
  // Shelf packing.
  const out: Positions = {};
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.w > rowWidth) {
      x = 0;
      y += rowH + GAP_GROUP;
      rowH = 0;
    }
    for (const [id, p] of Object.entries(b.pos)) out[id] = { x: Math.round(p.x + x), y: Math.round(p.y + y) };
    x += b.w + GAP_GROUP;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}

/** Tables in rows of about `width`. */
function flow(nodes: LayoutNode[], width: number): { pos: Positions; w: number; h: number } {
  const pos: Positions = {};
  let x = 0;
  let y = 0;
  let rowH = 0;
  let w = 0;
  for (const n of nodes) {
    if (x > 0 && x + n.w > width) {
      x = 0;
      y += rowH + GAP_Y + 8;
      rowH = 0;
    }
    pos[n.id] = { x, y };
    x += n.w + GAP_SUB;
    w = Math.max(w, x - GAP_SUB);
    rowH = Math.max(rowH, n.h);
  }
  return { pos, w, h: y + rowH };
}

function normalise(pos: Positions, byId: Map<string, LayoutNode>): { pos: Positions; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [id, p] of Object.entries(pos)) {
    const n = byId.get(id)!;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + n.w);
    y1 = Math.max(y1, p.y + n.h);
  }
  for (const p of Object.values(pos)) {
    p.x -= x0;
    p.y -= y0;
  }
  return { pos, w: x1 - x0, h: y1 - y0 };
}

/** One connected group in layers. */
function layered(nodes: LayoutNode[], edges: LayoutEdge[]): Positions {
  const ids = nodes.map((n) => n.id);
  const size = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  const neighbours = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const e of edges) {
    children.get(e.to)!.push(e.from);
    neighbours.get(e.from)!.add(e.to);
    neighbours.get(e.to)!.add(e.from);
  }
  // A DAG: depth-first from the most referenced tables, dropping edges that close a cycle.
  const order = [...ids].sort((a, b) => children.get(b)!.length - children.get(a)!.length);
  const state = new Map<string, number>();
  const dag = new Map<string, string[]>(ids.map((id) => [id, []]));
  const topo: string[] = [];
  const visit = (root: string) => {
    const stack: [string, number][] = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const kids = children.get(top[0])!;
      if (top[1] < kids.length) {
        const k = kids[top[1]++];
        const s = state.get(k);
        if (s === 1) continue; // back edge
        dag.get(top[0])!.push(k);
        if (!s) {
          state.set(k, 1);
          stack.push([k, 0]);
        }
      } else {
        state.set(top[0], 2);
        topo.push(top[0]);
        stack.pop();
      }
    }
  };
  for (const id of order) if (!state.get(id)) visit(id);
  topo.reverse();
  // Longest path from the referenced tables; a table referenced by nothing sits just left of its first child.
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const id of topo) for (const k of dag.get(id)!) rank.set(k, Math.max(rank.get(k)!, rank.get(id)! + 1));
  const hasParent = new Set([...dag.values()].flat());
  for (const id of ids) {
    const kids = dag.get(id)!;
    if (!hasParent.has(id) && kids.length) rank.set(id, Math.min(...kids.map((k) => rank.get(k)!)) - 1);
  }
  const min = Math.min(...rank.values());
  const layers: string[][] = [];
  for (const id of topo) {
    const r = rank.get(id)! - min;
    (layers[r] ??= []).push(id);
  }
  const layerOf = new Map<string, number>();
  layers.forEach((l, r) => l.forEach((id) => layerOf.set(id, r)));
  // Barycentre sweeps on the order within layers.
  const index = new Map<string, number>();
  const reindex = () => layers.forEach((l) => l.forEach((id, i) => index.set(id, i / Math.max(1, l.length - 1))));
  reindex();
  for (let pass = 0; pass < 8; pass++) {
    const down = pass % 2 === 0;
    const seq = down ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
    for (const r of seq) {
      const l = layers[r];
      const key = new Map<string, number>();
      for (const id of l) {
        const ns = [...neighbours.get(id)!].filter((n) => (down ? layerOf.get(n)! < r : layerOf.get(n)! > r));
        key.set(id, ns.length ? ns.reduce((s, n) => s + index.get(n)!, 0) / ns.length : index.get(id)!);
      }
      l.sort((a, b) => key.get(a)! - key.get(b)!);
      l.forEach((id, i) => index.set(id, i / Math.max(1, l.length - 1)));
    }
  }
  // Columns: a layer taller than the group would be square wraps into several.
  const area = nodes.reduce((s, n) => s + (n.w + GAP_LAYER / 2) * (n.h + GAP_Y), 0);
  const maxH = Math.max(900, Math.sqrt(area) * 1.1);
  const columns: { ids: string[]; gapBefore: number }[] = [];
  for (const l of layers) {
    if (!l?.length) continue;
    const total = l.reduce((s, id) => s + size.get(id)!.h + GAP_Y, 0);
    const k = Math.max(1, Math.ceil(total / maxH));
    const target = total / k;
    let cur: string[] = [];
    let h = 0;
    let first = true;
    for (const id of l) {
      const nh = size.get(id)!.h + GAP_Y;
      if (cur.length && h + nh / 2 > target && columns.length < 10_000) {
        columns.push({ ids: cur, gapBefore: first ? GAP_LAYER : GAP_SUB });
        first = false;
        cur = [];
        h = 0;
      }
      cur.push(id);
      h += nh;
    }
    if (cur.length) columns.push({ ids: cur, gapBefore: first ? GAP_LAYER : GAP_SUB });
  }
  const pos: Positions = {};
  let x = 0;
  columns.forEach((col, ci) => {
    if (ci > 0) x += col.gapBefore;
    const w = Math.max(...col.ids.map((id) => size.get(id)!.w));
    let y = 0;
    for (const id of col.ids) {
      pos[id] = { x: x + (w - size.get(id)!.w) / 2, y };
      y += size.get(id)!.h + GAP_Y;
    }
    for (const id of col.ids) pos[id].y -= (y - GAP_Y) / 2;
    x += w;
  });
  // Line tables up with their neighbours: each column moves towards its neighbours' centres, in order, without overlaps.
  const centre = (id: string) => pos[id].y + size.get(id)!.h / 2;
  for (let pass = 0; pass < 6; pass++) {
    const seq = pass % 2 === 0 ? columns : [...columns].reverse();
    for (const col of seq) {
      const desired = new Map<string, number>();
      for (const id of col.ids) {
        const ns = [...neighbours.get(id)!].filter((n) => !col.ids.includes(n));
        desired.set(id, ns.length ? ns.reduce((s, n) => s + centre(n), 0) / ns.length : centre(id));
      }
      col.ids.sort((a, b) => desired.get(a)! - desired.get(b)!);
      placeInOrder(col.ids, (id) => size.get(id)!.h, (id) => desired.get(id)! - size.get(id)!.h / 2).forEach((y, i) => (pos[col.ids[i]].y = y));
    }
  }
  return pos;
}

/**
 * Tops for items kept in this order, `GAP_Y` apart, as close as possible (least squares) to where each wants to be:
 * isotonic regression by pool-adjacent-violators on the targets less the space taken above.
 */
export function placeInOrder<T>(items: T[], height: (t: T) => number, want: (t: T) => number): number[] {
  const offset: number[] = [];
  let s = 0;
  for (const it of items) {
    offset.push(s);
    s += height(it) + GAP_Y;
  }
  const blocks: { sum: number; n: number }[] = [];
  items.forEach((it, i) => {
    blocks.push({ sum: want(it) - offset[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop()!;
      blocks[blocks.length - 1].sum += b.sum;
      blocks[blocks.length - 1].n += b.n;
    }
  });
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.sum / b.n + offset[out.length]);
  return out;
}
