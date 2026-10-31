import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { getDocument, onDocumentChanged } from "../../monaco/documents";
import { revealInEditor } from "../../monaco/reveal";
import { getPlatform, notify } from "../../state/store";
import { basename } from "../../util/paths";
import { ActionButton, Codicon } from "../../widgets/icons";
import { setViewMode } from "./documentPreview";
import { canvasBytes, exportScale, pdfWithJpeg, saveExport, svgToCanvas } from "./sqlDiagramExport";
import { layoutDiagram, type Positions } from "./sqlDiagramLayout";
import { columnFlags, parseSqlSchemaAsync, relationships, type ColumnFlags, type Relationship, type SqlColumn, type SqlSchema, type SqlTable } from "./sqlSchema";

/**
 * A .sql file's Preview: its schema as an entity-relationship diagram, like MySQL Workbench's EER diagram. Tables are
 * cards (keys, types, badges), foreign keys are lines with crow's-foot ends; pan, zoom, drag (positions kept per file),
 * search, a details panel, a minimap, and export as PNG, PDF or SVG. Drawn as one SVG whose styles travel with it, so
 * the export is the same drawing.
 */

// ───────────────────────── geometry ─────────────────────────

const HEADER = 34;
const ROW = 22;
const COMMENT = 20;
const PAD = 6;
const MIN_W = 200;
const MAX_W = 420;
const NAME_MAX = 210;
const TYPE_MAX = 150;
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Ubuntu, sans-serif";
const MONO = "Menlo, Monaco, Consolas, 'Courier New', monospace";

interface Row {
  col: SqlColumn;
  flags: ColumnFlags;
  name: string;
  type: string;
  badges: string[];
}

interface Card {
  t: SqlTable;
  w: number;
  h: number;
  rows: Row[];
  /** Columns left out in "keys only". */
  hidden: number;
  comment?: string;
  /** Lower-case column name → y of its row's middle, from the card's top. */
  rowY: Map<string, number>;
  typeX: number;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
/** Text width in px (canvas when there is one, else an estimate). */
function measure(text: string, font: string): number {
  const key = `${font}|${text}`;
  let w = widths.get(key);
  if (w !== undefined) return w;
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d");
    } catch {
      measureCtx = null;
    }
  }
  if (measureCtx) {
    measureCtx.font = font;
    w = measureCtx.measureText(text).width;
  } else w = text.length * (font.includes("Menlo") ? 6.7 : 6.6);
  if (widths.size > 50_000) widths.clear();
  widths.set(key, w);
  return w;
}

/** `text` cut with … to fit `max` px. */
function fit(text: string, max: number, font: string): string {
  if (measure(text, font) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${text.slice(0, mid)}…`, font) <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

const F_NAME = `12px ${FONT}`;
const F_NAME_PK = `600 12px ${FONT}`;
const F_TYPE = `11px ${MONO}`;
const F_TITLE = `600 13px ${FONT}`;
const F_COMMENT = `italic 11px ${FONT}`;

function badgesOf(col: SqlColumn, f: ColumnFlags): string[] {
  const b: string[] = [];
  if (f.pk && f.fk) b.push("FK");
  if (f.unique && !f.pk) b.push("UQ");
  if (f.indexed && !f.unique && !f.fk) b.push("IX");
  if (col.autoIncrement) b.push("AI");
  if (f.hasDefault || col.generated) b.push(col.generated ? "GC" : "DF");
  return b;
}

function buildCard(t: SqlTable, keysOnly: boolean): Card {
  const all = t.columns.map((col) => {
    const flags = columnFlags(t, col);
    return { col, flags, name: fit(col.name, NAME_MAX, flags.pk ? F_NAME_PK : F_NAME), type: fit(col.type, TYPE_MAX, F_TYPE), badges: badgesOf(col, flags) };
  });
  const rows = keysOnly && t.kind === "table" ? all.filter((r) => r.flags.pk || r.flags.fk || r.flags.unique) : all;
  const hidden = all.length - rows.length;
  const comment = t.comment ? fit(t.comment, MAX_W - 24, F_COMMENT) : undefined;
  let nameW = 0;
  let typeW = 0;
  let badgeW = 0;
  for (const r of rows) {
    nameW = Math.max(nameW, measure(r.name, r.flags.pk ? F_NAME_PK : F_NAME));
    typeW = Math.max(typeW, measure(r.type, F_TYPE));
    badgeW = Math.max(badgeW, r.badges.length * 21);
  }
  const titleW = measure(t.name, F_TITLE) + 54;
  const w = Math.round(Math.min(MAX_W, Math.max(MIN_W, 30 + nameW + 18 + typeW + badgeW + 12, titleW + 24, comment ? measure(comment, F_COMMENT) + 24 : 0)));
  const top = HEADER + (comment ? COMMENT : 0);
  const rowY = new Map<string, number>();
  rows.forEach((r, i) => rowY.set(r.col.name.toLowerCase(), top + i * ROW + ROW / 2));
  const h = top + (rows.length + (hidden ? 1 : 0)) * ROW + PAD;
  return { t, w, h: Math.max(h, top + PAD + ROW), rows, hidden, comment, rowY, typeX: w - 12 - badgeW };
}

// ───────────────────────── edges ─────────────────────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a column's line meets the card: its row, or the header when the row is hidden. */
function anchorY(card: Card, p: { y: number }, cols: string[]): number {
  for (const c of cols) {
    const y = card.rowY.get(c.toLowerCase());
    if (y !== undefined) return p.y + y;
  }
  return p.y + HEADER / 2;
}

interface EdgeGeo {
  d: string;
  /** Child end, parent end: point and the direction the line leaves the card in (+1 right, -1 left). */
  a: [number, number, number];
  b: [number, number, number];
}

function edgeGeo(A: Box, ay: number, B: Box, by: number, self: boolean): EdgeGeo {
  if (self) {
    const x = A.x + A.w;
    const c = 46 + Math.min(60, Math.abs(by - ay) * 0.15);
    return { d: `M${x},${ay} C${x + c},${ay} ${x + c},${by} ${x},${by}`, a: [x, ay, 1], b: [x, by, 1] };
  }
  let sa: number;
  let sb: number;
  if (A.x + A.w + 30 <= B.x) [sa, sb] = [1, -1];
  else if (B.x + B.w + 30 <= A.x) [sa, sb] = [-1, 1];
  else {
    // Above one another: both lines leave on the side nearer the other card's centre line.
    const right = A.x + A.w / 2 <= B.x + B.w / 2 ? A.x + A.w >= B.x + B.w : true;
    sa = sb = right ? 1 : -1;
  }
  const ax = sa > 0 ? A.x + A.w : A.x;
  const bx = sb > 0 ? B.x + B.w : B.x;
  let d: string;
  if (sa === sb) {
    const cx = sa > 0 ? Math.max(ax, bx) + 50 : Math.min(ax, bx) - 50;
    d = `M${ax},${ay} C${cx},${ay} ${cx},${by} ${bx},${by}`;
  } else {
    const c = Math.max(40, Math.abs(bx - ax) * 0.45);
    d = `M${ax},${ay} C${ax + sa * c},${ay} ${bx + sb * c},${by} ${bx},${by}`;
  }
  return { d, a: [ax, ay, sa], b: [bx, by, sb] };
}

/** Crow's-foot ends: "many" (crow) or "one" (bar), "mandatory" (a second bar) or optional (a ring). */
function endMarks([x, y, s]: [number, number, number], many: boolean, mandatory: boolean): ReactNode {
  const p: string[] = [];
  let ring = 0;
  if (many) {
    p.push(`M${x + s * 12},${y} L${x},${y - 6} M${x + s * 12},${y} L${x},${y + 6}`);
    if (mandatory) p.push(`M${x + s * 15},${y - 6} L${x + s * 15},${y + 6}`);
    else ring = 18;
  } else {
    p.push(`M${x + s * 6},${y - 6} L${x + s * 6},${y + 6}`);
    if (mandatory) p.push(`M${x + s * 11},${y - 6} L${x + s * 11},${y + 6}`);
    else ring = 14;
  }
  return (
    <>
      <path className="sd-mark" d={p.join(" ")} />
      {ring > 0 && <circle className="sd-ring" cx={x + s * ring} cy={y} r={3.5} />}
    </>
  );
}

// ───────────────────────── the drawing ─────────────────────────

/** The SVG's own styles (they travel with an export); colours come from --sd-* variables set on the svg. */
const DIAGRAM_CSS = `
.sd-card-bg{fill:var(--sd-card);stroke:var(--sd-border);stroke-width:1}
.sd-head{fill:var(--sd-head)}
.sd-card.is-view .sd-head{fill:var(--sd-view-head)}
.sd-stripe{fill:var(--sd-table)}
.sd-card.is-view .sd-stripe{fill:var(--sd-view)}
.sd-title{font:600 13px var(--sd-font);fill:var(--sd-fg)}
.sd-count{font:11px var(--sd-font);fill:var(--sd-muted)}
.sd-kind{font:600 9px var(--sd-font);fill:var(--sd-view);letter-spacing:.06em}
.sd-name{font:12px var(--sd-font);fill:var(--sd-fg)}
.sd-name.is-pk{font-weight:600}
.sd-type{font:11px var(--sd-mono);fill:var(--sd-muted)}
.sd-more{font:italic 11px var(--sd-font);fill:var(--sd-muted)}
.sd-comment{font:italic 11px var(--sd-font);fill:var(--sd-muted)}
.sd-sep{stroke:var(--sd-border);stroke-width:1}
.sd-badge rect{fill:var(--sd-badge);stroke:none}
.sd-badge text{font:600 8.5px var(--sd-font);fill:var(--sd-muted);text-anchor:middle}
.sd-key{fill:none;stroke:var(--sd-pk);stroke-width:1.5;stroke-linecap:round}
.sd-fkicon{fill:none;stroke:var(--sd-fk);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.sd-dia{fill:var(--sd-muted)}
.sd-dia.is-null{fill:none;stroke:var(--sd-muted);stroke-width:1}
.sd-row-hl{fill:var(--sd-hl)}
.sd-skel{fill:var(--sd-muted);opacity:.18}
.sd-big{font-family:var(--sd-font);font-weight:600;fill:var(--sd-fg)}
.sd-line{fill:none;stroke:var(--sd-line);stroke-width:1.4}
.sd-edge.is-optional .sd-line{stroke-dasharray:6 4}
.sd-edge.is-view .sd-line{stroke-dasharray:2 4;stroke:var(--sd-view)}
.sd-mark{fill:none;stroke:var(--sd-line);stroke-width:1.4}
.sd-ring{fill:var(--sd-bg);stroke:var(--sd-line);stroke-width:1.4}
.sd-hit{fill:none;stroke:transparent;stroke-width:12}
.sd-edge.is-hl .sd-line,.sd-edge.is-hl .sd-mark,.sd-edge.is-hl .sd-ring{stroke:var(--sd-accent);stroke-width:2.2}
.sd-dim{opacity:.22}
.sd-card.is-hl .sd-card-bg{stroke:var(--sd-accent);stroke-width:1.5}
.sd-card.is-selected .sd-card-bg{stroke:var(--sd-accent);stroke-width:2.5}
.sd-card.is-match .sd-card-bg{stroke:var(--sd-match);stroke-width:2.5}
`;

/** The theme colours the drawing uses, as workbench.css maps them from the theme (read again for an export). */
const SD_VARS = ["--sd-bg", "--sd-fg", "--sd-muted", "--sd-card", "--sd-head", "--sd-view-head", "--sd-border", "--sd-line", "--sd-accent", "--sd-match", "--sd-pk", "--sd-fk", "--sd-table", "--sd-view", "--sd-badge", "--sd-hl", "--sd-font", "--sd-mono"];

type Mode = "" | "dim" | "hl" | "selected" | "match";

const Icon = ({ f, y }: { f: ColumnFlags; y: number }) => {
  if (f.pk)
    return (
      <g transform={`translate(12,${y})`}>
        <circle className="sd-key" cx={3} cy={0} r={2.8} />
        <path className="sd-key" d="M5.8,0 H12 M10,0 V3 M12,0 V2.5" />
      </g>
    );
  if (f.fk)
    return (
      <g transform={`translate(12,${y})`}>
        <path className="sd-fkicon" d="M0,0 H9 M6,-3 L9.5,0 L6,3" />
      </g>
    );
  return <path className={`sd-dia${f.notNull ? "" : " is-null"}`} d={`M17,${y - 4} L21,${y} L17,${y + 4} L13,${y} Z`} />;
};

/** `low`: zoomed out too far to read columns, so they are drawn as bars and the name as large as fits (`label` px). */
const TableCard = memo(function TableCard({ card, x, y, mode, hlCols, low, label }: { card: Card; x: number; y: number; mode: Mode; hlCols: string; low: boolean; label: number }) {
  const { t, w, h, rows } = card;
  const top = HEADER + (card.comment ? COMMENT : 0);
  const hl = hlCols ? new Set(hlCols.split("\n")) : null;
  const cls = `sd-card${t.kind === "view" ? " is-view" : ""}${mode === "dim" ? " sd-dim" : mode ? ` is-${mode}` : ""}`;
  return (
    <g className={cls} transform={`translate(${x},${y})`} data-table={t.id}>
      <rect className="sd-card-bg" width={w} height={h} rx={8} />
      <path className="sd-head" d={`M0,8 A8,8 0 0 1 8,0 H${w - 8} A8,8 0 0 1 ${w},8 V${HEADER} H0 Z`} />
      <path className="sd-stripe" d={`M0,8 A8,8 0 0 1 8,0 H${w - 8} A8,8 0 0 1 ${w},8 V3 H0 Z`} transform="translate(0,0)" />
      {!low && (
        <text className="sd-title" x={12} y={22}>
          {fit(t.name, w - 70, F_TITLE)}
        </text>
      )}
      {low ? null : t.kind === "view" ? (
        <text className="sd-kind" x={w - 12} y={21} textAnchor="end">
          VIEW
        </text>
      ) : (
        <text className="sd-count" x={w - 12} y={21} textAnchor="end">
          {t.columns.length}
        </text>
      )}
      <line className="sd-sep" x1={0} x2={w} y1={HEADER} y2={HEADER} />
      {card.comment && (
        <text className="sd-comment" x={12} y={HEADER + 14}>
          {card.comment}
        </text>
      )}
      {low && rows.map((r, i) => <rect key={r.col.name} className="sd-skel" x={12} y={top + i * ROW + 8} width={Math.min(w - 24, 40 + r.col.name.length * 5)} height={6} rx={3} />)}
      {low && <BigName name={t.name} w={w} h={h} label={label} />}
      {!low &&
        rows.map((r, i) => {
            const cy = top + i * ROW + ROW / 2;
            return (
              <g key={r.col.name}>
                {hl?.has(r.col.name.toLowerCase()) && <rect className="sd-row-hl" x={1} y={cy - ROW / 2} width={w - 2} height={ROW} />}
                <Icon f={r.flags} y={cy} />
                <text className={`sd-name${r.flags.pk ? " is-pk" : ""}`} x={30} y={cy + 4}>
                  {r.name}
                </text>
                <text className="sd-type" x={card.typeX} y={cy + 4} textAnchor="end">
                  {r.type}
                </text>
                {r.badges.map((b, k) => (
                  <g key={b} className="sd-badge" transform={`translate(${card.typeX + 6 + k * 21},${cy - 6})`}>
                    <rect width={18} height={12} rx={3} />
                    <text x={9} y={9}>
                      {b}
                    </text>
                  </g>
                ))}
                <title>{columnSummary(r.col, r.flags)}</title>
              </g>
            );
          })}
      {card.hidden > 0 && (
        <text className="sd-more" x={30} y={top + rows.length * ROW + 15}>
          {card.hidden} more column{card.hidden === 1 ? "" : "s"}
        </text>
      )}
    </g>
  );
});

/** A long name on two lines, split at the camelCase or _ boundary nearest its middle. */
export function splitName(name: string): string[] {
  if (name.length < 14) return [name];
  let best = -1;
  for (let i = 3; i < name.length - 3; i++) {
    const boundary = name[i - 1] === "_" || (/[a-z0-9]/.test(name[i - 1]) && /[A-Z]/.test(name[i]));
    if (boundary && (best < 0 || Math.abs(i - name.length / 2) < Math.abs(best - name.length / 2))) best = i;
  }
  return best < 0 ? [name] : [name.slice(0, best), name.slice(best)];
}

/** Zoomed out: the table's name as large as the card allows, up to about 12 px on screen. */
function BigName({ name, w, h, label }: { name: string; w: number; h: number; label: number }) {
  const lines = splitName(name);
  const longest = Math.max(...lines.map((l) => l.length));
  const size = Math.max(13, Math.min(label, (w - 16) / (longest * 0.6), (h - 8) / (lines.length * 1.2)));
  const y0 = Math.min(h / 2, 12 + size * lines.length * 0.6) - ((lines.length - 1) * size * 1.15) / 2 + size * 0.35;
  return (
    <text className="sd-big" textAnchor="middle" style={{ fontSize: size }}>
      {lines.map((l, i) => (
        <tspan key={i} x={w / 2} y={y0 + i * size * 1.15}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

function columnSummary(col: SqlColumn, f: ColumnFlags): string {
  const parts = [`${col.name} ${col.type}`.trim()];
  if (f.pk) parts.push("PRIMARY KEY");
  if (f.fk) parts.push("FOREIGN KEY");
  if (f.unique && !f.pk) parts.push("UNIQUE");
  if (f.indexed && !f.pk) parts.push("indexed");
  parts.push(col.nullable ? "NULL" : "NOT NULL");
  if (col.autoIncrement) parts.push("AUTO_INCREMENT");
  if (col.default !== undefined) parts.push(`DEFAULT ${col.default}`);
  if (col.generated) parts.push(`AS (${col.generated})`);
  if (col.onUpdate) parts.push(`ON UPDATE ${col.onUpdate}`);
  return parts.join(" · ") + (col.comment ? `\n${col.comment}` : "");
}

interface DrawProps {
  cards: Map<string, Card>;
  pos: Positions;
  rels: Relationship[];
  views: { from: string; to: string }[];
  low?: boolean;
  /** Zoomed out: table names drawn this large (px, before zoom) so they stay readable. */
  label?: number;
  modeOf?: (id: string) => Mode;
  relMode?: (id: string) => "" | "hl" | "dim";
  hlColsOf?: (id: string) => string;
}

function Edge({ r, cards, pos, mode, low }: { r: Relationship; cards: Map<string, Card>; pos: Positions; mode: "" | "hl" | "dim"; low?: boolean }) {
  const A = cards.get(r.from)!;
  const B = cards.get(r.to)!;
  const pa = pos[r.from];
  const pb = pos[r.to];
  const ay = anchorY(A, pa, r.fk.columns);
  const by = anchorY(B, pb, r.fk.refColumns);
  const g = edgeGeo({ ...pa, w: A.w, h: A.h }, ay, { ...pb, w: B.w, h: B.h }, by, r.from === r.to);
  return (
    <g className={`sd-edge${r.mandatory ? "" : " is-optional"}${mode === "hl" ? " is-hl" : mode === "dim" ? " sd-dim" : ""}`} data-rel={r.id}>
      <path className="sd-hit" d={g.d} />
      <path className="sd-line" d={g.d} />
      {!low && endMarks(g.a, !r.oneToOne, false)}
      {!low && endMarks(g.b, false, r.mandatory)}
      <title>
        {`${A.t.name}.${r.fk.columns.join(", ")} → ${B.t.name}.${r.fk.refColumns.join(", ")}`}
        {r.fk.onDelete ? `\nON DELETE ${r.fk.onDelete}` : ""}
        {r.fk.onUpdate ? `\nON UPDATE ${r.fk.onUpdate}` : ""}
      </title>
    </g>
  );
}

function Drawing({ cards, pos, rels, views, low, label, modeOf, relMode, hlColsOf }: DrawProps) {
  const shown = rels.filter((r) => pos[r.from] && pos[r.to]);
  const hot = relMode ? shown.filter((r) => relMode(r.id) === "hl") : [];
  return (
    <>
      <g className="sd-edges">
        {views.map((v) => {
          const A = cards.get(v.from);
          const B = cards.get(v.to);
          if (!A || !B || !pos[v.from] || !pos[v.to]) return null;
          const g = edgeGeo({ ...pos[v.from], w: A.w, h: A.h }, pos[v.from].y + HEADER / 2, { ...pos[v.to], w: B.w, h: B.h }, pos[v.to].y + HEADER / 2, false);
          const m = modeOf?.(v.from) === "dim" && modeOf?.(v.to) === "dim" ? " sd-dim" : "";
          return (
            <g key={`${v.from}>${v.to}`} className={`sd-edge is-view${m}`}>
              <path className="sd-line" d={g.d} />
            </g>
          );
        })}
        {shown.map((r) => (relMode?.(r.id) === "hl" ? null : <Edge key={r.id} r={r} cards={cards} pos={pos} mode={relMode?.(r.id) ?? ""} low={low} />))}
      </g>
      <g className="sd-tables">
        {[...cards.values()].map((c) => {
          const p = pos[c.t.id];
          return p ? <TableCard key={c.t.id} card={c} x={p.x} y={p.y} mode={modeOf?.(c.t.id) ?? ""} hlCols={hlColsOf?.(c.t.id) ?? ""} low={!!low} label={label ?? 13} /> : null;
        })}
      </g>
      {/* Highlighted lines over the cards, so they stay visible where they cross one. */}
      <g className="sd-edges-hot">
        {hot.map((r) => (
          <Edge key={r.id} r={r} cards={cards} pos={pos} mode="hl" low={low} />
        ))}
      </g>
    </>
  );
}

function bounds(cards: Map<string, Card>, pos: Positions): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [id, c] of cards) {
    const p = pos[id];
    if (!p) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + c.w);
    y1 = Math.max(y1, p.y + c.h);
  }
  return x0 === Infinity ? { x: 0, y: 0, w: 1, h: 1 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ───────────────────────── positions kept per file ─────────────────────────

const storeKey = (path: string) => `tmcode:sql-diagram:${path}`;

interface Saved {
  pos?: Positions;
  keysOnly?: boolean;
}

function loadSaved(path: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(storeKey(path)) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

function saveSaved(path: string, s: Saved) {
  try {
    if (!s.pos && s.keysOnly === undefined) localStorage.removeItem(storeKey(path));
    else localStorage.setItem(storeKey(path), JSON.stringify(s));
  } catch {
    // Storage full or blocked: positions just aren't remembered.
  }
}

// ───────────────────────── the preview ─────────────────────────

type Sel = { kind: "table" | "rel"; id: string } | null;

const MIN_K = 0.04;
const MAX_K = 2.5;

export function SqlDiagram({ path }: { path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [schema, setSchema] = useState<SqlSchema | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const platform = getPlatform();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const src = getDocument(path)?.getValue() ?? (await platform.fs.readFile(path).catch(() => ""));
      if (alive) setText(src);
    };
    void load();
    // Typing in the editor re-reads the schema, once the typing pauses.
    const off = onDocumentChanged((p) => {
      if (p !== path) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  }, [path, platform]);

  useEffect(() => {
    if (text === null) return;
    const signal = { aborted: false };
    // The bar shows only when the parse takes a while.
    const shown = setTimeout(() => !signal.aborted && setProgress((p) => p ?? 0), 150);
    void parseSqlSchemaAsync(text, (f) => setProgress(f), signal).then((s) => {
      if (signal.aborted) return;
      clearTimeout(shown);
      setSchema(s);
      setProgress(null);
    });
    return () => {
      signal.aborted = true;
      clearTimeout(shown);
    };
  }, [text]);

  if (!schema)
    return (
      <div className="tm-sqld" data-testid="sql-diagram" data-state="loading">
        <div className="tm-sqld-empty">
          <Codicon name="loading" className="codicon-modifier-spin" />
          <span>Reading the schema…</span>
          {progress !== null && (
            <div className="tm-sqld-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </div>
      </div>
    );
  if (!schema.tables.length) return <EmptySchema path={path} schema={schema} />;
  return <Diagram key={path} path={path} schema={schema} updating={progress !== null} />;
}

function EmptySchema({ path, schema }: { path: string; schema: SqlSchema }) {
  return (
    <div className="tm-sqld" data-testid="sql-diagram" data-state="empty">
      <div className="tm-sqld-empty">
        <Codicon name="database" />
        <strong>No tables to draw</strong>
        <span>
          {basename(path)} has no CREATE TABLE statements{schema.statements ? ` (${schema.statements} other statement${schema.statements === 1 ? "" : "s"})` : ""}. The diagram shows the tables, views and foreign keys a schema or a database dump creates.
        </span>
        {schema.issues.length > 0 && <IssueList path={path} schema={schema} />}
        <button type="button" className="tm-button tm-button--secondary" onClick={() => setViewMode(path, "edit")}>
          Edit the SQL
        </button>
      </div>
    </div>
  );
}

function IssueList({ path, schema }: { path: string; schema: SqlSchema }) {
  return (
    <ul className="tm-sqld-issues" data-testid="sql-diagram-issues">
      {schema.issues.slice(0, 200).map((i, k) => (
        <li key={k}>
          <button type="button" className="tm-sqld-link" onClick={() => showLine(path, i.line)} title="Show in the SQL">
            Line {i.line}
          </button>
          <span>{i.message}</span>
        </li>
      ))}
      {schema.issues.length > 200 && <li className="tm-muted">and {schema.issues.length - 200} more</li>}
    </ul>
  );
}

function showLine(path: string, line: number) {
  setViewMode(path, "edit");
  revealInEditor(path, line);
}

function Diagram({ path, schema, updating }: { path: string; schema: SqlSchema; updating: boolean }) {
  const saved = useMemo(() => loadSaved(path), [path]);
  const [keysOnly, setKeysOnly] = useState(saved.keysOnly ?? schema.tables.length > 80);
  const [moved, setMoved] = useState<Positions>(() => saved.pos ?? {});
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  // Unknown until measured (the first fit waits for it).
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Sel>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [panel, setPanel] = useState(false);
  const [query, setQuery] = useState("");
  const [matchAt, setMatchAt] = useState(0);
  const [exporting, setExporting] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fitted = useRef(false);

  const rels = useMemo(() => relationships(schema), [schema]);
  const cards = useMemo(() => new Map(schema.tables.map((t) => [t.id, buildCard(t, keysOnly)])), [schema, keysOnly]);
  const views = useMemo(() => schema.tables.flatMap((t) => (t.sources ?? []).filter((s) => cards.has(s)).map((s) => ({ from: t.id, to: s }))), [schema, cards]);
  const auto = useMemo(() => layoutDiagram([...cards.values()].map((c) => ({ id: c.t.id, w: c.w, h: c.h })), [...rels, ...views]), [cards, rels, views]);
  const pos = useMemo(() => {
    const out: Positions = { ...auto };
    for (const [id, p] of Object.entries(moved)) if (out[id]) out[id] = p;
    return out;
  }, [auto, moved]);
  const box = useMemo(() => bounds(cards, pos), [cards, pos]);

  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
    for (const r of rels) {
      add(r.from, r.to);
      add(r.to, r.from);
    }
    for (const v of views) {
      add(v.from, v.to);
      add(v.to, v.from);
    }
    return m;
  }, [rels, views]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? schema.tables.filter((t) => t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q))).map((t) => t.id) : []),
    [q, schema],
  );

  // ── view ──

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fitTo = useCallback(
    (b: Box) => {
      const k = Math.max(MIN_K, Math.min(1, (size.w - 48) / Math.max(1, b.w), (size.h - 48) / Math.max(1, b.h)));
      setView({ k, x: size.w / 2 - (b.x + b.w / 2) * k, y: size.h / 2 - (b.y + b.h / 2) * k });
    },
    [size],
  );

  useLayoutEffect(() => {
    if (fitted.current || size.w < 50) return;
    fitted.current = true;
    fitTo(box);
  }, [box, size, fitTo]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  }, []);

  const centreOn = useCallback(
    (id: string) => {
      const c = cards.get(id);
      const p = pos[id];
      if (!c || !p) return;
      setView((v) => {
        const k = Math.max(v.k, 0.6);
        return { k, x: size.w / 2 - (p.x + c.w / 2) * k, y: size.h / 2 - (p.y + c.h / 2) * k };
      });
    },
    [cards, pos, size],
  );

  // Wheel: scroll pans, pinch / ⌘ / Ctrl + wheel zooms at the pointer.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025) * (e.ctrlKey && !e.metaKey ? 4 : 1)), e.clientX - r.left, e.clientY - r.top);
      else {
        const m = e.deltaMode === 1 ? 16 : 1;
        setView((v) => ({ ...v, x: v.x - e.deltaX * m, y: v.y - e.deltaY * m }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ── pointer: pan the background, drag a table, pinch with two fingers ──

  const drag = useRef<{ id: string | null; rel: string | null; sx: number; sy: number; ox: number; oy: number; moved: boolean; pointer: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; k: number } | null>(null);
  const movedRef = useRef(moved);
  movedRef.current = moved;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const target = e.target as Element;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
      drag.current = null;
      return;
    }
    const tableEl = target.closest("[data-table]");
    const id = tableEl?.getAttribute("data-table") ?? null;
    const p = id ? pos[id] : null;
    const rel = id ? null : (target.closest("[data-rel]")?.getAttribute("data-rel") ?? null);
    drag.current = { id, rel, sx: e.clientX, sy: e.clientY, ox: p ? p.x : view.x, oy: p ? p.y : view.y, moved: false, pointer: e.pointerId };
    host.current?.focus({ preventScroll: true });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const r = host.current!.getBoundingClientRect();
      const k = Math.max(MIN_K, Math.min(MAX_K, (pinch.current.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.d));
      zoomAt(k / view.k, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      return;
    }
    const d = drag.current;
    if (!d) {
      // Hover: which table or line is under the pointer.
      const t = e.target as Element;
      const tid = t.closest?.("[data-table]")?.getAttribute("data-table");
      const rid = tid ? null : t.closest?.("[data-rel]")?.getAttribute("data-rel");
      const next: Sel = tid ? { kind: "table", id: tid } : rid ? { kind: "rel", id: rid } : null;
      if (next?.id !== hover?.id) setHover(next);
      return;
    }
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    if (d.id) setMoved((m) => ({ ...m, [d.id!]: { x: Math.round(d.ox + dx / view.k), y: Math.round(d.oy + dy / view.k) } }));
    else setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    drag.current = null;
    if (!d || d.pointer !== e.pointerId) return;
    if (d.moved) {
      if (d.id) saveSaved(path, { pos: movedRef.current, keysOnly });
      return;
    }
    // A click: select the table or line under the pointer, or clear.
    if (d.id) select({ kind: "table", id: d.id });
    else if (d.rel) select({ kind: "rel", id: d.rel });
    else setSel(null);
  };

  const select = (s: Sel) => {
    setSel(s);
    if (s) setPanel(true);
  };

  const resetLayout = () => {
    setMoved({});
    saveSaved(path, { keysOnly: keysOnly === (schema.tables.length > 80) ? undefined : keysOnly });
    fitted.current = false;
    requestAnimationFrame(() => fitTo(bounds(cards, auto)));
  };

  const toggleKeys = () => {
    const next = !keysOnly;
    setKeysOnly(next);
    saveSaved(path, { pos: Object.keys(moved).length ? moved : undefined, keysOnly: next });
  };

  // ── highlight ──

  const focus = hover ?? sel;
  const focusRel = focus?.kind === "rel" ? rels.find((r) => r.id === focus.id) : undefined;
  const focusTable = focus?.kind === "table" ? focus.id : null;
  const lit = useMemo(() => {
    if (focusTable) return new Set([focusTable, ...(neighbours.get(focusTable) ?? [])]);
    if (focusRel) return new Set([focusRel.from, focusRel.to]);
    return null;
  }, [focusTable, focusRel, neighbours]);
  const matchSet = useMemo(() => new Set(matches), [matches]);

  const modeOf = (id: string): Mode => {
    if (sel?.kind === "table" && sel.id === id) return "selected";
    // While searching, the matches stand out (not the neighbours of what's selected).
    if (q) return matchSet.has(id) ? "match" : "dim";
    if (lit) return lit.has(id) ? (id === focusTable ? "selected" : "hl") : "dim";
    return "";
  };
  const relMode = (id: string): "" | "hl" | "dim" => {
    if (q) {
      const r = rels.find((x) => x.id === id)!;
      return matchSet.has(r.from) || matchSet.has(r.to) ? "" : "dim";
    }
    if (focusRel) return id === focusRel.id ? "hl" : "dim";
    if (focusTable) {
      const r = rels.find((x) => x.id === id)!;
      return r.from === focusTable || r.to === focusTable ? "hl" : "dim";
    }
    return "";
  };
  const hlColsOf = (id: string): string => {
    if (!focusRel) return "";
    if (id === focusRel.from && id === focusRel.to) return [...focusRel.fk.columns, ...focusRel.fk.refColumns].join("\n").toLowerCase();
    if (id === focusRel.from) return focusRel.fk.columns.join("\n").toLowerCase();
    if (id === focusRel.to) return focusRel.fk.refColumns.join("\n").toLowerCase();
    return "";
  };

  const nextMatch = (dir = 1) => {
    if (!matches.length) return;
    const i = (((matchAt + (dir > 0 ? 0 : -2)) % matches.length) + matches.length) % matches.length;
    setMatchAt(i + 1);
    select({ kind: "table", id: matches[i] });
    centreOn(matches[i]);
  };

  // ── export ──

  const exportAs = async (kind: "png" | "pdf" | "svg") => {
    if (exporting) return;
    setExporting(true);
    try {
      const { svg, w, h, bg } = renderExportSvg(host.current!, cards, pos, rels, views);
      const name = `${basename(path).replace(/\.sql$/i, "")}-diagram.${kind}`;
      let bytes: Uint8Array;
      if (kind === "svg") bytes = new TextEncoder().encode(svg);
      else {
        const scale = exportScale(w, h);
        const canvas = await svgToCanvas(svg, w, h, scale, bg);
        bytes = kind === "png" ? await canvasBytes(canvas, "image/png") : pdfWithJpeg(await canvasBytes(canvas, "image/jpeg", 0.93), canvas.width, canvas.height, w * 0.75, h * 0.75, `${basename(path)} schema`);
      }
      const where = await saveExport(name, bytes);
      if (where && where !== "download") notify("info", `Diagram exported to ${where}`);
    } catch (e) {
      notify("error", `The diagram couldn't be exported: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setExporting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "+" || e.key === "=") zoomAt(1.2, size.w / 2, size.h / 2);
    else if (e.key === "-") zoomAt(1 / 1.2, size.w / 2, size.h / 2);
    else if (e.key === "0") fitTo(box);
    else if (e.key === "Escape") setSel(null);
    else return;
    e.preventDefault();
  };

  const low = view.k < 0.38;
  // About 12 px on screen, in steps so cards don't redraw on every zoom tick.
  const label = Math.round(Math.min(120, 12 / view.k) / 4) * 4;
  const selTable = sel?.kind === "table" ? schema.tables.find((t) => t.id === sel.id) : undefined;
  const selRel = sel?.kind === "rel" ? rels.find((r) => r.id === sel.id) : undefined;
  const tablesN = schema.tables.filter((t) => t.kind === "table").length;
  const viewsN = schema.tables.length - tablesN;

  return (
    <div className="tm-sqld" data-testid="sql-diagram" data-state="ready">
      <div className="tm-preview-toolbar tm-sqld-toolbar">
        <div className="tm-sqld-search">
          <Codicon name="search" />
          <input
            className="tm-input"
            placeholder="Find a table or column"
            aria-label="Find a table or column"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatchAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") nextMatch(e.shiftKey ? -1 : 1);
              else if (e.key === "Escape") setQuery("");
            }}
          />
          {q && <span className="tm-sqld-matches">{!matches.length ? "none" : matchAt ? `${matchAt} of ${matches.length}` : `${matches.length} found`}</span>}
        </div>
        <span className="tm-muted tm-sqld-stats" data-testid="sql-diagram-stats">
          {tablesN} table{tablesN === 1 ? "" : "s"}
          {viewsN ? ` · ${viewsN} view${viewsN === 1 ? "" : "s"}` : ""} · {rels.length} relationship{rels.length === 1 ? "" : "s"}
        </span>
        {updating && <Codicon name="loading" className="codicon-modifier-spin" />}
        <span className="tm-sqld-spacer" />
        {schema.issues.length > 0 && (
          <button
            type="button"
            className="tm-sqld-chip is-warning"
            onClick={() => {
              setSel(null);
              setPanel(true);
            }}
            title="Statements the diagram skipped"
            data-testid="sql-diagram-issues-button"
          >
            <Codicon name="warning" /> {schema.issues.length} skipped
          </button>
        )}
        <ActionButton icon={keysOnly ? "list-tree" : "list-flat"} label={keysOnly ? "Show All Columns" : "Show Keys Only"} active={keysOnly} onClick={toggleKeys} data-testid="sql-diagram-keys" />
        <ActionButton icon="discard" label="Reset Layout" onClick={resetLayout} disabled={!Object.keys(moved).length} data-testid="sql-diagram-reset" />
        <span className="tm-sqld-sep" />
        <ActionButton icon="zoom-out" label="Zoom Out (-)" onClick={() => zoomAt(1 / 1.2, size.w / 2, size.h / 2)} />
        <button type="button" className="tm-sqld-zoom" title="Actual Size" onClick={() => zoomAt(1 / view.k, size.w / 2, size.h / 2)}>
          {Math.round(view.k * 100)}%
        </button>
        <ActionButton icon="zoom-in" label="Zoom In (+)" onClick={() => zoomAt(1.2, size.w / 2, size.h / 2)} />
        <ActionButton icon="screen-full" label="Fit to Screen (0)" onClick={() => fitTo(box)} data-testid="sql-diagram-fit" />
        <span className="tm-sqld-sep" />
        <button type="button" className="tm-sqld-chip" onClick={() => void exportAs("png")} disabled={exporting} data-testid="sql-diagram-export-png" title="Export the whole diagram as a PNG image">
          <Codicon name="file-media" /> PNG
        </button>
        <button type="button" className="tm-sqld-chip" onClick={() => void exportAs("pdf")} disabled={exporting} data-testid="sql-diagram-export-pdf" title="Export the whole diagram as a PDF">
          <Codicon name="file-pdf" /> PDF
        </button>
        <button type="button" className="tm-sqld-chip" onClick={() => void exportAs("svg")} disabled={exporting} data-testid="sql-diagram-export-svg" title="Export the whole diagram as an SVG drawing">
          <Codicon name="file-code" /> SVG
        </button>
        <ActionButton icon="layout-sidebar-right" label="Details" active={panel} onClick={() => setPanel((p) => !p)} data-testid="sql-diagram-panel-toggle" />
      </div>
      <div className="tm-sqld-body">
        <div
          ref={host}
          className="tm-sqld-canvas"
          tabIndex={0}
          role="application"
          aria-label="Schema diagram"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => !drag.current && setHover(null)}
          onKeyDown={onKeyDown}
        >
          <svg ref={svgRef} className="tm-sqld-svg" width="100%" height="100%">
            <style>{DIAGRAM_CSS}</style>
            <defs>
              <pattern id="sd-grid" width={24} height={24} patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                <circle cx={1} cy={1} r={1} className="tm-sqld-dot" />
              </pattern>
            </defs>
            {view.k > 0.2 && <rect width="100%" height="100%" fill="url(#sd-grid)" />}
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              <Drawing cards={cards} pos={pos} rels={rels} views={views} low={low} label={label} modeOf={modeOf} relMode={relMode} hlColsOf={hlColsOf} />
            </g>
          </svg>
          <Minimap cards={cards} pos={pos} box={box} view={view} size={size} onMove={(x, y) => setView((v) => ({ ...v, x: size.w / 2 - x * v.k, y: size.h / 2 - y * v.k }))} />
        </div>
        {panel && (
          <aside className="tm-sqld-panel tm-scroll" data-testid="sql-diagram-panel">
            <div className="tm-sqld-panel-head">
              <span>{selTable ? (selTable.kind === "view" ? "View" : "Table") : selRel ? "Relationship" : "Schema"}</span>
              <ActionButton icon="close" label="Close Details" onClick={() => setPanel(false)} />
            </div>
            {selTable ? (
              <TableDetails path={path} t={selTable} rels={rels} schema={schema} onSelect={(id) => (select({ kind: "table", id }), centreOn(id))} />
            ) : selRel ? (
              <RelDetails r={selRel} schema={schema} onSelect={(id) => (select({ kind: "table", id }), centreOn(id))} />
            ) : (
              <Overview path={path} schema={schema} rels={rels} />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── minimap ─────────────────────────

const Minimap = memo(function Minimap({ cards, pos, box, view, size, onMove }: { cards: Map<string, Card>; pos: Positions; box: Box; view: { x: number; y: number; k: number }; size: { w: number; h: number }; onMove: (x: number, y: number) => void }) {
  const W = 180;
  const H = 120;
  const pad = 40;
  const s = Math.min(W / (box.w + pad * 2), H / (box.h + pad * 2));
  const ox = (W - (box.w + pad * 2) * s) / 2 - (box.x - pad) * s;
  const oy = (H - (box.h + pad * 2) * s) / 2 - (box.y - pad) * s;
  const vx = (-view.x / view.k) * s + ox;
  const vy = (-view.y / view.k) * s + oy;
  const go = (e: React.PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    onMove((e.clientX - r.left - ox) / s, (e.clientY - r.top - oy) / s);
  };
  // Everything fits on screen: no minimap needed.
  if (box.w * view.k <= size.w && box.h * view.k <= size.h && view.x + box.x * view.k >= 0 && view.y + box.y * view.k >= 0) return null;
  return (
    <svg
      className="tm-sqld-minimap"
      width={W}
      height={H}
      data-testid="sql-diagram-minimap"
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        go(e);
      }}
      onPointerMove={(e) => {
        e.stopPropagation();
        if (e.buttons) go(e);
      }}
      onPointerUp={(e) => e.stopPropagation()}
    >
      {[...cards.values()].map((c) => {
        const p = pos[c.t.id];
        return p ? <rect key={c.t.id} className={c.t.kind === "view" ? "is-view" : undefined} x={p.x * s + ox} y={p.y * s + oy} width={Math.max(1, c.w * s)} height={Math.max(1, c.h * s)} rx={1} /> : null;
      })}
      <rect className="tm-sqld-minimap-view" x={vx} y={vy} width={(size.w / view.k) * s} height={(size.h / view.k) * s} />
    </svg>
  );
});

// ───────────────────────── details ─────────────────────────

function TableLink({ id, schema, onSelect }: { id: string; schema: SqlSchema; onSelect: (id: string) => void }) {
  const t = schema.tables.find((x) => x.id === id);
  return (
    <button type="button" className="tm-sqld-link" onClick={() => onSelect(id)}>
      {t?.name ?? id}
    </button>
  );
}

function Rules({ onDelete, onUpdate }: { onDelete?: string; onUpdate?: string }) {
  if (!onDelete && !onUpdate) return <span className="tm-muted">no ON DELETE / ON UPDATE rule</span>;
  return (
    <>
      {onDelete && <span className="tm-sqld-rule">ON DELETE {onDelete}</span>}
      {onUpdate && <span className="tm-sqld-rule">ON UPDATE {onUpdate}</span>}
    </>
  );
}

function TableDetails({ path, t, rels, schema, onSelect }: { path: string; t: SqlTable; rels: Relationship[]; schema: SqlSchema; onSelect: (id: string) => void }) {
  const incoming = rels.filter((r) => r.to === t.id && r.from !== t.id);
  const outgoing = rels.filter((r) => r.from === t.id);
  const unresolved = t.foreignKeys.filter((f) => !f.target);
  const usedBy = schema.tables.filter((v) => v.sources?.includes(t.id));
  return (
    <div className="tm-sqld-details" data-testid="sql-diagram-details" data-table={t.id}>
      <h3>
        {t.schema && <span className="tm-muted">{t.schema}.</span>}
        {t.name}
      </h3>
      {t.comment && <p className="tm-sqld-comment">{t.comment}</p>}
      <div className="tm-sqld-meta">
        <button type="button" className="tm-sqld-link" onClick={() => showLine(path, t.line)}>
          Line {t.line}
        </button>
        {t.options && <span className="tm-muted">{t.options}</span>}
      </div>
      <h4>Columns ({t.columns.length})</h4>
      <table className="tm-sqld-cols">
        <tbody>
          {t.columns.map((c) => {
            const f = columnFlags(t, c);
            return (
              <tr key={c.name}>
                <td className="tm-sqld-col-icon">{f.pk ? <Codicon name="key" className="is-pk" /> : f.fk ? <Codicon name="arrow-right" className="is-fk" /> : null}</td>
                <td>
                  <div className="tm-sqld-col-name">{c.name}</div>
                  <div className="tm-sqld-col-extra">
                    {[
                      c.nullable ? "NULL" : "NOT NULL",
                      f.unique && !f.pk ? "UNIQUE" : "",
                      c.autoIncrement ? "AUTO_INCREMENT" : "",
                      c.default !== undefined ? `DEFAULT ${c.default}` : "",
                      c.generated ? `AS (${c.generated})` : "",
                      c.onUpdate ? `ON UPDATE ${c.onUpdate}` : "",
                      c.check ? `CHECK (${c.check})` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {c.enumValues && <div className="tm-sqld-col-extra">{c.enumValues.join(" | ")}</div>}
                  {c.comment && <div className="tm-sqld-col-comment">{c.comment}</div>}
                </td>
                <td className="tm-sqld-col-type" title={c.type}>
                  {c.type}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {t.indexes.length > 0 && (
        <>
          <h4>Keys and indexes ({t.indexes.length})</h4>
          <ul className="tm-sqld-list">
            {t.indexes.map((ix, i) => (
              <li key={i}>
                <span className={`tm-sqld-tag is-${ix.kind}`}>{ix.kind === "primary" ? "PRIMARY" : ix.kind.toUpperCase()}</span> {ix.name && <span className="tm-muted">{ix.name}</span>} ({ix.columns.join(", ")})
              </li>
            ))}
          </ul>
        </>
      )}
      {(outgoing.length > 0 || unresolved.length > 0) && (
        <>
          <h4>References ({outgoing.length + unresolved.length})</h4>
          <ul className="tm-sqld-list">
            {outgoing.map((r) => (
              <li key={r.id}>
                <code>{r.fk.columns.join(", ")}</code> → <TableLink id={r.to} schema={schema} onSelect={onSelect} />
                <code>({r.fk.refColumns.join(", ")})</code>
                <div>
                  {r.fk.name && <span className="tm-muted">{r.fk.name} </span>}
                  <Rules onDelete={r.fk.onDelete} onUpdate={r.fk.onUpdate} />
                </div>
              </li>
            ))}
            {unresolved.map((f, i) => (
              <li key={`u${i}`} className="tm-muted">
                <code>{f.columns.join(", ")}</code> → {f.refTable} ({f.refColumns.join(", ")}): not in this file
              </li>
            ))}
          </ul>
        </>
      )}
      {incoming.length > 0 && (
        <>
          <h4>Referenced by ({incoming.length})</h4>
          <ul className="tm-sqld-list">
            {incoming.map((r) => (
              <li key={r.id}>
                <TableLink id={r.from} schema={schema} onSelect={onSelect} />
                <code>({r.fk.columns.join(", ")})</code> → <code>{r.fk.refColumns.join(", ")}</code>
                <div>
                  <Rules onDelete={r.fk.onDelete} onUpdate={r.fk.onUpdate} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {t.checks.length > 0 && (
        <>
          <h4>Checks</h4>
          <ul className="tm-sqld-list">
            {t.checks.map((c, i) => (
              <li key={i}>
                {c.name && <span className="tm-muted">{c.name} </span>}
                <code>{c.expr}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {t.kind === "view" && (
        <>
          {!!t.sources?.length && (
            <>
              <h4>Reads from</h4>
              <ul className="tm-sqld-list">
                {t.sources.map((s) => (
                  <li key={s}>
                    <TableLink id={s} schema={schema} onSelect={onSelect} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {t.definition && <pre className="tm-sqld-sql">{t.definition}</pre>}
        </>
      )}
      {usedBy.length > 0 && (
        <>
          <h4>Used by views</h4>
          <ul className="tm-sqld-list">
            {usedBy.map((v) => (
              <li key={v.id}>
                <TableLink id={v.id} schema={schema} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function RelDetails({ r, schema, onSelect }: { r: Relationship; schema: SqlSchema; onSelect: (id: string) => void }) {
  const from = schema.tables.find((t) => t.id === r.from)!;
  const to = schema.tables.find((t) => t.id === r.to)!;
  return (
    <div className="tm-sqld-details" data-testid="sql-diagram-details" data-rel={r.id}>
      <h3>{r.fk.name ?? `${from.name} → ${to.name}`}</h3>
      <ul className="tm-sqld-list">
        <li>
          <TableLink id={r.from} schema={schema} onSelect={onSelect} /> <code>({r.fk.columns.join(", ")})</code>
        </li>
        <li>
          → <TableLink id={r.to} schema={schema} onSelect={onSelect} /> <code>({r.fk.refColumns.join(", ")})</code>
        </li>
      </ul>
      <h4>Cardinality</h4>
      <p>
        Each {from.name} row belongs to {r.mandatory ? "exactly one" : "zero or one"} {to.name}; each {to.name} has {r.oneToOne ? "zero or one" : "zero or more"} {from.name} row{r.oneToOne ? "" : "s"}.
      </p>
      <h4>Rules</h4>
      <p>
        <Rules onDelete={r.fk.onDelete} onUpdate={r.fk.onUpdate} />
      </p>
    </div>
  );
}

function Overview({ path, schema, rels }: { path: string; schema: SqlSchema; rels: Relationship[] }) {
  const dialect = { mysql: "MySQL / MariaDB", postgres: "PostgreSQL", sqlite: "SQLite", generic: "SQL" }[schema.dialect];
  return (
    <div className="tm-sqld-details" data-testid="sql-diagram-overview">
      <h3>{basename(path)}</h3>
      <p className="tm-muted">
        {dialect} · {schema.tables.length} tables and views · {rels.length} relationships · {schema.statements} statements ({schema.skipped} data or other statements stepped over)
      </p>
      <p className="tm-muted">Click a table or a line for its details. Drag tables to arrange them; scroll to pan; pinch or ⌘/Ctrl + scroll to zoom.</p>
      <h4>Legend</h4>
      <ul className="tm-sqld-legend">
        <li>
          <Codicon name="key" className="is-pk" /> primary key
        </li>
        <li>
          <Codicon name="arrow-right" className="is-fk" /> foreign key
        </li>
        <li>
          <span className="tm-sqld-dia" /> NOT NULL · <span className="tm-sqld-dia is-null" /> nullable
        </li>
        <li>
          <span className="tm-sqld-tag">UQ</span> unique · <span className="tm-sqld-tag">IX</span> indexed · <span className="tm-sqld-tag">AI</span> auto-increment · <span className="tm-sqld-tag">DF</span> default ·{" "}
          <span className="tm-sqld-tag">GC</span> generated
        </li>
        <li>Crow's foot: many · bar: one · ring: optional · dashed line: nullable foreign key · dotted line: a view reads a table</li>
      </ul>
      {schema.issues.length > 0 && (
        <>
          <h4>Skipped ({schema.issues.length})</h4>
          <IssueList path={path} schema={schema} />
        </>
      )}
    </div>
  );
}

// ───────────────────────── export ─────────────────────────

/** The whole diagram as a standalone SVG: full detail, no highlight, the current theme's colours written in. */
function renderExportSvg(themeEl: HTMLElement, cards: Map<string, Card>, pos: Positions, rels: Relationship[], views: { from: string; to: string }[]) {
  const b = bounds(cards, pos);
  const pad = 32;
  const w = Math.ceil(b.w + pad * 2);
  const h = Math.ceil(b.h + pad * 2);
  const cs = getComputedStyle(themeEl);
  const vars: Record<string, string> = {};
  for (const v of SD_VARS) vars[v] = cs.getPropertyValue(v).trim();
  const bg = vars["--sd-bg"] || "#ffffff";
  const div = document.createElement("div");
  const root = createRoot(div);
  flushSync(() =>
    root.render(
      <svg xmlns="http://www.w3.org/2000/svg" width={w} height={h} viewBox={`${b.x - pad} ${b.y - pad} ${w} ${h}`} style={vars as React.CSSProperties}>
        <style>{DIAGRAM_CSS}</style>
        <rect x={b.x - pad} y={b.y - pad} width={w} height={h} fill={bg} />
        <Drawing cards={cards} pos={pos} rels={rels} views={views} />
      </svg>,
    ),
  );
  // HTML serialisation writes &nbsp;, which XML (an SVG image) doesn't know.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n${div.innerHTML.replace(/&nbsp;/g, "&#160;")}`;
  root.unmount();
  return { svg, w, h, bg };
}
