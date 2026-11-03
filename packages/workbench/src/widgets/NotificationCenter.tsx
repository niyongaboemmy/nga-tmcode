import { useEffect, useMemo, useRef, useState } from "react";
import { dismissNotification, useWorkbench } from "../state/store";
import { clearAllNotifications, clearNotification, keptActions, markAllAsRead, showNotificationCenter, toggleDoNotDisturb, unreadCount, useNotificationCenter } from "../state/notificationCenter";
import { Codicon } from "./icons";

/** Entries drawn at a time; "Show more" adds the next page (a long history stays light). */
export const NC_PAGE = 30;

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Notifications: Show Notifications — this session's notifications, newest first (bell in the status bar). */
export function NotificationCenter() {
  const open = useNotificationCenter((s) => s.open);
  const dnd = useNotificationCenter((s) => s.dnd);
  const history = useNotificationCenter((s) => s.history);
  const live = useWorkbench((s) => s.notifications);
  const ref = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState(1);
  const liveById = useMemo(() => new Map(live.map((n) => [n.id, n])), [live]);

  useEffect(() => {
    if (!open) return;
    setPages(1);
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
        {unreadCount(history) > 0 && (
          <button type="button" className="tm-action" title="Mark All as Read" aria-label="Mark All as Read" onClick={markAllAsRead} data-testid="notifications-mark-read">
            <Codicon name="check-all" />
          </button>
        )}
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
        {history.slice(0, pages * NC_PAGE).map((h) => {
          const n = liveById.get(h.id);
          return (
            <div key={h.id} className={`tm-nc-item is-${h.severity} ${n ? "" : "is-closed"} ${h.unread ? "is-unread" : ""}`} data-testid="notification-entry">
              <Codicon name={h.severity === "error" ? "error" : h.severity === "warning" ? "warning" : "info"} className={`tm-toast-icon is-${h.severity}`} />
              <div className="tm-nc-message">
                {h.message}
                <span className="tm-nc-time">{time(h.time)}</span>
              </div>
              <button type="button" className="tm-action" title="Clear Notification" aria-label="Clear Notification" onClick={() => clearNotification(h.id)}>
                <Codicon name="close" />
              </button>
              {(() => {
                // Open toasts: all their buttons. Closed ones: the buttons that are still valid (N8).
                const actions = n?.actions?.length ? n.actions : keptActions(h.id);
                if (!actions.length) return null;
                return (
                  <div className="tm-toast-actions">
                    {actions.map((a) => (
                      <button
                        key={a.label}
                        type="button"
                        className="tm-button"
                        data-testid="notification-entry-action"
                        onClick={() => {
                          if (n) dismissNotification(n.id);
                          a.run();
                        }}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
          );
        })}
        {history.length > pages * NC_PAGE && (
          <button type="button" className="tm-link-button tm-nc-more" onClick={() => setPages(pages + 1)} data-testid="notifications-show-more">
            Show {Math.min(NC_PAGE, history.length - pages * NC_PAGE)} more ({history.length - pages * NC_PAGE} older)
          </button>
        )}
      </div>
    </div>
  );
}
