import { useEffect, useState } from "react";
import { executeCommand, formatKeybinding, getCommand, isEnabled, keybindingFor } from "../commands/registry";
import { closeContextMenu, getPlatform, openContextMenu, useWorkbench, type ContextMenuItem } from "../state/store";
import { ActionButton, Codicon } from "../widgets/icons";
import { Logo } from "../widgets/Logo";
import { ExamTitle } from "../exam/ExamViews";
import { useExam } from "../exam/state";

type MenuSpec = (string | "-")[];

/** Top-level menus, as command ids ("-" = separator). Mirrors VS Code's menu bar. */
const MENUS: { label: string; items: MenuSpec }[] = [
  {
    label: "File",
    items: [
      "explorer.newFile",
      "explorer.newFolder",
      "-",
      "workbench.action.files.openFile",
      "workbench.action.files.openFolder",
      "-",
      "workbench.action.files.save",
      "workbench.action.files.saveAll",
      "-",
      "workbench.action.openSettings",
      "workbench.action.selectTheme",
      "-",
      "workbench.action.closeActiveEditor",
      "workbench.action.closeFolder",
    ],
  },
  {
    label: "Edit",
    items: ["undo", "redo", "-", "actions.find", "editor.action.startFindReplaceAction", "workbench.view.search", "-", "editor.action.commentLine", "editor.action.formatDocument"],
  },
  {
    label: "View",
    items: [
      "workbench.action.showCommands",
      "-",
      "workbench.view.explorer",
      "workbench.view.search",
      "-",
      "workbench.actions.view.problems",
      "workbench.action.output.toggleOutput",
      "workbench.action.terminal.toggleTerminal",
      "-",
      "workbench.action.toggleSidebarVisibility",
      "workbench.action.togglePanel",
      "workbench.action.splitEditor",
      "workbench.action.toggleZenMode",
      "-",
      "editor.action.toggleWordWrap",
      "editor.action.toggleMinimap",
      "editor.action.fontZoomIn",
      "editor.action.fontZoomOut",
    ],
  },
  { label: "Go", items: ["workbench.action.quickOpen", "workbench.action.gotoLine", "editor.action.revealDefinition"] },
  {
    label: "Terminal",
    items: [
      "workbench.action.terminal.new",
      "workbench.action.terminal.toggleTerminal",
      "-",
      "workbench.action.tasks.runTask",
      "workbench.action.terminal.runRecentCommand",
      "workbench.action.terminal.focusFind",
      "-",
      "simpleBrowser.show",
    ],
  },
  {
    label: "Help",
    items: [
      "workbench.action.openWelcome",
      "workbench.action.showCommands",
      "workbench.action.keybindingsReference",
      "tmcode.checkMyComputer",
      "-",
      "update.checkForUpdates",
      "update.restartToUpdate",
      "-",
      "workbench.action.showAbout",
    ],
  },
];

function menuItems(spec: MenuSpec): ContextMenuItem[] {
  const os = getPlatform().os;
  const out: ContextMenuItem[] = [];
  for (const id of spec) {
    if (id === "-") {
      if (out.length && out[out.length - 1].kind !== "separator") out.push({ kind: "separator" });
      continue;
    }
    const cmd = getCommand(id);
    if (!cmd) continue;
    out.push({
      kind: "item",
      label: cmd.title,
      keybinding: formatKeybinding(keybindingFor(cmd, os), os),
      disabled: !isEnabled(cmd),
      run: () => executeCommand(id),
    });
  }
  if (out[out.length - 1]?.kind === "separator") out.pop();
  return out;
}

/** Narrow windows: one ☰ button listing the menus (each opens its items). */
function MenuButton() {
  return (
    <button
      type="button"
      data-menu-anchor
      className="tm-action tm-menu-button"
      aria-label="Application Menu"
      title="Application Menu"
      aria-haspopup="menu"
      onMouseDown={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        openContextMenu(
          r.left,
          r.bottom,
          MENUS.map((m) => ({
            kind: "item" as const,
            label: `${m.label}  ›`,
            run: () => setTimeout(() => openContextMenu(r.left, r.bottom, menuItems(m.items)), 0),
          })),
        );
      }}
    >
      <Codicon name="menu" />
    </button>
  );
}

function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const menuOpen = useWorkbench((s) => !!s.contextMenu);
  useEffect(() => {
    if (!menuOpen) setOpen(null);
  }, [menuOpen]);

  const show = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setOpen(i);
    openContextMenu(r.left, r.bottom, menuItems(MENUS[i].items));
  };

  return (
    <div className="tm-menubar" role="menubar">
      {MENUS.map((m, i) => (
        <button
          key={m.label}
          type="button"
          role="menuitem"
          data-menu-anchor
          aria-haspopup="menu"
          aria-expanded={open === i}
          className={`tm-menubar-item ${open === i ? "is-open" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            if (open === i) {
              closeContextMenu();
              setOpen(null);
            } else show(i, e.currentTarget);
          }}
          onMouseEnter={(e) => open !== null && open !== i && show(i, e.currentTarget)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") && show(i, e.currentTarget)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function WindowControls() {
  const win = getPlatform().window;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!win) return;
    void win.isMaximized().then(setMaximized);
    return win.onMaximizedChange(setMaximized);
  }, [win]);
  if (!win) return null;
  return (
    <div className="tm-window-controls">
      <button type="button" className="tm-window-control" aria-label="Minimize" title="Minimize" onClick={() => win.minimize()}>
        <Codicon name="chrome-minimize" />
      </button>
      <button type="button" className="tm-window-control" aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"} onClick={() => win.toggleMaximize()}>
        <Codicon name={maximized ? "chrome-restore" : "chrome-maximize"} />
      </button>
      <button type="button" className="tm-window-control is-close" aria-label="Close" title="Close" onClick={() => win.close()}>
        <Codicon name="chrome-close" />
      </button>
    </div>
  );
}

export function TitleBar({ focused }: { focused: boolean }) {
  const platform = getPlatform();
  const workspace = useWorkbench((s) => s.workspace);
  const sidebarVisible = useWorkbench((s) => s.sidebarVisible);
  const panelVisible = useWorkbench((s) => s.panelVisible);
  const inExam = useExam((s) => !!s.quiz);
  const compact = useWorkbench((s) => s.viewport === "xs" || s.viewport === "sm");
  const os = platform.os;
  const nativeMenus = platform.kind === "desktop" && os === "mac";
  const kb = (id: string) => {
    const cmd = getCommand(id);
    return cmd ? formatKeybinding(keybindingFor(cmd, os), os) : "";
  };

  return (
    <header className={`tm-titlebar ${focused ? "" : "is-inactive"} ${os === "mac" && platform.kind === "desktop" ? "has-traffic-lights" : ""}`} data-tauri-drag-region>
      <div className="tm-titlebar-left" data-tauri-drag-region>
        {!nativeMenus && (
          <>
            <Logo size={16} className="tm-app-icon" />
            {compact ? <MenuButton /> : <MenuBar />}
          </>
        )}
      </div>
      <div className="tm-titlebar-center" data-tauri-drag-region>
        {inExam ? <ExamTitle /> : (
        <button
          type="button"
          className="tm-command-center"
          onClick={() => executeCommand(workspace ? "workbench.action.quickOpen" : "workbench.action.showCommands")}
          title={workspace ? `Search ${workspace.name} (${kb("workbench.action.quickOpen")})` : `Show All Commands (${kb("workbench.action.showCommands")})`}
        >
          <Codicon name="search" />
          <span>{workspace ? workspace.name : "TMCode"}</span>
        </button>
        )}
      </div>
      <div className="tm-titlebar-right" data-tauri-drag-region>
        <ActionButton
          icon={sidebarVisible ? "layout-sidebar-left" : "layout-sidebar-left-off"}
          label={`Toggle Primary Side Bar (${kb("workbench.action.toggleSidebarVisibility")})`}
          active={sidebarVisible}
          onClick={() => executeCommand("workbench.action.toggleSidebarVisibility")}
        />
        <ActionButton
          icon={panelVisible ? "layout-panel" : "layout-panel-off"}
          label={`Toggle Panel (${kb("workbench.action.togglePanel")})`}
          active={panelVisible}
          onClick={() => executeCommand("workbench.action.togglePanel")}
        />
        <WindowControls />
      </div>
    </header>
  );
}
