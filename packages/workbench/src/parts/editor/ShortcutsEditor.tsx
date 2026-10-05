import { useMemo, useState } from "react";
import { allCommands, executeCommand, formatKeybinding, keybindingFor } from "../../commands/registry";
import { getPlatform } from "../../state/store";
import { Codicon } from "../../widgets/icons";

/** Read-only keyboard shortcuts reference (rebinding is out of scope for exams). */
export function ShortcutsEditor() {
  const os = getPlatform().os;
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.toLowerCase();
    return allCommands()
      .filter((c) => !c.hidden)
      .map((c) => ({ cmd: c, kb: formatKeybinding(keybindingFor(c, os), os) }))
      .filter(({ cmd, kb }) => !q || `${cmd.category ?? ""} ${cmd.title} ${cmd.id} ${kb}`.toLowerCase().includes(q))
      .sort((a, b) => (a.kb ? 0 : 1) - (b.kb ? 0 : 1) || `${a.cmd.category}${a.cmd.title}`.localeCompare(`${b.cmd.category}${b.cmd.title}`));
  }, [query, os]);

  return (
    <div className="tm-shortcuts">
      <div className="tm-settings-header">
        <div className="tm-input-box tm-settings-search">
          <Codicon name="search" className="tm-input-leading" />
          <input className="tm-input" placeholder="Type to search in keybindings" aria-label="Search keybindings" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        </div>
      </div>
      <div className="tm-shortcuts-table tm-scroll" role="table" aria-label="Keyboard shortcuts">
        <div className="tm-shortcuts-row is-head" role="row">
          <span role="columnheader">Command</span>
          <span role="columnheader">Keybinding</span>
          <span role="columnheader">Command ID</span>
        </div>
        {rows.map(({ cmd, kb }) => (
          <div key={cmd.id} className="tm-shortcuts-row" role="row" onDoubleClick={() => executeCommand(cmd.id)} title="Double-click to run">
            <span role="cell">
              {cmd.category && <span className="tm-muted">{cmd.category}: </span>}
              {cmd.title}
            </span>
            <span role="cell">
              {kb.split(" ").filter(Boolean).map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </span>
            <span role="cell" className="tm-muted tm-mono">
              {cmd.id}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
