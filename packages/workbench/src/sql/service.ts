import { create } from "zustand";
import { getDocument } from "../monaco/documents";
import { codeEditorFor } from "../monaco/editors";
import { monaco } from "../monaco/setup";
import { activeFilePath, getPlatform, notify, openEditorInput, useWorkbench } from "../state/store";
import { freshDatabase, keptDatabase, queryPlan, resetKept, runScript, schemaOf, type StatementResult, type TableInfo } from "./engine";
import { statementAt } from "./split";

/**
 * Running .sql files in TMCode: the whole file or the statement at the cursor,
 * results beside the code (sql/SqlResultsEditor), errors as Problems at their
 * line. "Fresh" mode starts every run from an empty database (schema.sql and
 * seed.sql beside the file run first); "keep" mode keeps the data between runs.
 */

export type SqlMode = "fresh" | "keep";

export interface SqlRun {
  path: string;
  at: number;
  results: StatementResult[];
  /** Files run first in fresh mode. */
  prepared: string[];
  prepareError: string | null;
  schema: TableInfo[];
  mode: SqlMode;
  /** "statement": only the statement at the cursor. */
  scope: "file" | "statement";
}

interface SqlState {
  runs: Record<string, SqlRun>;
  running: string | null;
  mode: SqlMode;
}

export const useSql = create<SqlState>(() => ({ runs: {}, running: null, mode: "fresh" }));

const MARKER_OWNER = "tmcode-sql";
const PREPARE = ["schema.sql", "seed.sql", "data.sql"];

const keyOfWorkspace = () => useWorkbench.getState().workspace?.root ?? "memory";
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.split("/").pop() ?? p;
const join = (d: string, n: string) => (d ? `${d}/${n}` : n);

async function read(path: string): Promise<string | null> {
  const doc = getDocument(path);
  if (doc) return doc.getValue();
  return getPlatform().fs.readFile(path).catch(() => null);
}

export async function setSqlMode(mode: SqlMode) {
  useSql.setState({ mode });
  await getPlatform().store.set("sql.mode", mode).catch(() => {});
}

export function resetDatabase() {
  resetKept(keyOfWorkspace());
  notify("info", "The SQL database was emptied.");
}

function mark(path: string, results: StatementResult[], lineOffset = 0) {
  const model = getDocument(path);
  if (!model) return;
  const errors = results.filter((r) => r.kind === "error");
  monaco.editor.setModelMarkers(
    model,
    MARKER_OWNER,
    errors.map((r) => {
      const line = Math.min(model.getLineCount(), r.line + lineOffset);
      return { severity: monaco.MarkerSeverity.Error, message: r.error ?? "SQL error", startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line), source: "SQLite" };
    }),
  );
}

/** Runs a .sql file (or the statement at the cursor) and shows the results beside it. */
export async function runSql(path: string, opts: { scope?: "file" | "statement" } = {}) {
  const text = await read(path);
  if (text === null) return notify("error", `${path} could not be read.`);
  let script = text;
  let lineOffset = 0;
  const scope = opts.scope ?? "file";
  if (scope === "statement") {
    const ed = codeEditorFor(useWorkbench.getState().activeGroup);
    const model = ed?.getModel();
    const pos = ed?.getPosition();
    const sel = ed?.getSelection();
    if (model && sel && !sel.isEmpty()) {
      script = model.getValueInRange(sel);
      lineOffset = sel.startLineNumber - 1;
    } else if (model && pos) {
      const st = statementAt(text, model.getOffsetAt(pos));
      if (!st) return;
      script = st.text;
      lineOffset = st.line - 1;
    }
  }
  const mode = useSql.getState().mode;
  useSql.setState({ running: path });
  try {
    const db = mode === "keep" || scope === "statement" ? await keptDatabase(keyOfWorkspace()) : await freshDatabase();
    // Fresh runs of a query file first build the tables from schema.sql / seed.sql beside it.
    const prepared: string[] = [];
    let prepareError: string | null = null;
    if (mode === "fresh" && scope === "file" && !/\bCREATE\s+TABLE\b/i.test(text)) {
      for (const name of PREPARE) {
        const p = join(dirOf(path), name);
        if (p === path) continue;
        const src = await read(p);
        if (src === null) continue;
        const res = runScript(db, src);
        prepared.push(name);
        const err = res.find((r) => r.kind === "error");
        if (err) {
          prepareError = `${name}, line ${err.line}: ${err.error}`;
          break;
        }
      }
    }
    const results = prepareError ? [] : runScript(db, script).map((r) => ({ ...r, line: r.line + lineOffset }));
    mark(path, results);
    const run: SqlRun = { path, at: Date.now(), results, prepared, prepareError, schema: schemaOf(db), mode, scope };
    if (mode === "fresh" && scope === "file") db.close();
    useSql.setState({ runs: { ...useSql.getState().runs, [path]: run } });
    openEditorInput({ kind: "sqlResults", id: `sqlResults:${path}`, path, preview: false }, { toSide: true });
    const err = results.find((r) => r.kind === "error");
    if (err) notify("error", `SQL error on line ${err.line}: ${err.error}`);
  } catch (e) {
    notify("error", `Could not run SQL: ${(e as Error).message}`);
  } finally {
    useSql.setState({ running: null });
  }
}

/** EXPLAIN QUERY PLAN for one statement, in the database the last run used ("keep" mode keeps it). */
export async function explain(sql: string): Promise<string[]> {
  const db = await keptDatabase(keyOfWorkspace());
  try {
    return queryPlan(db, sql);
  } catch (e) {
    return [`(${(e as Error).message})`];
  }
}

export function activeSqlFile(): string | null {
  const p = activeFilePath();
  return p && /\.sql$/i.test(p) ? p : null;
}

export async function loadSqlMode() {
  const m = await getPlatform().store.get<SqlMode>("sql.mode").catch(() => undefined);
  if (m === "fresh" || m === "keep") useSql.setState({ mode: m });
}

export const sqlTitle = (path: string) => `SQL: ${baseOf(path)}`;
