import { useEffect, useMemo, useRef, useState } from "react";
import { allCommands, chordOf, defaultKeybindingFor, formatKeybinding, keybindingFor, suspendKeybindings, userKeybindings } from "../../commands/registry";
import { editorActionCatalog, editorActionDefault, keybindingsLockedReason, setUserKeybinding } from "../../commands/keybindings";
import { findConflicts, type KeybindingRow } from "../../commands/keybindingLogic";
import { getPlatform, useWorkbench } from "../../state/store";
import { useExam } from "../../exam/state";
import { Codicon } from "../../widgets/icons";

/**
 * Keyboard Shortcuts (V9): every workbench command and Monaco editor action
 * with its key. Double-click (or Enter, or the pencil) records a new key;
 * conflicts are shown before saving; "Reset" restores the default. Locked
 * during exams.
 */
export function ShortcutsEditor() {
  const os = getPlatform().os;
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<KeybindingRow | null>(null);
  const overrides = useWorkbench((s) => s.settings["keybindings.user"]);
  const policy = useWorkbench((s) => s.policy);
  const examQuiz = useExam((s) => s.quiz);
  const locked = useMemo(() => keybindingsLockedReason(), [policy, examQuiz]);

  const allRows = useMemo((): KeybindingRow[] => {
    void overrides;
    const user = userKeybindings();
    const known = new Set<string>();
    const rows: KeybindingRow[] = [];
    for (const c of allCommands()) {
      known.add(c.id);
      const kb = keybindingFor(c, os);
      if (c.hidden && !kb) continue;
      rows.push({ id: c.id, title: c.title, category: c.category, kb, defaultKb: defaultKeybindingFor(c, os), source: c.id in user ? "User" : "Default" });
    }
    // Monaco's own actions (⌘D, ⌥↑…) that have no workbench command.
    for (const a of editorActionCatalog()) {
      if (known.has(a.id)) continue;
      const def = editorActionDefault(a.id);
      const kb = a.id in user ? user[a.id] || undefined : def;
      rows.push({ id: a.id, title: a.label, category: "Editor", kb, defaultKb: def, source: a.id in user ? "User" : "Default" });
    }
    return rows;
  }, [os, overrides]);

  const rows = useMemo(() => {
    const q = query.toLowerCase().trim();
    return allRows
      .map((r) => ({ r, label: formatKeybinding(r.kb, os) }))
      .filter(({ r, label }) => !q || `${r.category ?? ""} ${r.title} ${r.id} ${label} ${r.source}`.toLowerCase().includes(q))
      .sort((a, b) => (a.label ? 0 : 1) - (b.label ? 0 : 1) || `${a.r.category ?? ""}${a.r.title}`.localeCompare(`${b.r.category ?? ""}${b.r.title}`));
  }, [allRows, query, os]);

  const edit = (r: KeybindingRow) => {
    if (locked) return;
    setEditing(r);
  };

  return (
    <div className="tm-shortcuts">
      <div className="tm-settings-header">
        <div className="tm-input-box tm-settings-search">
          <Codicon name="search" className="tm-input-leading" />
          <input className="tm-input" placeholder="Type to search in keybindings" aria-label="Search keybindings" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        </div>
        <p className="tm-muted tm-shortcuts-hint" data-testid="shortcuts-hint">
          {locked ?? "Double-click a row to change its shortcut."}
        </p>
      </div>
      <div className="tm-shortcuts-table tm-scroll" role="table" aria-label="Keyboard shortcuts">
        <div className="tm-shortcuts-row is-head" role="row">
          <span role="columnheader">Command</span>
          <span role="columnheader">Keybinding</span>
          <span role="columnheader">Source</span>
          <span role="columnheader">Command ID</span>
        </div>
        {rows.map(({ r, label }) => (
          <div
            key={r.id}
            className={`tm-shortcuts-row ${r.source === "User" ? "is-user" : ""}`}
            role="row"
            tabIndex={0}
            data-command={r.id}
            onDoubleClick={() => edit(r)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.target === e.currentTarget) {
                e.preventDefault();
                edit(r);
              }
            }}
          >
            <span role="cell" className="tm-shortcuts-cmd">
              <span className="tm-shortcuts-actions">
                <button type="button" className="tm-action" aria-label="Change Keybinding" title={locked ?? "Change Keybinding"} disabled={!!locked} onClick={() => edit(r)}>
                  <Codicon name="edit" />
                </button>
                {r.source === "User" && (
                  <button type="button" className="tm-action" aria-label="Reset Keybinding" title={locked ?? "Reset Keybinding"} disabled={!!locked} onClick={() => setUserKeybinding(r.id, null)}>
                    <Codicon name="discard" />
                  </button>
                )}
              </span>
              {r.category && <span className="tm-muted">{r.category}: </span>}
              {r.title}
            </span>
            <span role="cell">
              {label.split(" ").filter(Boolean).map((k, ki) => (
                <kbd key={ki}>{k}</kbd>
              ))}
            </span>
            <span role="cell" className="tm-muted">
              {r.source}
            </span>
            <span role="cell" className="tm-muted tm-mono">
              {r.id}
            </span>
          </div>
        ))}
      </div>
      {editing && <KeyRecorder row={editing} rows={allRows} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** "Press desired key combination and then press Enter", with conflicts listed as you type. */
function KeyRecorder({ row, rows, onClose }: { row: KeybindingRow; rows: KeybindingRow[]; onClose: () => void }) {
  const os = getPlatform().os;
  const [chords, setChords] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const before = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  useEffect(() => {
    suspendKeybindings(true);
    ref.current?.focus();
    const back = before.current;
    return () => {
      suspendKeybindings(false);
      if (back?.isConnected) back.focus();
    };
  }, []);
  const kb = chords.join(" ");
  const conflicts = useMemo(() => {
    const ids = findConflicts(kb, rows, os, row.id);
    return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
  }, [kb, rows, os, row.id]);

  const save = () => {
    if (!kb) return;
    if (setUserKeybinding(row.id, kb)) onClose();
  };

  return (
    <div className="tm-dialog-backdrop" onMouseDown={onClose}>
      <div className="tm-dialog tm-key-recorder" role="dialog" aria-label={`Change keybinding for ${row.title}`} onMouseDown={(e) => e.stopPropagation()}>
        <p className="tm-key-recorder-title">{row.category ? `${row.category}: ${row.title}` : row.title}</p>
        <p className="tm-muted">Press the keys you want, then Enter. Escape cancels.</p>
        <div
          ref={ref}
          tabIndex={0}
          className="tm-input tm-key-recorder-box"
          data-testid="key-recorder"
          aria-live="polite"
          onKeyDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
            if (e.key === "Escape" && plain) return onClose();
            if (e.key === "Enter" && plain && chords.length) return save();
            const c = chordOf(e.nativeEvent, os);
            if (!c) return;
            // Up to two steps (⌘K ⌘T); a third key starts again.
            setChords((cur) => (cur.length >= 2 ? [c] : [...cur, c]));
          }}
        >
          {kb ? formatKeybinding(kb, os).split(" ").map((k, ki) => <kbd key={ki}>{k}</kbd>) : <span className="tm-muted">Waiting for keys…</span>}
        </div>
        {kb && (
          <p className={conflicts.length ? "tm-key-recorder-conflict" : "tm-muted"} data-testid="key-conflicts">
            {conflicts.length === 0
              ? "No other command uses this shortcut."
              : `Also used by ${conflicts
                  .slice(0, 3)
                  .map((r) => (r.category ? `${r.category}: ${r.title}` : r.title))
                  .join(", ")}${conflicts.length > 3 ? ` and ${conflicts.length - 3} more` : ""}.`}
          </p>
        )}
        <div className="tm-dialog-buttons">
          <button type="button" className="tm-button tm-button--secondary" onClick={() => setUserKeybinding(row.id, "") && onClose()}>
            Remove Shortcut
          </button>
          <button type="button" className="tm-button tm-button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="tm-button" disabled={!kb} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
