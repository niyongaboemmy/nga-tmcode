import { useEffect, useRef } from "react";
import { create } from "zustand";
import { activeTerminal } from "../terminal/active";
import { useChat } from "../ai/chat";
import { notify } from "../state/store";

/**
 * VS Code's Accessible View (Alt+F2 / ⌥F2): what the focused part shows, as
 * plain text a screen reader can read line by line and copy from — the
 * terminal's output, TMCode AI's last answer, a notification.
 */

export const useAccessibleView = create<{ title: string; text: string } | { title: null; text: null }>(() => ({ title: null, text: null }));

/** The terminal's buffer as text (wrapped lines joined). */
export function terminalText(): string | null {
  const term = activeTerminal();
  if (!term) return null;
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const t = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += t;
    else lines.push(t);
  }
  return lines.join("\n").replace(/\s+$/, "");
}

export function openAccessibleView() {
  const el = document.activeElement as HTMLElement | null;
  if (el?.closest(".xterm")) {
    const text = terminalText();
    if (text !== null) return useAccessibleView.setState({ title: "Terminal", text });
  }
  if (el?.closest(".tm-chat")) {
    const answer = [...useChat.getState().messages].reverse().find((m) => m.role === "assistant" && m.content);
    if (answer) return useAccessibleView.setState({ title: "TMCode AI's answer", text: answer.content });
  }
  const toast = el?.closest(".tm-toast") ?? document.querySelector(".tm-toast");
  if (toast?.textContent) return useAccessibleView.setState({ title: "Notification", text: toast.textContent.trim() });
  notify("info", "The Accessible View shows the terminal, TMCode AI's answers and notifications: focus one of them first.");
}

export function AccessibleView() {
  const { title, text } = useAccessibleView();
  const area = useRef<HTMLTextAreaElement>(null);
  const before = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (title === null) return;
    before.current = document.activeElement as HTMLElement | null;
    area.current?.focus();
    area.current?.setSelectionRange(0, 0);
  }, [title]);
  if (title === null) return null;
  const close = () => {
    useAccessibleView.setState({ title: null, text: null });
    before.current?.focus();
  };
  return (
    <div className="tm-accessible-view" role="dialog" aria-modal="true" aria-label={`Accessible View: ${title}`} data-testid="accessible-view">
      <div className="tm-accessible-view-head">
        <strong>{title}</strong>
        <span className="tm-muted">Escape to close</span>
      </div>
      <textarea
        ref={area}
        readOnly
        value={text ?? ""}
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
    </div>
  );
}
