import { useEffect, useMemo, useState } from "react";
import { getDocument, onDocumentChanged } from "../../monaco/documents";
import { getPlatform } from "../../state/store";
import { guessDelimiter, parseCsv } from "./documentPreview";

const MAX_ROWS = 5000;

/** A CSV or TSV file as a table, following unsaved edits. */
export function CsvPreview({ path }: { path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const platform = getPlatform();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const src = getDocument(path)?.getValue() ?? (await platform.fs.readFile(path).catch(() => ""));
      if (alive) setText(src);
    };
    void load();
    const off = onDocumentChanged((p) => p === path && void load());
    return () => {
      alive = false;
      off();
    };
  }, [path, platform]);

  const rows = useMemo(() => (text === null ? [] : parseCsv(text, guessDelimiter(path, text), MAX_ROWS + 1)), [text, path]);
  const [head, ...body] = rows;
  const q = filter.trim().toLowerCase();
  const shown = (q ? body.filter((r) => r.some((c) => c.toLowerCase().includes(q))) : body).slice(0, MAX_ROWS);

  return (
    <div className="tm-csv-preview" data-testid="csv-preview">
      <div className="tm-preview-toolbar">
        <input className="tm-input tm-csv-filter" placeholder="Filter rows" aria-label="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="tm-muted">
          {shown.length} of {body.length >= MAX_ROWS ? `${MAX_ROWS}+` : body.length} rows · {head?.length ?? 0} columns
        </span>
      </div>
      <div className="tm-csv-scroll tm-scroll">
        <table className="tm-csv-table">
          {head && (
            <thead>
              <tr>
                <th className="tm-csv-n">#</th>
                {head.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                <td className="tm-csv-n">{i + 1}</td>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
