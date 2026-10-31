import { useEffect, useMemo, useState } from "react";
import { ensureDocument, saveDocument } from "../monaco/documents";
import { closeEditors, notify, openFile, workbench } from "../state/store";
import { basename } from "../util/paths";
import { Codicon } from "../widgets/icons";
import { applyChoices, parseConflicts, resolution, type ConflictChoice } from "./conflicts";
import { gitHost, scheduleRefresh } from "./gitService";

/**
 * The merge editor (VS Code's 3-way merge, kept simple): each conflict shows
 * the current change (yours) beside the incoming one (theirs), with Accept
 * Current / Incoming / Both; the result is previewed below each, and Complete
 * Merge writes the file and stages it.
 */
export function MergeEditor({ path, groupId, id }: { path: string; groupId: number; id: string }) {
  const [text, setText] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<number, ConflictChoice | undefined>>({});
  const conflicts = useMemo(() => (text === null ? [] : parseConflicts(text)), [text]);
  const done = conflicts.filter((_, i) => choices[i]).length;

  useEffect(() => {
    let alive = true;
    void ensureDocument(path).then(
      (m) => alive && setText(m.getValue()),
      (e) => alive && notify("error", `Could not open ${basename(path)}: ${String((e as Error)?.message ?? e)}`),
    );
    return () => {
      alive = false;
    };
  }, [path]);

  const chooseAll = (choice: ConflictChoice) => setChoices(Object.fromEntries(conflicts.map((_, i) => [i, choice])));

  const complete = async () => {
    const model = await ensureDocument(path);
    const merged = applyChoices(model.getValue(), choices);
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: merged }], () => null);
    await saveDocument(path);
    // git add: the conflict is resolved.
    await gitHost()?.stage([path]).catch(() => undefined);
    scheduleRefresh(0);
    notify("info", `${basename(path)} is merged${gitHost() ? " and staged" : ""}.`);
    await closeEditors(groupId, [id]);
    openFile(path, { pinned: true, group: groupId });
  };

  if (text === null) return <div className="tm-merge-editor" />;
  return (
    <div className="tm-merge-editor tm-scroll" data-testid="merge-editor">
      <div className="tm-merge-head">
        <Codicon name="git-merge" />
        <span className="tm-merge-title">Merging {basename(path)}</span>
        <span className="tm-merge-count" data-testid="merge-count">
          {conflicts.length ? `${done} of ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} resolved` : "No conflicts left"}
        </span>
        <span className="tm-merge-spacer" />
        <button type="button" className="tm-button tm-button--secondary tm-button--small" onClick={() => chooseAll("current")}>
          Accept All Current
        </button>
        <button type="button" className="tm-button tm-button--secondary tm-button--small" onClick={() => chooseAll("incoming")}>
          Accept All Incoming
        </button>
        <button type="button" className="tm-button tm-button--small" disabled={done < conflicts.length} onClick={() => void complete()} data-testid="merge-complete">
          Complete Merge
        </button>
      </div>
      {conflicts.map((c, i) => {
        const choice = choices[i];
        const set = (v: ConflictChoice) => setChoices((s) => ({ ...s, [i]: s[i] === v ? undefined : v }));
        return (
          <section key={c.start} className={`tm-merge-conflict ${choice ? "is-resolved" : ""}`} data-testid="merge-conflict" aria-label={`Conflict ${i + 1} at line ${c.start}`}>
            <div className="tm-merge-conflict-head">
              Conflict {i + 1} <span className="tm-muted">line {c.start}</span>
              {choice && (
                <span className="tm-merge-chosen">
                  <Codicon name="check" /> {choice === "both" ? "Both changes" : choice === "current" ? "Current change" : "Incoming change"}
                </span>
              )}
            </div>
            <div className="tm-merge-sides">
              <div className={`tm-merge-side is-current ${choice === "current" || choice === "both" ? "is-chosen" : ""}`}>
                <div className="tm-merge-side-head">
                  Current{c.currentLabel ? ` (${c.currentLabel})` : ""}
                  <button type="button" className="tm-link-button" onClick={() => set("current")}>
                    Accept Current
                  </button>
                </div>
                <pre>{c.current.join("\n") || " "}</pre>
              </div>
              <div className={`tm-merge-side is-incoming ${choice === "incoming" || choice === "both" ? "is-chosen" : ""}`}>
                <div className="tm-merge-side-head">
                  Incoming{c.incomingLabel ? ` (${c.incomingLabel})` : ""}
                  <button type="button" className="tm-link-button" onClick={() => set("incoming")}>
                    Accept Incoming
                  </button>
                </div>
                <pre>{c.incoming.join("\n") || " "}</pre>
              </div>
            </div>
            <div className="tm-merge-result">
              <div className="tm-merge-side-head">
                Result
                <button type="button" className="tm-link-button" onClick={() => set("both")}>
                  Accept Both
                </button>
              </div>
              <pre data-testid="merge-result">{choice ? resolution(c, choice).join("\n") || " " : "Choose a change above."}</pre>
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Opens the merge editor for a file with conflict markers. */
export function openMergeEditor(path: string) {
  const s = workbench.get();
  const groupId = s.activeGroup;
  const id = `merge:${path}`;
  workbench.set({
    groups: s.groups.map((g) => (g.id !== groupId ? g : { ...g, editors: g.editors.some((e) => e.id === id) ? g.editors : [...g.editors, { kind: "merge", id, path, preview: false }], activeId: id })),
  });
}
