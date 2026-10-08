import { useEffect, useMemo, useState } from "react";
import { getDocument, onDocumentChanged } from "../monaco/documents";
import { monaco } from "../monaco/setup";
import { revealInEditor } from "../monaco/reveal";
import { getPlatform, type EditorInput } from "../state/store";
import { Codicon } from "../widgets/icons";
import { equivalences, parseFile, show, truthTable, type LogicLine, type TruthTable } from "./logic";

type Input = Extract<EditorInput, { kind: "logic" }>;

const KIND = { tautology: "Tautology (always true)", contradiction: "Contradiction (always false)", contingency: "Contingency" } as const;

function Table({ t, ones }: { t: TruthTable; ones: boolean }) {
  const v = (b: boolean) => (ones ? (b ? "1" : "0") : b ? "T" : "F");
  const last = t.columns.length - 1;
  return (
    <div className="tm-sql-table-wrap">
      <table className="tm-sql-table tm-logic-table" data-testid="logic-table">
        <thead>
          <tr>
            {t.vars.map((x) => (
              <th key={x} className="is-var">
                {x}
              </th>
            ))}
            {t.columns.map((c, j) => (
              <th key={j} className={j === last ? "is-result" : "is-step"}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.inputs.map((row, i) => (
            <tr key={i}>
              {row.map((b, k) => (
                <td key={k} className={`is-var ${b ? "is-true" : "is-false"}`}>
                  {v(b)}
                </td>
              ))}
              {t.values[i].map((b, j) => (
                <td key={j} className={`${j === last ? "is-result" : "is-step"} ${b ? "is-true" : "is-false"}`}>
                  {v(b)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Expression({ l, path, ones, withSteps }: { l: LogicLine; path: string; ones: boolean; withSteps: boolean }) {
  const table = useMemo(() => {
    if (!l.expr) return { t: null as TruthTable | null, err: null as string | null };
    try {
      return { t: truthTable(l.expr, { steps: withSteps }), err: null };
    } catch (e) {
      return { t: null, err: (e as Error).message };
    }
  }, [l.expr, withSteps]);
  return (
    <section className="tm-logic-expr" data-testid="logic-expression">
      <header className="tm-sql-stmt-head">
        <button type="button" className="tm-sql-line" onClick={() => revealInEditor(path, l.line, 1)} title="Show this line in the file">
          line {l.line}
        </button>
        <code className="tm-logic-formula">
          {l.name ? `${l.name} = ` : ""}
          {l.expr ? show(l.expr) : l.source}
        </code>
        {table.t && <span className={`tm-chip tm-logic-kind is-${table.t.kind}`}>{KIND[table.t.kind]}</span>}
      </header>
      {l.error && (
        <pre className="tm-sql-error">
          Column {l.error.column}: {l.error.message}
        </pre>
      )}
      {table.err && <pre className="tm-sql-error">{table.err}</pre>}
      {table.t && (
        <>
          <Table t={table.t} ones={ones} />
          <dl className="tm-logic-facts">
            <dt>Minterms (true rows)</dt>
            <dd>{table.t.minterms.length ? `Σm(${table.t.minterms.join(", ")})` : "none"}</dd>
            <dt>Sum of products</dt>
            <dd>
              <code>{table.t.sop}</code>
            </dd>
            <dt>Product of sums</dt>
            <dd>
              <code>{table.t.pos}</code>
            </dd>
          </dl>
        </>
      )}
    </section>
  );
}

/** Truth tables for every expression of a .logic file, updated as it is typed. */
export function LogicEditor({ input }: { input: Input }) {
  const [text, setText] = useState<string | null>(null);
  const [ones, setOnes] = useState(false);
  const [withSteps, setWithSteps] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const src = getDocument(input.path)?.getValue() ?? (await getPlatform().fs.readFile(input.path).catch(() => ""));
      if (alive) setText(src);
    };
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onDocumentChanged((p) => {
      if (p !== input.path) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 120);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  }, [input.path]);
  const lines = useMemo(() => (text === null ? [] : parseFile(text)), [text]);
  // Syntax errors also show in the editor and in Problems.
  useEffect(() => {
    const model = getDocument(input.path);
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      "tmcode-logic",
      lines
        .filter((l) => l.error)
        .map((l) => ({ severity: monaco.MarkerSeverity.Error, message: l.error!.message, startLineNumber: l.line, startColumn: l.error!.column, endLineNumber: l.line, endColumn: l.error!.column + 1, source: "Logic" })),
    );
  }, [lines, input.path]);
  const eq = useMemo(() => equivalences(lines), [lines]);
  const label = (line: number) => {
    const l = lines.find((x) => x.line === line);
    return l?.name ?? `line ${line}`;
  };
  return (
    <div className="tm-sql-page" data-testid="logic-page">
      <header className="tm-sql-head">
        <Codicon name="symbol-boolean" />
        <b>{input.path.split("/").pop()}</b>
        <span className="tm-muted">
          {lines.length} expression{lines.length === 1 ? "" : "s"}
        </span>
        <span className="tm-sql-head-spacer" />
        <button type="button" className={`tm-filter-chip ${withSteps ? "is-active" : ""}`} onClick={() => setWithSteps(!withSteps)} title="Show a column for every sub-expression">
          Steps
        </button>
        <button type="button" className={`tm-filter-chip ${ones ? "is-active" : ""}`} onClick={() => setOnes(!ones)} title="Write values as 1/0 instead of T/F">
          1 / 0
        </button>
      </header>
      <div className="tm-sql-results">
        {text !== null && lines.length === 0 && (
          <div className="tm-logic-help">
            <p>Write one expression per line, optionally named:</p>
            <pre>{"F = not (A and B)\nG = !A | !B      # De Morgan: same table as F\np -> q <-> (not q -> not p)"}</pre>
            <p className="tm-muted">and &amp; ∧ · or | + ∨ · not ! ~ ¬ · xor ^ ⊕ · -&gt; → · &lt;-&gt; ↔ · nand nor · 0 1 T F</p>
          </div>
        )}
        {eq.length > 0 && (
          <p className="tm-sql-note" data-testid="logic-equivalent">
            <Codicon name="link" /> Equivalent: {eq.map((g) => g.map(label).join(" ≡ ")).join(";  ")}
          </p>
        )}
        {lines.map((l) => (
          <Expression key={`${l.line}:${l.source}`} l={l} path={input.path} ones={ones} withSteps={withSteps} />
        ))}
      </div>
    </div>
  );
}
