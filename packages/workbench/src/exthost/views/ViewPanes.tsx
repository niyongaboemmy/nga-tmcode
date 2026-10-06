import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { getPlatform, openContextMenu } from "../../state/store";
import { ActionButton, Codicon } from "../../widgets/icons";
import { useExtHost } from "../state";
import { useContextVersion } from "../state";
import { activateByEvent, executeExtensionCommand } from "../hostService";
import { ExtIcon, commandIcon } from "./ExtIcon";
import { ExtTreeView } from "./TreeView";
import { setViewOpen, titleActions, useViews, useVisibleViews, viewOpen, whenFor, type ContributedView } from "./model";
import { collapseAll, getTree, setTreeVisible, useTree, useTreeRegistry } from "./trees";
import { WebviewSlot } from "./WebviewSlot";
import { ensureWebviewView, useWebviewViewProviders, useWebviews } from "./webviews";

/**
 * Side bar panes for extension views: a collapsible section per view (as
 * TMCode's Outline and Timeline), with the view's `view/title` actions, its
 * badge and description, and its content: a tree view, a webview view, or
 * its `viewsWelcome` content while it is empty. Showing a view fires
 * `onView:<id>`.
 */

/** `[Label](command:x)` alone on a line is a button; other links are inline. */
function WelcomeContent({ view, fallback = null }: { view: ContributedView; fallback?: ReactNode }) {
  const welcome = useViews((s) => s.welcome);
  useContextVersion((s) => s.v);
  const items = welcome.filter((w) => w.view === view.id && whenFor(w.when));
  if (!items.length) return <>{fallback}</>;
  const run = (href: string) => {
    const m = /^command:([\w.\-:]+)(?:\?(.*))?$/.exec(href);
    if (m) {
      let args: unknown[] = [];
      try {
        if (m[2]) args = [JSON.parse(decodeURIComponent(m[2]))].flat();
      } catch {
        /* none */
      }
      void executeExtensionCommand(m[1], args);
    } else if (/^https?:/.test(href)) void getPlatform().openExternal?.(href);
  };
  const inline = (text: string, key: number): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let at = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push(text.slice(at, m.index));
      const href = m[2];
      out.push(
        <a
          key={`${key}-${m.index}`}
          href={href}
          onClick={(e) => {
            e.preventDefault();
            run(href);
          }}
        >
          {m[1]}
        </a>,
      );
      at = m.index + m[0].length;
    }
    out.push(text.slice(at));
    return out;
  };
  return (
    <div className="tm-view-empty tm-ext-welcome">
      {items.map((w, i) => (
        <Fragment key={i}>
          {w.contents.split("\n").map((line, j) => {
            const button = /^\s*\[([^\]]+)\]\((command:[^)\s]+|https?:[^)\s]+)\)\s*$/.exec(line);
            if (button) {
              return (
                <button key={j} type="button" className="tm-button tm-button--block tm-ext-welcome-button" onClick={() => run(button[2])}>
                  {button[1].replace(/\$\([\w-]+\)\s*/g, "")}
                </button>
              );
            }
            return line.trim() ? <p key={j}>{inline(line.replace(/\$\([\w-]+\)\s*/g, ""), j)}</p> : null;
          })}
        </Fragment>
      ))}
    </div>
  );
}

function TitleActions({ view }: { view: ContributedView }) {
  useContextVersion((s) => s.v);
  useTree(view.id);
  const actions = titleActions(view.id);
  const t = getTree(view.id);
  const nav = actions.filter((a) => a.group === "navigation");
  const more = actions.filter((a) => a.group !== "navigation");
  return (
    <div className="tm-pane-actions" onClick={(e) => e.stopPropagation()}>
      {nav.map((a) => {
        const icon = commandIcon(a.cmd.icon, a.cmd.extensionId);
        return (
          <button key={a.cmd.command} type="button" className="tm-action" title={a.cmd.title} aria-label={a.cmd.title} onClick={() => void executeExtensionCommand(a.cmd.command, [])}>
            {icon ? <ExtIcon icon={icon} /> : <span className="tm-ext-action-text">{a.cmd.title}</span>}
          </button>
        );
      })}
      {t?.options.showCollapseAll && <ActionButton icon="collapse-all" label="Collapse All" onClick={() => collapseAll(view.id)} />}
      {more.length > 0 && (
        <ActionButton
          icon="ellipsis"
          label="More Actions..."
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            let group: string | null = null;
            const items: Parameters<typeof openContextMenu>[2] = [];
            for (const a of more) {
              if (group !== null && a.group !== group) items.push({ kind: "separator" });
              group = a.group;
              items.push({ kind: "item", label: a.cmd.title, run: () => void executeExtensionCommand(a.cmd.command, []) });
            }
            openContextMenu(r.left, r.bottom + 2, items);
          }}
        />
      )}
    </div>
  );
}

function TreeBody({ view }: { view: ContributedView }) {
  const registered = useTreeRegistry((s) => !!s.registered[view.id]);
  const meta = useViews((s) => s.meta[view.id]);
  const state = useExtHost((s) => s.runtime[view.extensionId]?.state);
  useEffect(() => {
    if (!registered) return;
    setTreeVisible(view.id, true);
    return () => setTreeVisible(view.id, false);
  }, [registered, view.id]);
  const message = meta?.message ? <div className="tm-view-hint tm-ext-view-message">{meta.message}</div> : null;
  if (!registered) {
    // Activating, or the extension never registered a provider for it.
    if (state === "activated" || state === "failed") return <WelcomeContent view={view} fallback={<div className="tm-view-hint">There is no data provider registered that can provide view data.</div>} />;
    return <div className="tm-ext-progress" aria-label="Loading" />;
  }
  return (
    <>
      {message}
      <ExtTreeView viewId={view.id} empty={<WelcomeContent view={view} />} />
    </>
  );
}

function WebviewViewBody({ view }: { view: ContributedView }) {
  const provider = useWebviewViewProviders((s) => s.providers[view.id]);
  const handle = useWebviews((s) => s.viewHandles[view.id]);
  const state = useExtHost((s) => s.runtime[view.extensionId]?.state);
  useEffect(() => {
    if (provider && !handle) void ensureWebviewView(view.id);
  }, [provider, handle, view.id]);
  if (!handle) {
    if (!provider && (state === "activated" || state === "failed")) return <div className="tm-view-hint">There is no webview view provider registered for this view.</div>;
    return <div className="tm-ext-progress" aria-label="Loading" />;
  }
  return <WebviewSlot handle={handle} className="tm-ext-webview-view" />;
}

export function ExtViewPane({ view, single = false }: { view: ContributedView; single?: boolean }) {
  const open = useViews((s) => single || viewOpen(view, s.open));
  const meta = useViews((s) => s.meta[view.id]);
  const handle = useWebviews((s) => s.viewHandles[view.id]);
  const webMeta = useWebviews((s) => (handle ? s.entries[handle]?.meta : undefined));
  const title = webMeta?.title ?? meta?.title ?? view.name;
  const description = webMeta?.description ?? meta?.description;
  const badge = webMeta?.badge ?? meta?.badge;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open) void activateByEvent(`onView:${view.id}`);
  }, [open, view.id]);
  // view.show() / reveal / `<id>.focus`: open this pane.
  useEffect(() => {
    const onShow = (e: Event) => {
      if ((e as CustomEvent).detail !== view.id) return;
      setViewOpen(view.id, true);
      ref.current?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("tmcode:show-view", onShow);
    return () => window.removeEventListener("tmcode:show-view", onShow);
  }, [view.id]);
  const toggle = () => setViewOpen(view.id, !open);
  return (
    <section ref={ref} className={`tm-pane tm-ext-pane ${open ? "is-open" : "is-collapsed"} ${single ? "is-single" : ""}`} aria-label={title} data-view-id={view.id} data-testid={`ext-view-${view.id}`}>
      {!single && (
        <div className="tm-pane-header" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && toggle()}>
          <Codicon name={open ? "chevron-down" : "chevron-right"} />
          <span className="tm-pane-title">
            {title}
            {description && <span className="tm-pane-desc">{description}</span>}
          </span>
          {badge && badge.value > 0 && (
            <span className="tm-badge" title={badge.tooltip}>
              {badge.value}
            </span>
          )}
          {open && <TitleActions view={view} />}
        </div>
      )}
      {single && (
        <div className="tm-ext-single-actions">
          <TitleActions view={view} />
        </div>
      )}
      {open && <div className="tm-pane-body tm-ext-pane-body">{view.type === "webview" ? <WebviewViewBody view={view} /> : <TreeBody view={view} />}</div>}
    </section>
  );
}

/** The extension views of one container (an extension container, or Explorer / Source Control / Run and Debug / Testing). */
export function ExtViewPanes({ container, fill = false }: { container: string; fill?: boolean }) {
  const views = useVisibleViews(container);
  if (!views.length) return null;
  return (
    <div className={`tm-ext-panes ${fill ? "is-fill" : ""}`} data-container={container}>
      {views.map((v) => (
        <ExtViewPane key={v.id} view={v} single={fill && views.length === 1} />
      ))}
    </div>
  );
}

/** Whether a built-in container has extension views now (for the side bar layout). */
export function useHasExtViews(container: string) {
  return useVisibleViews(container).length > 0;
}
