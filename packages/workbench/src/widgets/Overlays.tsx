import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { closeContextMenu, dismissNotification, useWorkbench } from "../state/store";
import { Codicon } from "./icons";
import { useNotificationCenter, visibleToasts } from "../state/notificationCenter";

export function ContextMenu() {
  const menu = useWorkbench((s) => s.contextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [focus, setFocus] = useState(-1);

  // Keep the menu on screen.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - r.width - 4);
    const y = menu.y + r.height > window.innerHeight - 4 ? Math.max(4, menu.y - r.height) : menu.y;
    setPos({ x: Math.max(4, x), y });
    setFocus(-1);
    ref.current.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => closeContextMenu();
    // Outside clicks close the menu; menu-bar buttons manage their own menus (hover-to-switch).
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".tm-menu, [data-menu-anchor]")) closeContextMenu();
    };
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [menu]);

  if (!menu) return null;
  const actionable = menu.items.map((it, i) => (it.kind === "item" && !it.disabled ? i : -1)).filter((i) => i >= 0);

  return (
    <>
      <div
        ref={ref}
        className="tm-menu"
        role="menu"
        tabIndex={-1}
        style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? "visible" : "hidden" }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          const at = actionable.indexOf(focus);
          if (e.key === "ArrowDown") setFocus(actionable[(at + 1) % actionable.length]);
          else if (e.key === "ArrowUp") setFocus(actionable[(at - 1 + actionable.length) % actionable.length]);
          else if (e.key === "Escape") closeContextMenu();
          else if (e.key === "Enter" && focus >= 0) {
            const it = menu.items[focus];
            if (it.kind === "item") {
              closeContextMenu();
              it.run();
            }
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {menu.items.map((it, i) =>
          it.kind === "separator" ? (
            <div key={i} className="tm-menu-separator" role="separator" />
          ) : (
            <div
              key={i}
              role="menuitem"
              aria-disabled={it.disabled}
              className={`tm-menu-item ${focus === i ? "is-focused" : ""} ${it.disabled ? "is-disabled" : ""} ${it.danger ? "is-danger" : ""}`}
              onMouseEnter={() => !it.disabled && setFocus(i)}
              onMouseLeave={() => setFocus(-1)}
              onClick={() => {
                if (it.disabled) return;
                closeContextMenu();
                it.run();
              }}
            >
              <span className="tm-menu-label">{it.label}</span>
              {it.keybinding && <span className="tm-menu-kb">{it.keybinding}</span>}
            </div>
          ),
        )}
      </div>
    </>
  );
}

export function Dialog() {
  const dialog = useWorkbench((s) => s.dialog);
  const boxRef = useRef<HTMLDivElement>(null);
  // Focus the default button: the primary one, or Cancel when the primary one is destructive.
  // Focus goes back where it was when the dialog closes.
  useEffect(() => {
    if (!dialog) return;
    const before = document.activeElement as HTMLElement | null;
    const id = dialog.buttons.some((b) => b.primary && b.destructive) ? dialog.cancelId : (dialog.buttons.find((b) => b.primary)?.id ?? dialog.cancelId);
    boxRef.current?.querySelector<HTMLButtonElement>(`[data-dialog-button="${CSS.escape(id)}"]`)?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, [dialog]);
  if (!dialog) return null;
  return (
    <div className="tm-dialog-backdrop" onMouseDown={() => dialog.resolve(dialog.cancelId)}>
      <div
        ref={boxRef}
        className="tm-dialog"
        role="alertdialog"
        aria-modal
        aria-labelledby="tm-dialog-msg"
        aria-describedby="tm-dialog-detail"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            dialog.resolve(dialog.cancelId);
          } else if (e.key === "Tab") {
            // Keep focus inside the dialog.
            const buttons = [...(boxRef.current?.querySelectorAll<HTMLButtonElement>("[data-dialog-button]") ?? [])];
            if (!buttons.length) return;
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
            e.preventDefault();
            buttons[next].focus();
          }
        }}
      >
        <div className="tm-dialog-body">
          <Codicon name={dialog.severity === "warning" ? "warning" : "info"} className={`tm-dialog-icon is-${dialog.severity ?? "info"}`} />
          <div>
            <p id="tm-dialog-msg" className="tm-dialog-message">
              {dialog.message}
            </p>
            {dialog.detail && (
              <p id="tm-dialog-detail" className="tm-dialog-detail">
                {dialog.detail}
              </p>
            )}
          </div>
        </div>
        <div className="tm-dialog-buttons">
          {dialog.buttons.map((b) => (
            <button
              key={b.id}
              data-dialog-button={b.id}
              type="button"
              className={`tm-button ${b.primary ? "" : "tm-button--secondary"}`}
              onClick={() => dialog.resolve(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Notifications() {
  const all = useWorkbench((s) => s.notifications);
  const dnd = useNotificationCenter((s) => s.dnd);
  const centreOpen = useNotificationCenter((s) => s.open);
  const list = visibleToasts(all, dnd);
  // The centre shows them while it is open, as VS Code's does.
  if (!list.length || centreOpen) return null;
  return (
    <div className="tm-toasts" role="region" aria-label="Notifications" aria-live="polite">
      {list.map((n) => (
        <div key={n.id} className={`tm-toast is-${n.severity}`} role={n.severity === "error" ? "alert" : "status"}>
          <Codicon name={n.severity === "error" ? "error" : n.severity === "warning" ? "warning" : "info"} className={`tm-toast-icon is-${n.severity}`} />
          <div className="tm-toast-message">{n.message}</div>
          <button type="button" className="tm-action" aria-label="Clear Notification" title="Clear Notification" onClick={() => dismissNotification(n.id)}>
            <Codicon name="close" />
          </button>
          {n.progress !== undefined && (
            <div
              className={`tm-toast-progress ${n.progress === null ? "is-infinite" : ""}`}
              role="progressbar"
              aria-label={n.message}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={n.progress ?? undefined}
            >
              <span style={n.progress === null ? undefined : { width: `${n.progress}%` }} />
            </div>
          )}
          {n.cancel && (
            <div className="tm-toast-actions">
              <button
                type="button"
                className="tm-button tm-button--secondary"
                onClick={() => {
                  n.cancel?.();
                  dismissNotification(n.id);
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {n.actions?.length ? (
            <div className="tm-toast-actions">
              {n.actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className="tm-button"
                  onClick={() => {
                    dismissNotification(n.id);
                    a.run();
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
