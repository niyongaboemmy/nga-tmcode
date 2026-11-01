import { lazy, Suspense, useState } from "react";
import { AiToolsMenu, setHidden, useAiTools } from "./aiTools";
import { openContextMenu, updateSetting } from "../state/store";
import { useExam } from "../exam/state";
import { useAiGate } from "../ai/gate";
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
 * Extensions' views never show during exams. TMCode AI's chat shows when the AI gate allows it
 * (in an exam only when the exam's policy turns AI on), else the reason.
 */
export function AuxiliaryBar() {
  const view = useWorkbench((s) => s.auxiliaryView);
  const practice = useWorkbench((s) => s.policy.mode === "practice");
  const inExam = useExam((s) => !!s.quiz);
  const gate = useAiGate();
  useContextVersion((s) => s.v);
  const containers = useViews((s) => s.containers).filter((c) => c.location === "secondarySidebar" && practice && !inExam && whenFor(c.when));
  const allTabs: { key: string; title: string; icon: IconSpec }[] = [{ key: "chat", title: "TMCode AI", icon: { codicon: "sparkle" } }, ...containers.map((c) => ({ key: c.key, title: c.title, icon: c.icon }))];
  const current = allTabs.find((t) => t.key === view) ?? allTabs[0];
  // AI tools under one switcher (the default; parts/aiTools.tsx), hidden tabs left out (the open one stays).
  const aiTools = useAiTools();
  const groupAi = useWorkbench((s) => s.settings["workbench.activityBar.groupAiTools"] !== false);
  const hiddenSetting = useWorkbench((s) => s.settings["workbench.activityBar.hidden"]);
  const hidden = new Set(Array.isArray(hiddenSetting) ? hiddenSetting : []);
  const aiAux = new Set(aiTools.filter((t) => t.location === "secondarySidebar").map((t) => t.key));
  const tabs = allTabs.filter((t) => !(groupAi && aiAux.has(t.key)) && (!hidden.has(t.key) || t.key === current.key));
  const switcher = groupAi && aiAux.size > 0;
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const aiCurrent = aiAux.has(current.key) ? current : null;
  const tabMenu = (e: React.MouseEvent, key: string, title: string) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      { kind: "item", label: `Hide '${title}'`, disabled: key === current.key, run: () => setHidden(key, true) },
      { kind: "separator" },
      ...allTabs.filter((t) => !(groupAi && aiAux.has(t.key))).map((t) => ({ kind: "item" as const, label: t.title, checked: !hidden.has(t.key), run: () => setHidden(t.key, !hidden.has(t.key)) })),
      { kind: "separator" },
      { kind: "item", label: "One Switcher for All AI Tools", checked: groupAi, run: () => updateSetting("workbench.activityBar.groupAiTools", !groupAi) },
    ]);
  };
  if ((inExam || !practice) && !gate.chat) {
    return (
      <aside className="tm-auxbar" aria-label="Secondary Side Bar">
        <p className="tm-auxbar-off" data-testid="auxbar-locked">
          <Codicon name="lock" /> {gate.reason === "EXAM_ACTIVE" ? "AI and extensions are off during exams." : gate.message}
        </p>
      </aside>
    );
  }
  return (
    <aside className="tm-auxbar" aria-label="Secondary Side Bar" data-testid="auxiliary-bar">
      <header className="tm-auxbar-header">
        <div className="tm-auxbar-tabs" role="tablist" aria-label="Secondary Side Bar views">
          {switcher && (
            <button
              type="button"
              role="tab"
              aria-selected={!!aiCurrent}
              aria-haspopup="menu"
              className={`tm-auxbar-tab tm-auxbar-ai ${aiCurrent ? "is-active" : ""}`}
              title="AI Tools"
              onClick={(e) => setMenu(menu ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
              onContextMenu={(e) => tabMenu(e, "chat", "AI Tools")}
              data-testid="auxbar-ai-switcher"
            >
              <ExtIcon icon={(aiCurrent ?? allTabs[0]).icon} mask />
              <span className="tm-auxbar-tab-label">{(aiCurrent ?? allTabs[0]).title}</span>
              <Codicon name="chevron-down" />
            </button>
          )}
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={t.key === current.key}
              className={`tm-auxbar-tab ${t.key === current.key ? "is-active" : ""}`}
              title={t.title}
              onClick={() => showAuxiliaryView(t.key)}
              onContextMenu={(e) => tabMenu(e, t.key, t.title)}
              data-testid={`auxbar-tab-${t.key}`}
            >
              <ExtIcon icon={t.icon} mask />
              <span className="tm-auxbar-tab-label">{t.title}</span>
            </button>
          ))}
        </div>
        <ActionButton icon="close" label="Hide Secondary Side Bar (⌥⌘B)" onClick={() => toggleAuxiliaryBar(false)} />
      </header>
      {menu && <AiToolsMenu anchor={menu} side="below" tools={aiTools} onClose={() => setMenu(null)} />}
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
