import { useEffect, useRef, useState } from "react";

/**
 * Workbench tooltips, like VS Code's custom hovers: every `title` in the
 * workbench (icons, buttons, menus, tabs, status bar) shows as a styled
 * tooltip after a short delay instead of the OS tooltip. While the pointer is
 * on an element its `title` moves to `data-tm-tip` (so the OS tooltip stays
 * away) and comes back when the pointer leaves. A trailing "(⌘⇧E)" becomes a
 * key chip; further lines become the description.
 */

const DELAY = 500;
/** Moving between items soon after a tooltip closed shows the next one at once, as VS Code does. */
const WARM = 600;

interface Tip {
  title: string;
  description: string | null;
  keys: string | null;
  x: number;
  y: number;
  side: "below" | "above" | "right";
  id: number;
}

function parse(text: string) {
  const [first, ...rest] = text.split("\n");
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(first);
  // Only keybinding-like parentheses become a chip ("Save (⌘S)", "Run (Ctrl+Shift+F10)").
  const isKeys = !!m && /^([⌘⇧⌥⌃]|ctrl|shift|alt|cmd|f\d|[a-z]\b|\+)/i.test(m[2].trim()) && m[2].length <= 24;
  return { title: isKeys ? m![1] : first, keys: isKeys ? m![2] : null, description: rest.join("\n").trim() || null };
}

function place(el: Element, tip: HTMLElement | null): { x: number; y: number; side: Tip["side"] } {
  const r = el.getBoundingClientRect();
  const w = tip?.offsetWidth ?? 200;
  const h = tip?.offsetHeight ?? 28;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (el.closest(".tm-activitybar")) return { x: r.right + 8, y: Math.min(Math.max(4, r.top + r.height / 2 - h / 2), vh - h - 4), side: "right" };
  const below = r.bottom + 6 + h <= vh - 4;
  const x = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), vw - w - 4);
  return { x, y: below ? r.bottom + 6 : Math.max(4, r.top - 6 - h), side: below ? "below" : "above" };
}

export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const state = useRef<{ el: HTMLElement | null; timer: ReturnType<typeof setTimeout> | null; closedAt: number; seq: number }>({ el: null, timer: null, closedAt: 0, seq: 0 });

  useEffect(() => {
    const s = state.current;
    const restore = () => {
      const el = s.el;
      if (el && el.dataset.tmTip !== undefined) {
        if (!el.hasAttribute("title")) el.setAttribute("title", el.dataset.tmTip);
        delete el.dataset.tmTip;
      }
      s.el = null;
    };
    const hide = () => {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      setTip((t) => {
        if (t) s.closedAt = Date.now();
        return null;
      });
      restore();
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const target = e.target as Element | null;
      const el = target?.closest?.<HTMLElement>("[title], [data-tm-tip]") ?? null;
      if (el === s.el) return;
      hide();
      if (!el || !el.closest(".tm-root") || el.closest("[data-no-tooltip]")) return;
      const text = el.getAttribute("title") ?? el.dataset.tmTip ?? "";
      if (!text.trim()) return;
      // The OS tooltip would show too: hold the title while the pointer is here.
      el.dataset.tmTip = text;
      el.removeAttribute("title");
      if (!el.hasAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", text.split("\n")[0]);
      s.el = el;
      const id = ++s.seq;
      const show = () => {
        if (s.el !== el || !el.isConnected) return;
        const p = parse(text);
        setTip({ ...p, ...place(el, null), id });
      };
      s.timer = setTimeout(show, Date.now() - s.closedAt < WARM ? 60 : DELAY);
    };
    const out = (e: PointerEvent) => {
      const to = e.relatedTarget as Node | null;
      if (s.el && to && s.el.contains(to)) return;
      if (s.el && e.target instanceof Node && s.el.contains(e.target)) hide();
    };
    const away = () => hide();
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", away, true);
    document.addEventListener("wheel", away, { capture: true, passive: true });
    window.addEventListener("blur", away);
    return () => {
      hide();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", away, true);
      document.removeEventListener("wheel", away, true);
      window.removeEventListener("blur", away);
    };
  }, []);

  // Once rendered, measure and keep it on screen.
  useEffect(() => {
    const el = state.current.el;
    if (!tip || !el || !ref.current) return;
    const p = place(el, ref.current);
    if (p.x !== tip.x || p.y !== tip.y || p.side !== tip.side) setTip({ ...tip, ...p });
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={ref} className={`tm-tooltip is-${tip.side}`} role="tooltip" style={{ left: tip.x, top: tip.y }} data-testid="tooltip">
      <div className="tm-tooltip-title">
        <span>{tip.title}</span>
        {tip.keys && <kbd className="tm-tooltip-keys">{tip.keys}</kbd>}
      </div>
      {tip.description && <div className="tm-tooltip-desc">{tip.description}</div>}
    </div>
  );
}
