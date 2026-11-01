import { useEffect, useLayoutEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { renderMarkdown } from "./markdown";
import { closeContextMenu, dismissNotification, pauseToast, resumeToast, useWorkbench, type Notification } from "../state/store";
import { Codicon } from "./icons";
import { markRead, showNotificationCenter, useNotificationCenter, visibleToasts } from "../state/notificationCenter";
import { MAX_VISIBLE_TOASTS } from "../state/notifications";
import { useExam } from "../exam/state";

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
              role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={it.checked}
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
              {menu.items.some((x) => x.kind === "item" && x.checked !== undefined) && (
                <span className="tm-menu-check" aria-hidden>
                  {it.checked && <Codicon name="check" />}
                </span>
              )}
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
            {dialog.detail &&
              (dialog.markdown ? (
                <div id="tm-dialog-detail" className="tm-dialog-detail tm-dialog-md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderMarkdown(dialog.detail)) }} />
              ) : (
                <p id="tm-dialog-detail" className="tm-dialog-detail">
                  {dialog.detail}
                </p>
              ))}
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
  const examActive = useExam((s) => !!s.quiz && (s.phase === "active" || s.phase === "locked" || s.phase === "submitting"));
  const list = visibleToasts(all, dnd, examActive).filter((n) => !n.silent);
  // Work mode: a brief or grading tab beside the code. The toasts sit over the CODE column, never over
  // the brief or the grade panel (where the main button is).
  const codeGroup = useWorkbench((s) => {
    const side = (g: (typeof s.groups)[number]) => g.editors.some((e) => e.id === g.activeId && (e.kind === "assignment" || e.kind === "grading"));
    if (s.groups.length < 2 || !s.groups.some(side)) return null;
    return s.groups.find((g) => !side(g))?.id ?? null;
  });
  const [place, setPlace] = useState<{ right: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (codeGroup === null || !list.length) return setPlace(null);
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-group="${codeGroup}"]`);
      if (!el) return setPlace(null);
      const r = el.getBoundingClientRect();
      setPlace({ right: Math.max(12, window.innerWidth - r.right + 12), width: Math.max(240, Math.min(450, r.width - 24)) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [codeGroup, list.length]);
  // The centre shows them while it is open, as VS Code's does.
  if (!list.length || centreOpen) return null;
  // The newest few; the rest wait in the centre ("+2 more").
  const shown = list.slice(-MAX_VISIBLE_TOASTS);
  const hidden = list.length - shown.length;
  return (
    <div className="tm-toasts" style={place ? { right: place.right, width: place.width } : undefined} data-placement={place ? "code" : "corner"} role="region" aria-label="Notifications" aria-live="polite">
      {hidden > 0 && (
        <button type="button" className="tm-toast-more" onClick={() => showNotificationCenter(true)} data-testid="toast-more">
          +{hidden} more
        </button>
      )}
      {shown.map((n) => (
        <Toast key={n.id} n={n} />
      ))}
    </div>
  );
}

/** One toast: its time stops while the pointer is over it or it has the focus. */
function Toast({ n }: { n: Notification }) {
  const [details, setDetails] = useState(false);
  const close = () => {
    markRead(n.id);
    dismissNotification(n.id);
  };
  return (
    <div
      className={`tm-toast is-${n.severity}`}
      role={n.severity === "error" ? "alert" : "status"}
      data-kind={n.kind}
      data-important={n.important ? "true" : undefined}
      onMouseEnter={() => pauseToast(n.id)}
      onMouseLeave={() => resumeToast(n.id)}
      onFocus={() => pauseToast(n.id)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && resumeToast(n.id)}
    >
      <Codicon name={n.severity === "error" ? "error" : n.severity === "warning" ? "warning" : "info"} className={`tm-toast-icon is-${n.severity}`} />
      <div className="tm-toast-message">
        {n.message}
        {n.details && (
          <>
            {" "}
            <button type="button" className="tm-link-button tm-toast-details-toggle" aria-expanded={details} onClick={() => setDetails(!details)} data-testid="toast-details-toggle">
              {details ? "Hide Details" : "Details"}
            </button>
            {details && (
              <pre className="tm-toast-details" data-testid="toast-details">
                {n.details}
              </pre>
            )}
          </>
        )}
      </div>
      <button type="button" className="tm-action" aria-label="Clear Notification" title="Clear Notification" onClick={close}>
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
      {n.actions?.length || n.undo ? (
        <div className="tm-toast-actions">
          {n.undo && (
            <button
              type="button"
              className="tm-button tm-button--secondary"
              data-testid="toast-undo"
              onClick={() => {
                close();
                n.undo?.();
              }}
            >
              Undo
            </button>
          )}
          {n.actions?.map((a) => (
            <button
              key={a.label}
              type="button"
              className="tm-button"
              onClick={() => {
                close();
                a.run();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
