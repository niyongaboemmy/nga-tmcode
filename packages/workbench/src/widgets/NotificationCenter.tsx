import { useEffect, useRef } from "react";
import { dismissNotification, useWorkbench } from "../state/store";
import { clearAllNotifications, clearNotification, showNotificationCenter, toggleDoNotDisturb, useNotificationCenter } from "../state/notificationCenter";
import { Codicon } from "./icons";

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Notifications: Show Notifications — this session's notifications, newest first (bell in the status bar). */
export function NotificationCenter() {
  const open = useNotificationCenter((s) => s.open);
  const dnd = useNotificationCenter((s) => s.dnd);
  const history = useNotificationCenter((s) => s.history);
  const live = useWorkbench((s) => s.notifications);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") showNotificationCenter(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div ref={ref} className="tm-notification-center" role="dialog" aria-label="Notifications" tabIndex={-1} data-testid="notification-center">
      <div className="tm-nc-header">
        <span className="tm-nc-title">{history.length ? "Notifications" : "No New Notifications"}</span>
        <button type="button" className="tm-action" title="Clear All Notifications" aria-label="Clear All Notifications" onClick={clearAllNotifications}>
          <Codicon name="clear-all" />
        </button>
        <button
          type="button"
          className={`tm-action ${dnd ? "is-checked" : ""}`}
          title={dnd ? "Turn Off Do Not Disturb" : "Toggle Do Not Disturb Mode"}
          aria-label="Toggle Do Not Disturb Mode"
          aria-pressed={dnd}
          onClick={toggleDoNotDisturb}
        >
          <Codicon name={dnd ? "bell-slash" : "bell"} />
        </button>
        <button type="button" className="tm-action" title="Hide Notifications" aria-label="Hide Notifications" onClick={() => showNotificationCenter(false)}>
          <Codicon name="chevron-down" />
        </button>
      </div>
      <div className="tm-nc-list">
        {history.map((h) => {
          const n = live.find((x) => x.id === h.id);
          return (
            <div key={h.id} className={`tm-nc-item is-${h.severity} ${n ? "" : "is-closed"}`} data-testid="notification-entry">
              <Codicon name={h.severity === "error" ? "error" : h.severity === "warning" ? "warning" : "info"} className={`tm-toast-icon is-${h.severity}`} />
              <div className="tm-nc-message">
                {h.message}
                <span className="tm-nc-time">{time(h.time)}</span>
              </div>
              <button type="button" className="tm-action" title="Clear Notification" aria-label="Clear Notification" onClick={() => clearNotification(h.id)}>
                <Codicon name="close" />
              </button>
              {n?.actions?.length ? (
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
          );
        })}
      </div>
    </div>
  );
}
