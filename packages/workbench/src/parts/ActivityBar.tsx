import { executeCommand, formatKeybinding, getCommand, keybindingFor } from "../commands/registry";
import { getPlatform, openContextMenu, showView, useWorkbench, type ViewId } from "../state/store";
import { Codicon } from "../widgets/icons";

const VIEWS: { id: ViewId; icon: string; label: string; command: string }[] = [
  { id: "explorer", icon: "files", label: "Explorer", command: "workbench.view.explorer" },
  { id: "search", icon: "search", label: "Search", command: "workbench.view.search" },
];

export function ActivityBar() {
  const activeView = useWorkbench((s) => s.activeView);
  const sidebarVisible = useWorkbench((s) => s.sidebarVisible);
  const dirtyCount = useWorkbench((s) => Object.keys(s.dirty).length);
  const os = getPlatform().os;

  const label = (v: (typeof VIEWS)[number]) => {
    const cmd = getCommand(v.command);
    const kb = cmd ? formatKeybinding(keybindingFor(cmd, os), os) : "";
    return kb ? `${v.label} (${kb})` : v.label;
  };

  return (
    <nav className="tm-activitybar" aria-label="Active View Switcher">
      <div className="tm-activitybar-top" role="tablist" aria-orientation="vertical">
        {VIEWS.map((v) => {
          const active = sidebarVisible && activeView === v.id;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`tm-activity ${active ? "is-active" : ""}`}
              title={label(v)}
              aria-label={label(v)}
              onClick={() => showView(v.id)}
            >
              <Codicon name={v.icon} />
              {v.id === "explorer" && dirtyCount > 0 && <span className="tm-activity-badge">{dirtyCount}</span>}
            </button>
          );
        })}
      </div>
      <div className="tm-activitybar-bottom">
        <button
          type="button"
          className="tm-activity"
          title="Manage"
          aria-label="Manage"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openContextMenu(r.right + 4, r.bottom - 8, [
              { kind: "item", label: "Command Palette...", keybinding: formatKeybinding("mod+shift+p", os), run: () => executeCommand("workbench.action.showCommands") },
              { kind: "separator" },
              { kind: "item", label: "Settings", keybinding: formatKeybinding("mod+,", os), run: () => executeCommand("workbench.action.openSettings") },
              { kind: "item", label: "Keyboard Shortcuts", keybinding: formatKeybinding("mod+k mod+s", os), run: () => executeCommand("workbench.action.keybindingsReference") },
              { kind: "separator" },
              { kind: "item", label: "Themes", keybinding: formatKeybinding("mod+k mod+t", os), run: () => executeCommand("workbench.action.selectTheme") },
            ]);
          }}
        >
          <Codicon name="settings-gear" />
        </button>
      </div>
    </nav>
  );
}
