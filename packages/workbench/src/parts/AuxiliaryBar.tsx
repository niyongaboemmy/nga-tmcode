import { lazy, Suspense } from "react";
import { useExam } from "../exam/state";
import { ExtViewPanes } from "../exthost/views/ViewPanes";
import { useViews, whenFor, type IconSpec } from "../exthost/views/model";
import { useContextVersion } from "../exthost/state";
import { showAuxiliaryView, toggleAuxiliaryBar, useWorkbench } from "../state/store";
import { ActionButton, Codicon } from "../widgets/icons";
import { ExtIcon } from "../exthost/views/ExtIcon";

const ChatView = lazy(() => import("../ai/ChatView").then((m) => ({ default: m.ChatView })));

/**
 * The secondary side bar (VS Code's auxiliary bar), opposite the primary one: TMCode AI's chat and
 * the views extensions contribute to `viewsContainers.secondarySidebar` (Claude Code's chat).
 * Never during exams: AI and extensions are off then.
 */
export function AuxiliaryBar() {
  const view = useWorkbench((s) => s.auxiliaryView);
  const practice = useWorkbench((s) => s.policy.mode === "practice");
  const inExam = useExam((s) => !!s.quiz);
  useContextVersion((s) => s.v);
  const containers = useViews((s) => s.containers).filter((c) => c.location === "secondarySidebar" && practice && !inExam && whenFor(c.when));
  const tabs: { key: string; title: string; icon: IconSpec }[] = [{ key: "chat", title: "TMCode AI", icon: { codicon: "sparkle" } }, ...containers.map((c) => ({ key: c.key, title: c.title, icon: c.icon }))];
  const current = tabs.find((t) => t.key === view) ?? tabs[0];
  if (inExam || !practice) {
    return (
      <aside className="tm-auxbar" aria-label="Secondary Side Bar">
        <p className="tm-auxbar-off">
          <Codicon name="lock" /> AI and extensions are off during exams.
        </p>
      </aside>
    );
  }
  return (
    <aside className="tm-auxbar" aria-label="Secondary Side Bar" data-testid="auxiliary-bar">
      <header className="tm-auxbar-header">
        <div className="tm-auxbar-tabs" role="tablist" aria-label="Secondary Side Bar views">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={t.key === current.key}
              className={`tm-auxbar-tab ${t.key === current.key ? "is-active" : ""}`}
              title={t.title}
              onClick={() => showAuxiliaryView(t.key)}
              data-testid={`auxbar-tab-${t.key}`}
            >
              <ExtIcon icon={t.icon} mask />
              <span className="tm-auxbar-tab-label">{t.title}</span>
            </button>
          ))}
        </div>
        <ActionButton icon="close" label="Hide Secondary Side Bar (⌥⌘B)" onClick={() => toggleAuxiliaryBar(false)} />
      </header>
      <div className="tm-auxbar-body">
        {current.key === "chat" ? (
          <Suspense fallback={<div className="tm-auxbar-loading">Loading…</div>}>
            <ChatView />
          </Suspense>
        ) : (
          <ExtViewPanes key={current.key} container={current.key} fill />
        )}
      </div>
    </aside>
  );
}
