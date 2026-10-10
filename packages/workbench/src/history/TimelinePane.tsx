import { useEffect, useState } from "react";
import { getDocument } from "../monaco/documents";
import { activeFilePath, getPlatform, notify, openEditorInput, showDialog, useWorkbench } from "../state/store";
import { basename } from "../util/paths";
import { ActionButton, Codicon, FileIcon } from "../widgets/icons";
import { listHistory, readHistory, useHistory, type HistoryEntry } from "./localHistory";
import { gitHost, useGit } from "../scm/gitService";
import type { GitCommit } from "../platform/types";

/** A commit that changed the file: compare that version with the file now. */
export function compareWithCommit(path: string, c: GitCommit) {
  openEditorInput({ kind: "historyDiff", id: `git:${path}:${c.hash}`, path, entry: c.hash, time: c.date * 1000, preview: false, source: "git", label: `${c.short} ${c.subject}` });
}

type Row = { kind: "local"; time: number; e: HistoryEntry } | { kind: "git"; time: number; c: GitCommit };

function when(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return new Date(ms).toLocaleDateString();
}

export function compareWithHistory(path: string, e: HistoryEntry) {
  openEditorInput({ kind: "historyDiff", id: `history:${path}:${e.id}`, path, entry: e.id, time: e.time, preview: false });
}

export async function restoreFromHistory(path: string, e: HistoryEntry) {
  const choice = await showDialog({
    severity: "warning",
    message: `Restore ${basename(path)} to the version from ${new Date(e.time).toLocaleString()}?`,
    detail: "The current content is kept in Local History, so you can go back.",
    buttons: [
      { id: "restore", label: "Restore", primary: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (choice !== "restore") return;
  const text = await readHistory(path, e.id);
  const model = getDocument(path);
  if (model) {
    // An edit (not a reload) so Undo brings the current content back.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  } else await getPlatform().fs.writeFile(path, text);
  notify("info", `Restored ${basename(path)}. Save to keep it (Undo goes back).`);
}

/** VS Code's Timeline under the Explorer: Local History of the active file. */
export function TimelinePane() {
  const path = useWorkbench((s) => activeFilePath(s));
  const version = useHistory((s) => s.version);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const gitVersion = useGit((s) => s.version);
  const repo = useGit((s) => !!s.status);

  useEffect(() => {
    if (!open || !path) return;
    let alive = true;
    // Local History (every save) and the git commits that changed the file, newest first, as VS Code's Timeline.
    const git = repo ? gitHost() : undefined;
    void Promise.all([listHistory(path), git?.fileLog?.(path, 50).catch(() => [] as GitCommit[]) ?? Promise.resolve([] as GitCommit[])]).then(([local, commits]) => {
      if (!alive) return;
      const all: Row[] = [...local.map((e) => ({ kind: "local" as const, time: e.time, e })), ...commits.map((c) => ({ kind: "git" as const, time: c.date * 1000, c }))];
      setRows(all.sort((a, b) => b.time - a.time));
    });
    return () => {
      alive = false;
    };
  }, [open, path, version, gitVersion, repo]);

  return (
    <section className={`tm-pane tm-timeline ${open ? "is-open" : "is-collapsed"}`} aria-label="Timeline" data-testid="timeline">
      <div className="tm-pane-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} />
        <span className="tm-pane-title">Timeline</span>
        {path && (
          <span className="tm-pane-desc tm-timeline-file">
            <FileIcon path={path} size={14} />
            {basename(path)}
          </span>
        )}
      </div>
      {open && (
        <div className="tm-pane-body tm-scroll tm-timeline-body">
          {!path ? (
            <p className="tm-muted tm-projects-hint">The active editor's history appears here.</p>
          ) : rows === null ? null : rows.length === 0 ? (
            <p className="tm-muted tm-projects-hint">No saved versions of {basename(path)} yet. Every save keeps one here.</p>
          ) : (
            rows.map((r, i) =>
              r.kind === "local" ? (
                <div
                  key={r.e.id}
                  className="tm-list-row tm-timeline-row"
                  role="button"
                  tabIndex={0}
                  title={`${new Date(r.time).toLocaleString()} — click to compare with the current file`}
                  onClick={() => compareWithHistory(path, r.e)}
                  onKeyDown={(k) => k.key === "Enter" && compareWithHistory(path, r.e)}
                >
                  <Codicon name={i === 0 ? "circle-filled" : "circle-outline"} className="tm-timeline-dot" />
                  <span className="tm-project-name">File Saved</span>
                  <span className="tm-project-meta">{when(r.time)}</span>
                  <ActionButton icon="discard" label="Restore This Version" onClick={(ev) => (ev.stopPropagation(), void restoreFromHistory(path, r.e))} />
                </div>
              ) : (
                <div
                  key={r.c.hash}
                  className="tm-list-row tm-timeline-commit"
                  role="button"
                  tabIndex={0}
                  data-commit={r.c.short}
                  title={`${r.c.subject}\n${r.c.author}, ${new Date(r.time).toLocaleString()} (${r.c.short}) — click to compare with the file now`}
                  onClick={() => compareWithCommit(path, r.c)}
                  onKeyDown={(k) => k.key === "Enter" && compareWithCommit(path, r.c)}
                >
                  <Codicon name="git-commit" className="tm-timeline-dot" />
                  <span className="tm-project-name">{r.c.subject || r.c.short}</span>
                  <span className="tm-project-meta">
                    {r.c.author} · {when(r.time)}
                  </span>
                </div>
              ),
            )
          )}
        </div>
      )}
    </section>
  );
}
