import { useEffect, useState } from "react";
import { executeCommand, formatKeybinding, getCommand, keybindingFor } from "../commands/registry";
import { inAppMenus, menuItems, type MenuSpec } from "../commands/menus";
import { closeContextMenu, getPlatform, openContextMenu, useWorkbench, type ContextMenuItem } from "../state/store";
import { ActionButton, Codicon } from "../widgets/icons";
import { Logo } from "../widgets/Logo";
import { ExamTitle } from "../exam/ExamViews";
import { useExam } from "../exam/state";

/** The menus come from commands/menus.json, shared with the macOS menu bar (V7). */
const MENUS = inAppMenus();

/**
 * Items for one menu. Focus goes back to what had it before the menu opened, so
 * Undo / Find / Select All act on that (the editor, a text field, the terminal).
 */
let menuOrigin: HTMLElement | null = null;
function itemsFor(menu: MenuSpec): ContextMenuItem[] {
  // Moving from one open menu to the next keeps the original focus.
  const active = document.activeElement as HTMLElement | null;
  if (!active?.closest(".tm-menu")) menuOrigin = active;
  const before = menuOrigin;
  return menuItems(menu, getPlatform().os, () => {
    if (before?.isConnected && before !== document.body) before.focus();
  });
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
            run: () => setTimeout(() => openContextMenu(r.left, r.bottom, itemsFor(m)), 0),
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
    openContextMenu(r.left, r.bottom, itemsFor(MENUS[i]));
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
