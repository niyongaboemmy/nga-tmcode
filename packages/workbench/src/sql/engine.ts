import type { Database, SqlJsStatic } from "sql.js";
import { splitSql } from "./split";

/**
 * TMCode's built-in SQL: SQLite compiled to WebAssembly (sql.js), so .sql
 * files run anywhere (no server, also offline). Each statement runs on its
 * own, so every result shows and an error points at its line.
 */

export interface StatementResult {
  text: string;
  line: number;
  kind: "rows" | "change" | "ok" | "error";
  columns: string[];
  rows: unknown[][];
  /** Rows changed by INSERT / UPDATE / DELETE. */
  changes: number;
  ms: number;
  error?: string;
  /** Only the first MAX_ROWS rows are kept. */
  truncated?: boolean;
}

export interface TableInfo {
  name: string;
  type: "table" | "view";
  columns: { name: string; type: string; pk: boolean; notnull: boolean }[];
  rows: number | null;
}

export const MAX_ROWS = 1000;

let sqlPromise: Promise<SqlJsStatic> | null = null;
let wasmOverride: string | null = null;
/** Tests (Node) read the wasm from disk instead of the app's URL. */
export function setSqlWasmPath(path: string) {
  wasmOverride = path;
}
async function sqlJs(): Promise<SqlJsStatic> {
  sqlPromise ??= (async () => {
    const { default: init } = await import("sql.js");
    const wasmUrl = wasmOverride ?? (await import("sql.js/dist/sql-wasm.wasm?url")).default;
    return init({ locateFile: () => wasmUrl });
  })();
  return sqlPromise;
}

/** One database per workspace kept between runs ("Keep data between runs"). */
const kept = new Map<string, Database>();

export async function freshDatabase(): Promise<Database> {
  const SQL = await sqlJs();
  const db = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

export async function keptDatabase(key: string): Promise<Database> {
  let db = kept.get(key);
  if (!db) {
    db = await freshDatabase();
    kept.set(key, db);
  }
  return db;
}

export function resetKept(key: string) {
  kept.get(key)?.close();
  kept.delete(key);
}

/** Runs a script statement by statement; stops at the first error (as the sqlite3 shell does with -bail). */
export function runScript(db: Database, script: string, opts: { lineOffset?: number; continueOnError?: boolean } = {}): StatementResult[] {
  const out: StatementResult[] = [];
  for (const s of splitSql(script)) {
    const t0 = performance.now();
    const base = { text: s.text, line: s.line + (opts.lineOffset ?? 0), columns: [] as string[], rows: [] as unknown[][], changes: 0 };
    try {
      const res = db.exec(s.text);
      const ms = performance.now() - t0;
      const last = res[res.length - 1];
      if (last) {
        out.push({ ...base, kind: "rows", columns: last.columns, rows: last.values.slice(0, MAX_ROWS), truncated: last.values.length > MAX_ROWS, ms });
      } else {
        const changes = /^\s*(INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(s.text) ? db.getRowsModified() : 0;
        out.push({ ...base, kind: changes || /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s.text) ? "change" : "ok", changes, ms });
      }
    } catch (e) {
      out.push({ ...base, kind: "error", error: String((e as Error)?.message ?? e).replace(/^Error:\s*/, ""), ms: performance.now() - t0 });
      if (!opts.continueOnError) break;
    }
  }
  return out;
}

/** Tables and views, with columns and row counts (the Schema list). */
export function schemaOf(db: Database): TableInfo[] {
  const res = db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const rows = res[0]?.values ?? [];
  return rows.map(([name, type]) => {
    const n = String(name);
    const q = n.replace(/"/g, '""');
    const cols = db.exec(`PRAGMA table_info("${q}")`)[0]?.values ?? [];
    let count: number | null = null;
    try {
      count = Number(db.exec(`SELECT COUNT(*) FROM "${q}"`)[0]?.values[0]?.[0] ?? 0);
    } catch {
      count = null;
    }
    return {
      name: n,
      type: type === "view" ? "view" : "table",
      columns: cols.map((c) => ({ name: String(c[1]), type: String(c[2] ?? ""), notnull: !!c[3], pk: !!c[5] })),
      rows: count,
    };
  });
}

/** How SQLite will run a query (EXPLAIN QUERY PLAN), as indented lines. */
export function queryPlan(db: Database, sql: string): string[] {
  const res = db.exec(`EXPLAIN QUERY PLAN ${sql}`)[0];
  if (!res) return [];
  const idCol = res.columns.indexOf("id");
  const parentCol = res.columns.indexOf("parent");
  const detailCol = res.columns.indexOf("detail");
  const depth = new Map<number, number>([[0, -1]]);
  return res.values.map((r) => {
    const d = (depth.get(Number(r[parentCol])) ?? -1) + 1;
    depth.set(Number(r[idCol]), d);
    return `${"  ".repeat(d)}${String(r[detailCol])}`;
  });
}

/** For tests and the Export button: the database file. */
export function exportDatabase(db: Database): Uint8Array {
  return db.export();
}
