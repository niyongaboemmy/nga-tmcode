import { useEffect, useRef, useState } from "react";
import { getDocument } from "../../monaco/documents";
import { codeEditorFor } from "../../monaco/editors";
import { getPlatform, openFile, useWorkbench, workbench } from "../../state/store";
import { basename, dirname } from "../../util/paths";
import { Codicon, FileIcon } from "../../widgets/icons";
import { MAX_MATCHES, buildRegExp, listFiles, searchText, type FileMatches, type SearchOptions } from "./search";

function Toggle({ icon, label, on, onChange }: { icon: string; label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`tm-input-toggle ${on ? "is-on" : ""}`} aria-pressed={on} aria-label={label} title={label} onClick={() => onChange(!on)}>
      <Codicon name={icon} />
    </button>
  );
}

export function SearchView() {
  const workspace = useWorkbench((s) => s.workspace);
  const [opts, setOpts] = useState<SearchOptions>({ query: "", matchCase: false, wholeWord: false, regex: false });
  const [results, setResults] = useState<FileMatches[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const runId = useRef(0);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const id = ++runId.current;
    const re = buildRegExp(opts);
    if (typeof re === "string") {
      setResults([]);
      setMessage(opts.query ? re : null);
      return;
    }
    setBusy(true);
    const timer = setTimeout(async () => {
      const fs = getPlatform().fs;
      const files = await listFiles(fs);
      const budget = { left: MAX_MATCHES };
      const found: FileMatches[] = [];
      for (const path of files) {
        if (runId.current !== id) return;
        // Search unsaved editor contents rather than what is on disk.
        const text = getDocument(path)?.getValue() ?? (await fs.readFile(path).catch(() => ""));
        const hit = searchText(path, text, re, budget);
        if (hit) found.push(hit);
        if (budget.left <= 0) break;
      }
      if (runId.current !== id) return;
      const total = found.reduce((n, f) => n + f.matches.length, 0);
      setResults(found);
      setBusy(false);
      setMessage(
        total === 0
          ? "No results found. Review your settings for configured exclusions."
          : `${total}${budget.left <= 0 ? "+" : ""} result${total === 1 ? "" : "s"} in ${found.length} file${found.length === 1 ? "" : "s"}`,
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [opts, workspace]);

  const reveal = (path: string, line: number, start: number, end: number) => {
    openFile(path, { pinned: false });
    // The editor mounts the model asynchronously; select once it is there.
    const trySelect = (attempt = 0) => {
      const ed = codeEditorFor(workbench.get().activeGroup);
      const model = ed?.getModel();
      if (ed && model && model.uri.path === `/${path}`) {
        const range = { startLineNumber: line, startColumn: start, endLineNumber: line, endColumn: end };
        ed.setSelection(range);
        ed.revealRangeInCenterIfOutsideViewport(range);
      } else if (attempt < 20) setTimeout(() => trySelect(attempt + 1), 25);
    };
    trySelect();
  };

  return (
    <div className="tm-pane tm-search">
      <div className="tm-search-form">
        <div className="tm-input-box">
          <input
            ref={inputRef}
            className="tm-input"
            placeholder="Search"
            aria-label="Search"
            value={opts.query}
            onChange={(e) => setOpts({ ...opts, query: e.target.value })}
            onKeyDown={(e) => e.key === "Escape" && setOpts({ ...opts, query: "" })}
          />
          <div className="tm-input-toggles">
            <Toggle icon="case-sensitive" label="Match Case" on={opts.matchCase} onChange={(matchCase) => setOpts({ ...opts, matchCase })} />
            <Toggle icon="whole-word" label="Match Whole Word" on={opts.wholeWord} onChange={(wholeWord) => setOpts({ ...opts, wholeWord })} />
            <Toggle icon="regex" label="Use Regular Expression" on={opts.regex} onChange={(regex) => setOpts({ ...opts, regex })} />
          </div>
        </div>
      </div>
      {busy && <div className="tm-progress" role="progressbar" aria-label="Searching" />}
      {message && <div className="tm-search-message">{message}</div>}
      <div className="tm-pane-body tm-scroll" role="tree" aria-label="Search results">
        {results.map((file) => {
          const open = !collapsed[file.path];
          return (
            <div key={file.path} role="treeitem" aria-expanded={open}>
              <div
                className="tm-list-row tm-search-file"
                onClick={() => {
                  const next = { ...collapsed };
                  if (open) next[file.path] = true;
                  else delete next[file.path];
                  setCollapsed(next);
                }}
              >
                <span className="tm-twistie">
                  <Codicon name={open ? "chevron-down" : "chevron-right"} />
                </span>
                <FileIcon path={file.path} />
                <span className="tm-tree-label">{basename(file.path)}</span>
                <span className="tm-search-dir">{dirname(file.path)}</span>
                <span className="tm-badge">{file.matches.length}</span>
              </div>
              {open &&
                file.matches.map((m, i) => (
                  <div
                    key={i}
                    className="tm-list-row tm-search-line"
                    title={`${file.path}:${m.line}`}
                    onClick={() => reveal(file.path, m.line, m.start, m.end)}
                  >
                    <span>{m.preview.slice(0, m.previewStart)}</span>
                    <mark className="tm-search-hit">{m.preview.slice(m.previewStart, m.previewEnd)}</mark>
                    <span>{m.preview.slice(m.previewEnd)}</span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
