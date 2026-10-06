import { useEffect, useState } from "react";
import { formatElapsed } from "../../run/projectKind";
import { Codicon } from "../../widgets/icons";

/** Panel header chip: elapsed time while running, then the exit badge (green / red) with the duration. */
export function RunStateBadge({ running, phase, since, exit }: { running: boolean; phase: string; since: number | null; exit: { ok: boolean; label: string; ms: number } | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (running) {
    return (
      <span className="tm-run-badge is-running" role="status" data-testid="run-state-badge">
        <span className="tm-run-pulse" aria-hidden />
        {phase} {since ? formatElapsed(now - since) : ""}
      </span>
    );
  }
  if (!exit) return null;
  const secs = exit.ms < 1000 ? `${exit.ms} ms` : `${(exit.ms / 1000).toFixed(2)} s`;
  return (
    <span className={`tm-run-badge ${exit.ok ? "is-ok" : "is-fail"}`} role="status" title={`${exit.label} in ${secs}`} data-testid="run-state-badge">
      <Codicon name={exit.ok ? "pass-filled" : exit.label === "stopped" ? "debug-stop" : "error"} />
      {exit.label} · {secs}
    </span>
  );
}
