import { useEffect, useState } from "react";
import { getDocument } from "../monaco/documents";
import { activeFilePath, getPlatform, notify, openEditorInput, showDialog, useWorkbench } from "../state/store";
import { basename } from "../util/paths";
import { ActionButton, Codicon } from "../widgets/icons";
import { listHistory, readHistory, useHistory, type HistoryEntry } from "./localHistory";

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
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    if (!open || !path) return;
    let alive = true;
    void listHistory(path).then((list) => alive && setEntries(list));
    return () => {
      alive = false;
    };
  }, [open, path, version]);

  return (
    <section className={`tm-pane tm-timeline ${open ? "is-open" : "is-collapsed"}`} aria-label="Timeline" data-testid="timeline">
      <div className="tm-pane-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} />
        <span className="tm-pane-title">Timeline</span>
        {path && <span className="tm-pane-desc">{basename(path)}</span>}
      </div>
      {open && (
        <div className="tm-pane-body tm-scroll tm-timeline-body">
          {!path ? (
            <p className="tm-muted tm-projects-hint">The active editor's history appears here.</p>
          ) : entries === null ? null : entries.length === 0 ? (
            <p className="tm-muted tm-projects-hint">No saved versions of {basename(path)} yet. Every save keeps one here.</p>
          ) : (
            entries.map((e, i) => (
              <div
                key={e.id}
                className="tm-list-row tm-timeline-row"
                role="button"
                tabIndex={0}
                title={`${new Date(e.time).toLocaleString()} — click to compare with the current file`}
                onClick={() => compareWithHistory(path, e)}
                onKeyDown={(k) => k.key === "Enter" && compareWithHistory(path, e)}
              >
                <Codicon name={i === 0 ? "circle-filled" : "circle-outline"} className="tm-timeline-dot" />
                <span className="tm-project-name">File Saved</span>
                <span className="tm-project-meta">{when(e.time)}</span>
                <ActionButton icon="discard" label="Restore This Version" onClick={(ev) => (ev.stopPropagation(), void restoreFromHistory(path, e))} />
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
