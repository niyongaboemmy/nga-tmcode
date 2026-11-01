import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { isAiExtension } from "../activity/aiExtensions";
import { useExam } from "../exam/state";
import { useExtensions } from "../extensions/service";
import { ExtIcon } from "../exthost/views/ExtIcon";
import { useViews, whenFor, type IconSpec } from "../exthost/views/model";
import { openSpecialEditor, revealView, showAuxiliaryView, updateSetting, useWorkbench, type ViewId } from "../state/store";
import { Codicon } from "../widgets/icons";

/**
 * Every AI tool in one place: TMCode AI and the views of AI extensions (Claude Code, Codex, Gemini
 * Code Assist, Cline, Continue…), wherever they live (side bar or secondary side bar). With
 * `workbench.activityBar.groupAiTools` (the default) the activity bar shows one AI icon for all of
 * them, and the secondary side bar one switcher, each opening this menu with the open tool
 * highlighted; off, each keeps its own icon. Any icon can be hidden with a right-click.
 */

export interface AiTool {
  /** "chat" (TMCode AI) or an extension view container's key ("ext:claude-sidebar"). */
  key: string;
  title: string;
  icon: IconSpec;
  /** Where it opens. */
  location: "activitybar" | "secondarySidebar";
  extensionId: string | null;
}

export const TMCODE_AI: AiTool = { key: "chat", title: "TMCode AI", icon: { codicon: "sparkle" }, location: "secondarySidebar", extensionId: null };

/** The AI tools available now (extensions' only in practice mode, never in exams). */
export function useAiTools(): AiTool[] {
  useViews((s) => s.version);
  const containers = useViews((s) => s.containers);
  const installed = useExtensions((s) => s.installed);
  const practice = useWorkbench((s) => s.policy.mode === "practice");
  const inExam = useExam((s) => !!s.quiz);
  return [TMCODE_AI, ...aiContainers(containers, installed, practice && !inExam)];
}

export function aiContainers(containers: ReturnType<typeof useViews.getState>["containers"], installed: ReturnType<typeof useExtensions.getState>["installed"], allowed: boolean): AiTool[] {
  if (!allowed) return [];
  return containers
    .filter((c) => (c.location === "activitybar" || c.location === "secondarySidebar") && whenFor(c.when))
    .filter((c) => isAiExtension(c.extensionId, installed.find((x) => x.id.toLowerCase() === c.extensionId.toLowerCase())?.manifest))
    .map((c) => ({ key: c.key, title: c.title, icon: c.icon, location: c.location as AiTool["location"], extensionId: c.extensionId }));
}

/** The AI tool picked last (the AI icon shows it). */
const LAST_KEY = "tmcode:last-ai-tool";
export const useLastAiTool = create<{ key: string }>(() => {
  try {
    return { key: localStorage.getItem(LAST_KEY) ?? "chat" };
  } catch {
    return { key: "chat" };
  }
});

export function openAiTool(t: AiTool) {
  if (t.location === "activitybar") revealView(t.key as ViewId);
  else showAuxiliaryView(t.key);
  useLastAiTool.setState({ key: t.key });
  try {
    localStorage.setItem(LAST_KEY, t.key);
  } catch {
    /* private mode */
  }
}

/** The AI tool showing now: the side bar's view, else the secondary side bar's. */
export function useOpenAiTool(tools: AiTool[]): AiTool | null {
  const side = useWorkbench((s) => (s.sidebarVisible ? s.activeView : null));
  const aux = useWorkbench((s) => (s.auxiliaryVisible ? s.auxiliaryView : null));
  return tools.find((t) => t.location === "activitybar" && t.key === side) ?? tools.find((t) => t.location === "secondarySidebar" && t.key === aux) ?? null;
}

export function hiddenItems(): string[] {
  const v = useWorkbench.getState().settings["workbench.activityBar.hidden"];
  return Array.isArray(v) ? v : [];
}

export function setHidden(key: string, hidden: boolean) {
  const now = hiddenItems().filter((k) => k !== key);
  updateSetting("workbench.activityBar.hidden", hidden ? [...now, key] : now);
}

/** The AI icon in the activity bar: the tool picked last, highlighted while an AI tool is open in the side bar. */
export function AiToolsButton({ tools }: { tools: AiTool[] }) {
  const open = useOpenAiTool(tools);
  const last = useLastAiTool((s) => s.key);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const shown = open ?? tools.find((t) => t.key === last) ?? tools[0];
  const active = !!open && open.location === "activitybar";
  return (
    <>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        className={`tm-activity tm-activity-ai ${active ? "is-active" : ""} ${menu ? "is-open" : ""}`}
        title={`AI Tools${open ? ` · ${open.title}` : ""}`}
        aria-label="AI Tools"
        data-key="ai-tools"
        data-testid="activity-ai-tools"
        onClick={(e) => setMenu(menu ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        {shown.key === "chat" ? <Codicon name="sparkle" /> : <ExtIcon icon={shown.icon} mask size={24} className="tm-activity-ext-icon" />}
        <span className="tm-activity-ai-mark" aria-hidden>
          <Codicon name="sparkle" />
        </span>
      </button>
      {menu && <AiToolsMenu anchor={menu} side="right" tools={tools} onClose={() => setMenu(null)} />}
    </>
  );
}

/**
 * The AI tools menu: every tool with its icon, the open one highlighted; arrow keys, Enter and
 * Esc; and the layout choices (one icon or one each) with the accounts behind them.
 */
export function AiToolsMenu({ anchor, side, tools, onClose }: { anchor: DOMRect; side: "right" | "below"; tools: AiTool[]; onClose(): void }) {
  const open = useOpenAiTool(tools);
  const grouped = useWorkbench((s) => s.settings["workbench.activityBar.groupAiTools"] !== false);
  const ref = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(() => Math.max(0, tools.findIndex((t) => t.key === open?.key)));
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = side === "right" ? anchor.right + 6 : Math.min(anchor.left, window.innerWidth - r.width - 6);
    const top = side === "right" ? Math.min(anchor.top, window.innerHeight - r.height - 6) : anchor.bottom + 4;
    setPos({ left: Math.max(6, left), top: Math.max(6, top) });
    el.focus();
  }, [anchor, side]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-key="ai-tools"], [data-testid="auxbar-ai-switcher"]')) onClose();
    };
    // Esc closes it wherever the focus is (workbench shortcuts listen on the window first).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", esc, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const pick = (t: AiTool) => {
    onClose();
    openAiTool(t);
  };
  return (
    <div
      ref={ref}
      className="tm-ai-tools-menu"
      role="menu"
      aria-label="AI Tools"
      tabIndex={-1}
      data-testid="ai-tools-menu"
      style={{ left: pos?.left ?? anchor.right, top: pos?.top ?? anchor.top, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setFocus((f) => (f + 1) % tools.length);
        else if (e.key === "ArrowUp") setFocus((f) => (f - 1 + tools.length) % tools.length);
        else if (e.key === "Enter" && tools[focus]) pick(tools[focus]);
        else if (e.key === "Escape") onClose();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="tm-ai-tools-head">AI Tools</div>
      {tools.map((t, i) => {
        const selected = open?.key === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            className={`tm-ai-tools-item ${selected ? "is-selected" : ""} ${focus === i ? "is-focused" : ""}`}
            data-testid="ai-tools-item"
            data-key={t.key}
            onMouseEnter={() => setFocus(i)}
            onClick={() => pick(t)}
          >
            <span className="tm-ai-tools-icon">{t.key === "chat" ? <Codicon name="sparkle" /> : <ExtIcon icon={t.icon} mask size={18} />}</span>
            <span className="tm-ai-tools-text">
              <span className="tm-ai-tools-title">{t.title}</span>
              <span className="tm-ai-tools-where">{t.key === "chat" ? "Free, premium, your accounts and keys" : t.location === "activitybar" ? "Opens in the side bar" : "Opens in the secondary side bar"}</span>
            </span>
            {selected && <Codicon name="check" className="tm-ai-tools-check" />}
          </button>
        );
      })}
      <div className="tm-ai-tools-sep" role="separator" />
      <button type="button" role="menuitemcheckbox" aria-checked={grouped} className="tm-ai-tools-action" onClick={() => (onClose(), updateSetting("workbench.activityBar.groupAiTools", !grouped))} data-testid="ai-tools-group">
        <Codicon name={grouped ? "check" : "blank"} /> One AI Icon for All AI Tools
      </button>
      <button type="button" role="menuitem" className="tm-ai-tools-action" onClick={() => (onClose(), openSpecialEditor("settings"))}>
        <Codicon name="account" /> Manage AI Accounts and Keys…
      </button>
    </div>
  );
}
