import { useState } from "react";
import { saveAll } from "../../monaco/documents";
import { activateEditor, closeEditors, useWorkbench, type EditorInput } from "../../state/store";
import { ActionButton, Codicon, FileIcon } from "../../widgets/icons";
import { titleOf } from "../editor/EditorGroupView";
import { dirname } from "../../util/paths";
import { isUntitled } from "../../util/untitled";

/**
 * VS Code's Open Editors: every open editor, by group, with its unsaved dot,
 * a close button and Save All / Close All. Collapsed until opened.
 */
export function OpenEditorsPane() {
  const groups = useWorkbench((s) => s.groups);
  const activeGroup = useWorkbench((s) => s.activeGroup);
  const dirty = useWorkbench((s) => s.dirty);
  const [open, setOpen] = useState(false);
  const count = groups.reduce((n, g) => n + g.editors.length, 0);
  const dirtyCount = Object.keys(dirty).length;
  const many = groups.filter((g) => g.editors.length).length > 1;

  const row = (groupId: number, e: EditorInput, active: boolean) => {
    const path = e.kind === "file" ? e.path : null;
    const isDirty = !!path && !!dirty[path];
    return (
      <div
        key={`${groupId}:${e.id}`}
        className={`tm-list-row tm-open-editor ${active ? "is-active" : ""}`}
        role="treeitem"
        tabIndex={0}
        aria-selected={active}
        data-testid="open-editor"
        title={path ?? titleOf(e)}
        onClick={() => activateEditor(groupId, e.id)}
        onKeyDown={(ev) => ev.key === "Enter" && activateEditor(groupId, e.id)}
      >
        <button
          type="button"
          className={`tm-open-editor-close ${isDirty ? "is-dirty" : ""}`}
          aria-label={`Close ${titleOf(e)}`}
          title="Close"
          onClick={(ev) => {
            ev.stopPropagation();
            void closeEditors(groupId, [e.id]);
          }}
        >
          <Codicon name={isDirty ? "circle-filled" : "close"} />
        </button>
        {path ? <FileIcon path={path} /> : <Codicon name="file" />}
        <span className="tm-open-editor-name">{titleOf(e)}</span>
        {path && !isUntitled(path) && dirname(path) && <span className="tm-open-editor-dir">{dirname(path)}</span>}
      </div>
    );
  };

  return (
    <section className={`tm-pane tm-timeline tm-open-editors ${open ? "is-open" : "is-collapsed"}`} aria-label="Open Editors" data-testid="open-editors">
      <div className="tm-pane-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} />
        <span className="tm-pane-title">Open Editors</span>
        {!open && dirtyCount > 0 && <span className="tm-open-editors-badge">{dirtyCount} unsaved</span>}
        {open && (
          <span className="tm-pane-actions" onClick={(e) => e.stopPropagation()}>
            <ActionButton icon="save-all" label="Save All" onClick={() => void saveAll()} />
            <ActionButton icon="close-all" label="Close All Editors" onClick={() => groups.forEach((g) => void closeEditors(g.id, g.editors.map((e) => e.id)))} />
          </span>
        )}
      </div>
      {open && (
        <div className="tm-pane-body tm-scroll" role="tree" aria-label="Open editors">
          {!count && <p className="tm-muted tm-projects-hint">No editors are open.</p>}
          {groups.map((g, i) =>
            g.editors.length ? (
              <div key={g.id} role="group" aria-label={`Group ${i + 1}`}>
                {many && <div className="tm-open-editors-group">Group {i + 1}</div>}
                {g.editors.map((e) => row(g.id, e, g.id === activeGroup && g.activeId === e.id))}
              </div>
            ) : null,
          )}
        </div>
      )}
    </section>
  );
}
