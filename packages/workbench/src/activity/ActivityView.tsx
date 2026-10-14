import React, { useMemo, useState } from "react";
import { Codicon } from "../widgets/icons";
import { openFile, showDialog } from "../state/store";
import { actorLabel, clearActivity, useActivityLog, type ActivityEvent, type ActivityKind } from "./log";

/**
 * The Activity panel: what happened in this folder, newest first, by day.
 * AI involvement is marked on every event it touched, and counted on top.
 */

type Filter = "all" | "ai" | ActivityKind | "work";
const FILTERS: { id: Filter; label: string; icon: string; match: (e: ActivityEvent) => boolean }[] = [
  { id: "all", label: "All", icon: "list-flat", match: () => true },
  { id: "ai", label: "AI", icon: "sparkle", match: (e) => !!e.ai },
  { id: "file", label: "Files", icon: "files", match: (e) => e.kind === "file" },
  { id: "clipboard", label: "Copy & paste", icon: "clippy", match: (e) => e.kind === "clipboard" },
  { id: "work", label: "Runs & terminal", icon: "play", match: (e) => e.kind === "run" || e.kind === "terminal" },
  { id: "project", label: "Projects & git", icon: "git-commit", match: (e) => e.kind === "project" || e.kind === "git" },
  { id: "extension", label: "Extensions", icon: "extensions", match: (e) => e.kind === "extension" || e.kind === "editor" },
];

const ICONS: Record<string, string> = {
  create: "new-file",
  "create-folder": "new-folder",
  rename: "edit",
  move: "move",
  copy: "copy",
  delete: "trash",
  save: "save",
  import: "cloud-download",
  "outside-change": "zap",
  paste: "clippy",
  cut: "chrome-minimize",
  suggestion: "sparkle",
  chat: "comment-discussion",
  apply: "sparkle",
  run: "play",
  test: "beaker",
  debug: "debug-alt",
  command: "terminal",
  commit: "git-commit",
  push: "repo-push",
  pull: "repo-pull",
  install: "extensions",
  uninstall: "trash",
  submit: "send",
};
const iconOf = (e: ActivityEvent) => (e.ai && !ICONS[e.action] ? "sparkle" : (ICONS[e.action] ?? (e.kind === "clipboard" ? "clippy" : "circle-small-filled")));

function dayLabel(t: number) {
  const d = new Date(t);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

const PAGE = 300;

export function ActivityView({ filter: search }: { filter: string }) {
  const events = useActivityLog((s) => s.events);
  const root = useActivityLog((s) => s.root);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const counts = useMemo(() => {
    const today = new Date().toDateString();
    const todays = events.filter((e) => new Date(e.t).toDateString() === today);
    const ai = todays.filter((e) => e.ai);
    const tools = [...new Set(ai.map((e) => e.ai!.by))];
    return { total: todays.length, ai: ai.length, tools, files: todays.filter((e) => e.kind === "file").length, pastes: todays.filter((e) => e.action === "paste").length };
  }, [events]);

  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!;
    const q = search.trim().toLowerCase();
    return events
      .filter((e) => f.match(e) && (!q || `${e.text} ${e.path ?? ""} ${e.to ?? ""} ${actorLabel(e.actor)} ${e.ai?.by ?? ""} ${e.ai?.how ?? ""}`.toLowerCase().includes(q)))
      .slice()
      .reverse();
  }, [events, filter, search]);

  if (!root) {
    return (
      <div className="tm-actlog-empty">
        <Codicon name="history" />
        <p>Open a folder to see what happens in it.</p>
      </div>
    );
  }

  const groups: { day: string; items: ActivityEvent[] }[] = [];
  for (const e of shown.slice(0, limit)) {
    const day = dayLabel(e.t);
    if (groups[groups.length - 1]?.day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1].items.push(e);
  }

  return (
    <div className="tm-actlog" data-testid="activity-view">
      <div className="tm-actlog-top">
        <div className="tm-actlog-stats" aria-label="Today">
          <span className="tm-actlog-stat">
            <strong>{counts.total}</strong> actions today
          </span>
          <button type="button" className={`tm-actlog-stat is-ai ${counts.ai ? "has-ai" : ""}`} onClick={() => setFilter("ai")} title={counts.tools.length ? `AI used: ${counts.tools.join(", ")}` : "No AI used today"} data-testid="activity-ai-count">
            <Codicon name="sparkle" />
            <strong>{counts.ai}</strong> with AI{counts.tools.length ? ` · ${counts.tools.join(", ")}` : ""}
          </button>
          <span className="tm-actlog-stat">
            <strong>{counts.files}</strong> file changes
          </span>
          <span className="tm-actlog-stat">
            <strong>{counts.pastes}</strong> pastes
          </span>
        </div>
        <div className="tm-actlog-filters" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`tm-actlog-chip ${filter === f.id ? "is-active" : ""}`} onClick={() => setFilter(f.id)} data-testid={`activity-filter-${f.id}`}>
              <Codicon name={f.icon} /> {f.label}
            </button>
          ))}
          <span className="tm-actlog-spacer" />
          <button
            type="button"
            className="tm-link-button"
            onClick={async () => {
              const choice = await showDialog({
                message: "Clear this folder's activity log?",
                detail: "TMCode forgets the actions shown here. What was already sent to Task Mentor for a linked project stays there.",
                severity: "warning",
                buttons: [
                  { id: "clear", label: "Clear", primary: true, destructive: true },
                  { id: "cancel", label: "Cancel" },
                ],
                cancelId: "cancel",
              });
              if (choice === "clear") clearActivity();
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="tm-actlog-list tm-scroll" role="list" aria-label="Activity">
        {!shown.length && <p className="tm-actlog-none">{events.length ? "Nothing matches." : "Nothing yet. Files you create, rename or delete, copy and paste, runs and AI use appear here."}</p>}
        {groups.map((g) => (
          <section key={g.day} className="tm-actlog-day">
            <h3 className="tm-actlog-day-title">{g.day}</h3>
            {g.items.map((e) => (
              <div key={e.id} role="listitem" className={`tm-actlog-row ${e.ai ? "is-ai" : ""} ${open === e.id ? "is-open" : ""}`} data-kind={e.kind} data-action={e.action}>
                <button type="button" className="tm-actlog-main" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                  <span className="tm-actlog-time">{new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                  <Codicon name={iconOf(e)} className="tm-actlog-icon" />
                  <span className="tm-actlog-text">
                    {e.text}
                    {e.count && e.count > 1 ? <span className="tm-actlog-count">×{e.count}</span> : null}
                  </span>
                  {e.ai ? (
                    <span className="tm-actlog-ai" title={`${e.ai.by}: ${e.ai.how}${e.ai.model ? ` (${e.ai.model})` : ""}`}>
                      <Codicon name="sparkle" /> {e.ai.by}
                    </span>
                  ) : (
                    e.actor.type !== "you" && <span className="tm-actlog-actor">{actorLabel(e.actor)}</span>
                  )}
                </button>
                {open === e.id && (
                  <div className="tm-actlog-details">
                    <dl>
                      <dt>When</dt>
                      <dd>{new Date(e.t).toLocaleString()}</dd>
                      <dt>By</dt>
                      <dd>{actorLabel(e.actor)}</dd>
                      {e.ai && (
                        <>
                          <dt>AI</dt>
                          <dd>
                            {e.ai.by}: {e.ai.how}
                            {e.ai.model ? ` · ${e.ai.model}` : ""}
                          </dd>
                        </>
                      )}
                      {e.path && (
                        <>
                          <dt>File</dt>
                          <dd>
                            <button type="button" className="tm-link-button" onClick={() => openFile(e.to ?? e.path!)}>
                              {e.path}
                              {e.to ? ` → ${e.to}` : ""}
                            </button>
                          </dd>
                        </>
                      )}
                      {Object.entries(e.data ?? {}).map(([k, v]) => (
                        <React.Fragment key={k}>
                          <dt>{k.replace(/_/g, " ")}</dt>
                          <dd>{String(v)}</dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  </div>
                )}
              </div>
            ))}
          </section>
        ))}
        {shown.length > limit && (
          <button type="button" className="tm-link-button tm-actlog-more" onClick={() => setLimit(limit + PAGE)}>
            Show older ({shown.length - limit} more)
          </button>
        )}
      </div>
    </div>
  );
}
