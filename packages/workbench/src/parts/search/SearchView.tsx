import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { getDocument } from "../../monaco/documents";
import { codeEditorFor } from "../../monaco/editors";
import { getPlatform, notify, openFile, showDialog, useWorkbench, workbench } from "../../state/store";
import { basename, dirname } from "../../util/paths";
import { ActionButton, Codicon, FileIcon } from "../../widgets/icons";
import { SkeletonRows } from "../../widgets/Skeleton";
import { useTreeKeyboard, type TreeKeyRow } from "../../widgets/useTreeKeyboard";
import { MAX_MATCHES, buildRegExp, expandReplacement, listFiles, matchKey, searchText, type FileMatches, type LineMatch, type SearchOptions } from "./search";
import { applyReplace, previewReplace, type ReplaceTarget } from "./replace";
import { ReplacePreview, type ReplacePreviewState } from "./ReplacePreview";

/** Search view state that outlives the view (switching to the Explorer and back keeps it). */
export const useSearchUi = create<{
  opts: SearchOptions;
  replace: string;
  showReplace: boolean;
  showDetails: boolean;
  include: string;
  exclude: string;
  /** "Use Exclude Settings and Ignore Files". */
  useExcludes: boolean;
  /** Bumped to move focus to the replace box (Replace in Files command). */
  focusReplace: number;
}>(() => ({
  opts: { query: "", matchCase: false, wholeWord: false, regex: false },
  replace: "",
  showReplace: false,
  showDetails: false,
  include: "",
  exclude: "",
  useExcludes: true,
  focusReplace: 0,
}));

const setUi = useSearchUi.setState;

/** ⇧⌘H: the Search view with the Replace box open. */
export function openReplaceInFiles() {
  setUi((s) => ({ showReplace: true, focusReplace: s.focusReplace + 1 }));
}

function Toggle({ icon, label, on, onChange }: { icon: string; label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`tm-input-toggle ${on ? "is-on" : ""}`} aria-pressed={on} aria-label={label} title={label} onClick={() => onChange(!on)}>
      <Codicon name={icon} />
    </button>
  );
}

const fileId = (path: string) => `f:${path}`;
const matchId = (path: string, m: LineMatch) => `m:${path}#${matchKey(m)}`;

/** What one match becomes, for the strike-through preview in the list. */
function replacedText(m: LineMatch, opts: SearchOptions, replace: string) {
  if (!opts.regex) return replace;
  try {
    const re = buildRegExp(opts);
    if (typeof re === "string") return replace;
    const one = new RegExp(re.source, re.flags.replace("g", ""));
    const exec = one.exec(m.text);
    return exec ? expandReplacement(replace, exec, true) : replace;
  } catch {
    return replace;
  }
}

export function SearchView() {
  const workspace = useWorkbench((s) => s.workspace);
  const filesExclude = useWorkbench((s) => s.settings["files.exclude"]);
  const searchExclude = useWorkbench((s) => s.settings["search.exclude"]);
  const useIgnoreFiles = useWorkbench((s) => s.settings["search.useIgnoreFiles"]);
  const ui = useSearchUi();
  const { opts } = ui;
  const [results, setResults] = useState<FileMatches[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<(ReplacePreviewState & { target: ReplaceTarget }) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const runId = useRef(0);
  const setOpts = (o: SearchOptions) => setUi({ opts: o });

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (ui.focusReplace) setTimeout(() => replaceRef.current?.focus(), 0);
  }, [ui.focusReplace]);

  useEffect(() => {
    const id = ++runId.current;
    const re = buildRegExp(opts);
    if (typeof re === "string") {
      setResults([]);
      setBusy(false);
      setMessage(opts.query ? re : null);
      return;
    }
    setBusy(true);
    const timer = setTimeout(async () => {
      const fs = getPlatform().fs;
      const files = await listFiles(fs, {
        include: ui.include,
        exclude: ui.exclude,
        settingsExclude: ui.useExcludes ? `${filesExclude}, ${searchExclude}` : "",
        useIgnoreFiles: ui.useExcludes && useIgnoreFiles,
      });
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
          ? ui.include || ui.exclude
            ? "No results found. Review your include and exclude patterns."
            : "No results found. Review your settings for configured exclusions."
          : `${total}${budget.left <= 0 ? "+" : ""} result${total === 1 ? "" : "s"} in ${found.length} file${found.length === 1 ? "" : "s"}`,
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [opts, ui.include, ui.exclude, ui.useExcludes, filesExclude, searchExclude, useIgnoreFiles, workspace, refresh]);

  const reveal = (path: string, line: number, start: number, end: number, pinned = false) => {
    openFile(path, { pinned });
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

  const total = results.reduce((n, f) => n + f.matches.length, 0);
  const replacing = ui.showReplace;

  // ── dismiss and replace ──
  const dismissFile = (path: string) => setResults((r) => r.filter((f) => f.path !== path));
  const dismissMatch = (path: string, m: LineMatch) =>
    setResults((r) => r.flatMap((f) => (f.path !== path ? [f] : f.matches.length > 1 ? [{ ...f, matches: f.matches.filter((x) => x !== m) }] : [])));
  const targetFor = (file: FileMatches, only?: LineMatch[]): ReplaceTarget => ({ path: file.path, only: new Set((only ?? file.matches).map(matchKey)) });

  const runReplace = async (targets: ReplaceTarget[]) => {
    const done = await applyReplace(targets, opts, ui.replace);
    if (done.count) notify("info", `Replaced ${done.count} occurrence${done.count === 1 ? "" : "s"} in ${done.files} file${done.files === 1 ? "" : "s"}. Undo from the Timeline (Local History) or with ${getPlatform().os === "mac" ? "⌘Z" : "Ctrl+Z"} in open files.`);
    setRefresh((n) => n + 1);
  };

  const replaceAll = async () => {
    if (!total) return;
    const choice = await showDialog({
      message: `Replace ${total} occurrence${total === 1 ? "" : "s"} across ${results.length} file${results.length === 1 ? "" : "s"} with '${ui.replace}'?`,
      detail: "Local History keeps a copy of each file first.",
      severity: "warning",
      buttons: [
        { id: "replace", label: "Replace", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (choice === "replace") await runReplace(results.map((f) => targetFor(f)));
  };

  const openPreview = async (file: FileMatches, line?: number) => {
    const target = targetFor(file);
    try {
      const p = await previewReplace(file.path, opts, ui.replace, target.only);
      setPreview({ path: file.path, ...p, line, target });
    } catch (e) {
      notify("error", `Could not preview '${file.path}': ${String((e as Error)?.message ?? e)}`);
    }
  };

  // ── keyboard tree ──
  const index = useMemo(() => {
    const map = new Map<string, { file: FileMatches; match?: LineMatch }>();
    for (const f of results) {
      map.set(fileId(f.path), { file: f });
      for (const m of f.matches) map.set(matchId(f.path, m), { file: f, match: m });
    }
    return map;
  }, [results]);
  const rows: TreeKeyRow[] = useMemo(() => {
    const out: TreeKeyRow[] = [];
    for (const f of results) {
      const open = !collapsed[f.path];
      out.push({ id: fileId(f.path), parent: null, expandable: true, expanded: open });
      if (open) for (const m of f.matches) out.push({ id: matchId(f.path, m), parent: fileId(f.path), expandable: false, expanded: false });
    }
    return out;
  }, [results, collapsed]);
  const toggleFile = (path: string, open: boolean) => {
    const next = { ...collapsed };
    if (open) delete next[path];
    else next[path] = true;
    setCollapsed(next);
  };
  const tree = useTreeKeyboard("tm-search-row", rows, {
    onToggle: (id, open) => {
      const hit = index.get(id);
      if (hit) toggleFile(hit.file.path, open);
    },
    onOpen: (id, { pinned }) => {
      const hit = index.get(id);
      if (!hit?.match) return;
      if (replacing) void openPreview(hit.file, hit.match.line);
      else reveal(hit.file.path, hit.match.line, hit.match.start, hit.match.end, pinned);
    },
    onDelete: (id) => {
      const hit = index.get(id);
      if (!hit) return;
      if (hit.match) dismissMatch(hit.file.path, hit.match);
      else dismissFile(hit.file.path);
    },
  });

  const os = getPlatform().os;
  const replaceAllKey = os === "mac" ? "⌥⌘Enter" : "Ctrl+Alt+Enter";

  return (
    <div className="tm-pane tm-search">
      <div className={`tm-search-form ${replacing ? "is-replacing" : ""}`}>
        <button
          type="button"
          className="tm-search-replace-toggle"
          aria-label="Toggle Replace"
          title="Toggle Replace"
          aria-expanded={replacing}
          onClick={() => setUi({ showReplace: !replacing })}
        >
          <Codicon name={replacing ? "chevron-down" : "chevron-right"} />
        </button>
        <div className="tm-search-inputs">
          <div className="tm-input-box">
            <input
              ref={inputRef}
              className="tm-input"
              placeholder="Search"
              aria-label="Search"
              value={opts.query}
              onChange={(e) => setOpts({ ...opts, query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpts({ ...opts, query: "" });
                if (e.key === "ArrowDown" && rows.length) {
                  e.preventDefault();
                  tree.setFocused(rows[0].id);
                  tree.treeProps.ref.current?.focus();
                }
              }}
            />
            <div className="tm-input-toggles">
              <Toggle icon="case-sensitive" label="Match Case" on={opts.matchCase} onChange={(matchCase) => setOpts({ ...opts, matchCase })} />
              <Toggle icon="whole-word" label="Match Whole Word" on={opts.wholeWord} onChange={(wholeWord) => setOpts({ ...opts, wholeWord })} />
              <Toggle icon="regex" label="Use Regular Expression" on={opts.regex} onChange={(regex) => setOpts({ ...opts, regex })} />
            </div>
          </div>
          {replacing && (
            <div className="tm-search-replace-row">
              <div className="tm-input-box">
                <input
                  ref={replaceRef}
                  className="tm-input"
                  placeholder="Replace"
                  aria-label="Replace"
                  value={ui.replace}
                  onChange={(e) => setUi({ replace: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.altKey && (os === "mac" ? e.metaKey : e.ctrlKey)) {
                      e.preventDefault();
                      void replaceAll();
                    }
                  }}
                />
              </div>
              <ActionButton icon="replace-all" label={`Replace All (${replaceAllKey})`} disabled={!total} onClick={() => void replaceAll()} />
            </div>
          )}
        </div>
      </div>
      <div className="tm-search-details-toggle">
        <ActionButton icon="ellipsis" label="Toggle Search Details" active={ui.showDetails} aria-expanded={ui.showDetails} onClick={() => setUi({ showDetails: !ui.showDetails })} />
      </div>
      {ui.showDetails && (
        <div className="tm-search-details">
          <label className="tm-search-details-label" htmlFor="tm-search-include">
            files to include
          </label>
          <input
            id="tm-search-include"
            className="tm-input"
            placeholder="e.g. *.py, src/**"
            aria-label="files to include"
            value={ui.include}
            onChange={(e) => setUi({ include: e.target.value })}
          />
          <label className="tm-search-details-label" htmlFor="tm-search-exclude">
            files to exclude
          </label>
          <div className="tm-input-box">
            <input
              id="tm-search-exclude"
              className="tm-input"
              placeholder="e.g. *.test.ts, tests/**"
              aria-label="files to exclude"
              value={ui.exclude}
              onChange={(e) => setUi({ exclude: e.target.value })}
            />
            <div className="tm-input-toggles">
              <Toggle icon="exclude" label="Use Exclude Settings and Ignore Files" on={ui.useExcludes} onChange={(useExcludes) => setUi({ useExcludes })} />
            </div>
          </div>
        </div>
      )}
      {busy && <div className="tm-progress" role="progressbar" aria-label="Searching" />}
      {busy && results.length === 0 && <SkeletonRows rows={5} label="Searching" />}
      {message && (
        <div className="tm-search-message" role="status">
          {message}
        </div>
      )}
      <div className="tm-pane-body tm-scroll tm-search-results" aria-label="Search results" {...tree.treeProps}>
        {results.map((file) => {
          const open = !collapsed[file.path];
          const fid = fileId(file.path);
          return (
            <div key={file.path} role="none">
              <div
                role="treeitem"
                aria-level={1}
                aria-expanded={open}
                {...tree.rowProps(fid)}
                className={`tm-list-row tm-search-file ${tree.focused === fid ? "is-focused" : ""}`}
                onClick={() => {
                  tree.setFocused(fid);
                  toggleFile(file.path, !open);
                }}
              >
                <span className="tm-twistie">
                  <Codicon name={open ? "chevron-down" : "chevron-right"} />
                </span>
                <FileIcon path={file.path} />
                <span className="tm-tree-label">{basename(file.path)}</span>
                <span className="tm-search-dir">{dirname(file.path)}</span>
                <span className="tm-search-row-actions" onClick={(e) => e.stopPropagation()}>
                  {replacing && <ActionButton icon="replace-all" label="Replace All in File" tabIndex={-1} onClick={() => void runReplace([targetFor(file)])} />}
                  <ActionButton icon="close" label="Dismiss" tabIndex={-1} onClick={() => dismissFile(file.path)} />
                </span>
                <span className="tm-badge">{file.matches.length}</span>
              </div>
              {open &&
                file.matches.map((m) => {
                  const mid = matchId(file.path, m);
                  return (
                    <div
                      key={mid}
                      role="treeitem"
                      aria-level={2}
                      {...tree.rowProps(mid)}
                      className={`tm-list-row tm-search-line ${tree.focused === mid ? "is-focused" : ""}`}
                      title={`${file.path}:${m.line}`}
                      onClick={() => {
                        tree.setFocused(mid);
                        if (replacing) void openPreview(file, m.line);
                        else reveal(file.path, m.line, m.start, m.end);
                      }}
                    >
                      <span>{m.preview.slice(0, m.previewStart)}</span>
                      {replacing ? (
                        <>
                          <del className="tm-search-hit is-removed">{m.preview.slice(m.previewStart, m.previewEnd)}</del>
                          <ins className="tm-search-hit is-added">{replacedText(m, opts, ui.replace)}</ins>
                        </>
                      ) : (
                        <mark className="tm-search-hit">{m.preview.slice(m.previewStart, m.previewEnd)}</mark>
                      )}
                      <span>{m.preview.slice(m.previewEnd)}</span>
                      <span className="tm-search-row-actions" onClick={(e) => e.stopPropagation()}>
                        {replacing && <ActionButton icon="replace" label="Replace" tabIndex={-1} onClick={() => void runReplace([targetFor(file, [m])])} />}
                        <ActionButton icon="close" label="Dismiss" tabIndex={-1} onClick={() => dismissMatch(file.path, m)} />
                      </span>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
      {preview && (
        <ReplacePreview
          state={preview}
          onClose={() => setPreview(null)}
          onReplace={() => {
            const target = preview.target;
            setPreview(null);
            void runReplace([target]);
          }}
        />
      )}
    </div>
  );
}
