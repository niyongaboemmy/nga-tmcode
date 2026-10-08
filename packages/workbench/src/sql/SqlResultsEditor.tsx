import { useEffect, useState } from "react";
import type { EditorInput } from "../state/store";
import { revealInEditor } from "../monaco/reveal";
import { Codicon } from "../widgets/icons";
import { getPlatform } from "../state/store";
import type { StatementResult } from "./engine";
import { explain, loadSqlMode, resetDatabase, runSql, setSqlMode, useSql } from "./service";

type Input = Extract<EditorInput, { kind: "sqlResults" }>;

const fmtMs = (ms: number) => (ms < 1 ? "<1 ms" : `${Math.round(ms)} ms`);

function cell(v: unknown) {
  if (v === null || v === undefined) return <span className="tm-sql-null">NULL</span>;
  if (v instanceof Uint8Array) return <span className="tm-sql-null">BLOB ({v.length} bytes)</span>;
  return String(v);
}

function toCsv(r: StatementResult) {
  const q = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [r.columns.map(q).join(","), ...r.rows.map((row) => row.map(q).join(","))].join("\n");
}

function Statement({ r, path, index }: { r: StatementResult; path: string; index: number }) {
  const [plan, setPlan] = useState<string[] | null>(null);
  const isQuery = r.kind === "rows" || /^\s*(SELECT|WITH)\b/i.test(r.text);
  return (
    <section className={`tm-sql-stmt is-${r.kind}`} data-testid="sql-statement">
      <header className="tm-sql-stmt-head">
        <button
          type="button"
          className="tm-sql-line"
          title="Show this statement in the file"
          onClick={() => revealInEditor(path, r.line, 1)}
        >
          #{index + 1} · line {r.line}
        </button>
        <code className="tm-sql-text" title={r.text}>
          {r.text.replace(/\s+/g, " ").slice(0, 140)}
        </code>
        <span className="tm-sql-status">
          {r.kind === "error" ? (
            <>
              <Codicon name="error" /> Error
            </>
          ) : r.kind === "rows" ? (
            <>
              <Codicon name="pass" /> {r.rows.length}
              {r.truncated ? "+" : ""} row{r.rows.length === 1 ? "" : "s"}
            </>
          ) : r.kind === "change" ? (
            <>
              <Codicon name="pass" /> {r.changes} row{r.changes === 1 ? "" : "s"} changed
            </>
          ) : (
            <>
              <Codicon name="pass" /> Done
            </>
          )}
          <small>{fmtMs(r.ms)}</small>
        </span>
        {isQuery && r.kind !== "error" && (
          <button type="button" className="tm-action" title="How SQLite runs this query (EXPLAIN QUERY PLAN)" aria-label="Explain" onClick={async () => setPlan(plan ? null : await explain(r.text, path))}>
            <Codicon name="lightbulb" />
          </button>
        )}
        {r.kind === "rows" && (
          <button type="button" className="tm-action" title="Copy the rows as CSV" aria-label="Copy as CSV" onClick={() => void navigator.clipboard?.writeText(toCsv(r))}>
            <Codicon name="copy" />
          </button>
        )}
      </header>
      {r.kind === "error" && <pre className="tm-sql-error">{r.error}</pre>}
      {plan && (
        <pre className="tm-sql-plan" data-testid="sql-plan">
          {plan.join("\n") || "(no plan)"}
        </pre>
      )}
      {r.kind === "rows" && (
        <div className="tm-sql-table-wrap">
          <table className="tm-sql-table" data-testid="sql-table">
            <thead>
              <tr>
                <th className="tm-sql-rownum">#</th>
                {r.columns.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.rows.map((row, i) => (
                <tr key={i}>
                  <td className="tm-sql-rownum">{i + 1}</td>
                  {row.map((v, j) => (
                    <td key={j} className={typeof v === "number" ? "is-num" : ""}>
                      {cell(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {r.rows.length === 0 && <p className="tm-muted tm-sql-empty">No rows.</p>}
          {r.truncated && <p className="tm-muted tm-sql-empty">Only the first {r.rows.length} rows are shown.</p>}
        </div>
      )}
    </section>
  );
}

/** Results of a .sql file run in the built-in SQLite. */
export function SqlResultsEditor({ input }: { input: Input }) {
  const run = useSql((s) => s.runs[input.path]);
  const mode = useSql((s) => s.mode);
  const running = useSql((s) => s.running === input.path);
  useEffect(() => {
    void loadSqlMode();
  }, []);
  const errors = run?.results.filter((r) => r.kind === "error").length ?? 0;
  return (
    <div className="tm-sql-page" data-testid="sql-results">
      <header className="tm-sql-head">
        <Codicon name="database" />
        <b>{input.path.split("/").pop()}</b>
        {run && (
          <span className={`tm-chip ${errors ? "is-late" : "is-success"}`}>
            {run.scope === "statement" ? "Statement" : `${run.results.length} statement${run.results.length === 1 ? "" : "s"}`}
            {errors ? " · error" : " · OK"}
          </span>
        )}
        <span className="tm-sql-head-spacer" />
        <div className="tm-sql-mode" role="radiogroup" aria-label="Database between runs">
          <button type="button" role="radio" aria-checked={mode === "fresh"} className={`tm-filter-chip ${mode === "fresh" ? "is-active" : ""}`} onClick={() => void setSqlMode("fresh")} title="Every run starts from an empty database; schema.sql and seed.sql beside the file run first">
            Fresh each run
          </button>
          <button type="button" role="radio" aria-checked={mode === "keep"} className={`tm-filter-chip ${mode === "keep" ? "is-active" : ""}`} onClick={() => void setSqlMode("keep")} title="Tables and rows stay between runs (Reset Database empties it)">
            Keep data
          </button>
        </div>
        {mode === "keep" && (
          <button type="button" className="tm-action" title="Empty the database" aria-label="Reset Database" onClick={resetDatabase}>
            <Codicon name="trash" />
          </button>
        )}
        <button type="button" className="tm-button tm-button--small" disabled={running} onClick={() => void runSql(input.path)} title={`Run the whole file (${getPlatform().os === "mac" ? "⌘" : "Ctrl+"}Shift+Enter)`} data-testid="sql-run-again">
          <Codicon name={running ? "loading" : "play"} className={running ? "codicon-modifier-spin" : ""} /> Run
        </button>
      </header>
      {!run ? (
        <p className="tm-muted tm-sql-empty">Run the file to see its results here.</p>
      ) : (
        <div className="tm-sql-body">
          <div className="tm-sql-results">
            {run.prepared.length > 0 && (
              <p className="tm-sql-note">
                <Codicon name="info" /> Fresh database: ran {run.prepared.join(", ")} first.
              </p>
            )}
            {run.prepareError && <pre className="tm-sql-error">{run.prepareError}</pre>}
            {run.results.map((r, i) => (
              <Statement key={`${run.at}:${i}`} r={r} path={input.path} index={i} />
            ))}
            {!run.results.length && !run.prepareError && <p className="tm-muted tm-sql-empty">No statements in the file.</p>}
          </div>
          <aside className="tm-sql-schema" aria-label="Schema">
            <h3>Schema</h3>
            {run.schema.length === 0 && <p className="tm-muted">No tables yet.</p>}
            {run.schema.map((t) => (
              <details key={t.name} open className="tm-sql-schema-table" data-testid="sql-schema-table">
                <summary>
                  <Codicon name={t.type === "view" ? "eye" : "table"} /> {t.name}
                  {t.rows !== null && <small>{t.rows} rows</small>}
                </summary>
                <ul>
                  {t.columns.map((c) => (
                    <li key={c.name}>
                      {c.pk ? <Codicon name="key" title="Primary key" /> : <span className="tm-sql-col-pad" />}
                      <span>{c.name}</span>
                      <small>
                        {c.type || "ANY"}
                        {c.notnull ? " NOT NULL" : ""}
                      </small>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </aside>
        </div>
      )}
    </div>
  );
}
