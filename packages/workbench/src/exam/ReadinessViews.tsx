import { useEffect, useRef } from "react";
import { getPlatform } from "../state/store";
import { Codicon } from "../widgets/icons";
import { checkMyComputer, closeCheckMyComputer, problemCount, useReadiness, type CheckItem, type CheckStatus } from "./readiness";

const ICON: Record<CheckStatus, { icon: string; cls: string; label: string }> = {
  running: { icon: "loading", cls: "is-running codicon-modifier-spin", label: "Checking" },
  ok: { icon: "pass-filled", cls: "is-ok", label: "OK" },
  warn: { icon: "warning", cls: "is-warning", label: "Needs attention" },
  fail: { icon: "error", cls: "is-error", label: "Problem" },
  skipped: { icon: "circle-slash", cls: "is-skipped", label: "Not checked" },
};

function openLink(url: string) {
  const p = getPlatform();
  if (p.openExternal) void p.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** One row per check: icon, what, result; problems add a plain fix and install links. */
export function Checklist({ items }: { items: CheckItem[] }) {
  return (
    <ul className="tm-checklist" aria-label="System check">
      {items.map((i) => {
        const s = ICON[i.status];
        return (
          <li key={i.id} className={`tm-check is-${i.status}`} data-testid={`check-${i.id}`} data-status={i.status}>
            <Codicon name={s.icon} className={`tm-check-icon ${s.cls}`} title={s.label} />
            <div className="tm-check-body">
              <div className="tm-check-line">
                <span className="tm-check-label">{i.label}</span>
                <span className="tm-check-detail">{i.detail}</span>
              </div>
              {i.fix && <div className="tm-check-fix">{i.fix}</div>}
              {!!i.links?.length && (
                <div className="tm-check-links">
                  {i.links.map((l) => (
                    <button key={l.url} type="button" className="tm-link-button" onClick={() => openLink(l.url)} title={l.url}>
                      <Codicon name="link-external" /> {l.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** "Check My Computer" (Help menu, command palette, Welcome): the exam lobby's checks, any day before the exam. */
export function CheckMyComputerOverlay() {
  const { open, running, items } = useReadiness();
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    card.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeCheckMyComputer();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  const problems = problemCount(items);
  return (
    <div className="tm-exam-overlay" role="dialog" aria-modal="true" aria-labelledby="tm-checkpc-title" data-testid="check-my-computer">
      <div className="tm-exam-card tm-readiness-card" ref={card} tabIndex={-1}>
        <h2 id="tm-checkpc-title">Check My Computer</h2>
        <p className="tm-muted">
          {running
            ? "Checking the language tools, Task Mentor, the clock and the disk…"
            : problems
              ? `${problems} thing${problems > 1 ? "s" : ""} to fix before a coding exam. Python, Java and C compilers are installed separately from TMCode.`
              : "This computer is ready for coding exams."}
        </p>
        <Checklist items={items} />
        <div className="tm-readiness-actions">
          <button type="button" className="tm-button" disabled={running} onClick={() => void checkMyComputer()} data-testid="check-again">
            <Codicon name="refresh" /> Check Again
          </button>
          <button type="button" className="tm-button tm-button--secondary" onClick={closeCheckMyComputer}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
