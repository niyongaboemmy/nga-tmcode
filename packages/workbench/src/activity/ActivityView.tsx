import React, { useMemo, useState } from "react";
import { ActionButton, Codicon } from "../widgets/icons";
import { openFile, showDialog } from "../state/store";
import { actorLabel, clearActivity, useActivityLog, type ActivityEvent, type ActivityKind } from "./log";
import { commandOf, detailRows, formatDuration, plural, runStatusOf, runStatusWords, summarize, tokenizeCommand, type DaySummary, type RunStatus } from "./format";

/**
 * The Activity panel: what happened in this folder, newest first, by day.
 * Each day's header sums it up (actions, AI use, runs, pastes from outside,
 * time away); commands show as commands, runs say how they ended.
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
  "copy-files": "copy",
  "cut-files": "chrome-minimize",
  delete: "trash",
  save: "save",
  import: "cloud-download",
  "outside-change": "zap",
  paste: "clippy",
  drop: "clippy",
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
  sync: "sync",
  install: "extensions",
  uninstall: "trash",
  blocked: "circle-slash",
  submit: "send",
  upload: "cloud-upload",
  away: "coffee",
};
const iconOf = (e: ActivityEvent) => (e.ai && !ICONS[e.action] ? "sparkle" : (ICONS[e.action] ?? (e.kind === "clipboard" ? "clippy" : "circle-small-filled")));

const dayStart = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
function dayLabel(start: number) {
  const diff = Math.round((dayStart(Date.now()) - start) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Date(start).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

const PAGE = 300;

/** A command as a terminal line: a prompt, the program, flags, strings and paths in their colours. */
export function CommandChip({ command, wrap }: { command: string; wrap?: boolean }) {
  const tokens = useMemo(() => tokenizeCommand(command), [command]);
  return (
    <code className={`tm-cmd ${wrap ? "is-wrap" : ""}`} title={wrap ? undefined : command}>
      <span className="tm-cmd-prompt" aria-hidden>
        {"$ "}
      </span>
      {tokens.map((t, i) => (
        <span key={i} className={`tm-cmd-${t.kind}`}>
          {t.text}
        </span>
      ))}
    </code>
  );
}

const TONE_ICON: Record<RunStatus["tone"], string> = { ok: "pass-filled", fail: "error", stopped: "debug-stop", running: "loading" };

/** ✓ exit 0 · 1.2 s, ✗ exit 1, ■ stopped, ◌ running. */
export function StatusChip({ status }: { status: RunStatus }) {
  return (
    <span className="tm-actlog-status" data-tone={status.tone} title={runStatusWords(status)} data-testid="activity-run-status">
      <Codicon name={TONE_ICON[status.tone]} className={status.tone === "running" ? "codicon-modifier-spin" : ""} />
      <span>{status.label}</span>
      {status.duration && <span className="tm-actlog-status-time">{status.duration}</span>}
    </span>
  );
}

/** What the row says: the text, or for a terminal command what ran it and the command itself. */
function RowText({ e }: { e: ActivityEvent }) {
  const cmd = commandOf(e);
  const count = e.count && e.count > 1 ? <span className="tm-actlog-count">×{e.count}</span> : null;
  if (cmd && e.kind === "terminal") {
    const verb = e.actor.type === "tmcode-ai" ? "TMCode AI ran" : e.actor.type === "extension" ? `${e.actor.name} ran` : "Ran in the terminal";
    return (
      <span className="tm-actlog-text">
        <span className="tm-actlog-verb">{verb}</span>{" "}
        <CommandChip command={cmd} />
        {count}
      </span>
    );
  }
  return (
    <span className="tm-actlog-text">
      <span className="tm-actlog-label">{e.text}</span>
      {cmd && (
        <>
          {" "}
          <CommandChip command={cmd} />
        </>
      )}
      {count}
    </span>
  );
}

function DayStats({ s, today, onAi }: { s: DaySummary; today: boolean; onAi: () => void }) {
  return (
    <span className="tm-actlog-daystats">
      <span className="tm-actlog-daystat">{plural(s.actions, "action")}</span>
      {s.files > 0 && <span className="tm-actlog-daystat">{plural(s.files, "file change")}</span>}
      {s.runs > 0 && (
        <span className="tm-actlog-daystat">
          {plural(s.runs, "run")}
          {s.failedRuns > 0 && <span className="is-fail"> · {s.failedRuns} failed</span>}
        </span>
      )}
      {s.pastes > 0 && (
        <span className="tm-actlog-daystat">
          {plural(s.pastes, "paste")}
          {s.outsidePastes > 0 && (
            <span className="is-warn" title="Text pasted from another app or website">
              {" "}
              · {s.outsidePastes} from outside
            </span>
          )}
        </span>
      )}
      {s.awayMs > 0 && (
        <span className="tm-actlog-daystat" title="Time spent in other apps (30 s or more at a time)">
          <Codicon name="coffee" /> away {formatDuration(s.awayMs)}
        </span>
      )}
      <button
        type="button"
        className={`tm-actlog-daystat tm-actlog-aistat ${s.ai ? "has-ai" : ""}`}
        onClick={onAi}
        title={s.aiTools.length ? `AI used: ${s.aiTools.join(", ")}. Show only AI use.` : "No AI used. Show only AI use."}
        {...(today ? { "data-testid": "activity-ai-count" } : {})}
      >
        <Codicon name="sparkle" />
        {s.ai ? `${s.ai} with AI · ${s.aiTools.join(", ")}` : "no AI"}
      </button>
    </span>
  );
}

export function ActivityView({ filter: search }: { filter: string }) {
  const events = useActivityLog((s) => s.events);
  const root = useActivityLog((s) => s.root);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, events.filter(f.match).length])) as Record<Filter, number>, [events]);

  // Each day's summary is of everything that day, whatever the filter.
  const days = useMemo(() => {
    const by = new Map<number, ActivityEvent[]>();
    for (const e of events) {
      const d = dayStart(e.t);
      if (!by.has(d)) by.set(d, []);
      by.get(d)!.push(e);
    }
    return new Map([...by].map(([d, list]) => [d, summarize(list)]));
  }, [events]);

  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!;
    const q = search.trim().toLowerCase();
    return events
      .filter((e) => f.match(e) && (!q || `${e.text} ${e.path ?? ""} ${e.to ?? ""} ${actorLabel(e.actor)} ${e.ai?.by ?? ""} ${e.ai?.how ?? ""} ${commandOf(e) ?? ""}`.toLowerCase().includes(q)))
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

  const groups: { day: number; items: ActivityEvent[] }[] = [];
  for (const e of shown.slice(0, limit)) {
    const day = dayStart(e.t);
    if (groups[groups.length - 1]?.day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1].items.push(e);
  }
  const today = dayStart(Date.now());

  return (
    <div className="tm-actlog" data-testid="activity-view">
      <div className="tm-actlog-bar">
        <div className="tm-actlog-filters" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={`tm-actlog-seg ${filter === f.id ? "is-active" : ""} ${counts[f.id] ? "" : "is-empty"}`}
              data-filter={f.id}
              onClick={() => setFilter(f.id)}
              data-testid={`activity-filter-${f.id}`}
            >
              <Codicon name={f.icon} />
              <span>{f.label}</span>
              <span className="tm-actlog-seg-count" aria-label={plural(counts[f.id], "entry", "entries")}>
                {counts[f.id]}
              </span>
            </button>
          ))}
        </div>
        <ActionButton
          icon="clear-all"
          label="Clear Activity Log"
          disabled={!events.length}
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
        />
      </div>
      <div className="tm-actlog-list tm-scroll" role="list" aria-label="Activity">
        {!shown.length && (
          <p className="tm-actlog-none">
            <Codicon name={events.length ? "filter" : "history"} />
            {events.length ? "Nothing matches." : "Nothing yet. Files you create, rename or delete, copy and paste, runs and AI use appear here."}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.day} className="tm-actlog-day" aria-label={dayLabel(g.day)}>
            <h3 className="tm-actlog-day-title">
              <span className="tm-actlog-day-name">{dayLabel(g.day)}</span>
              {days.get(g.day) && <DayStats s={days.get(g.day)!} today={g.day === today} onAi={() => setFilter("ai")} />}
            </h3>
            {g.items.map((e) => {
              const status = runStatusOf(e);
              const isOpen = open === e.id;
              const origin = typeof e.data?.origin === "string" ? e.data.origin : undefined;
              return (
                <div key={e.id} role="listitem" className={`tm-actlog-row ${e.ai ? "is-ai" : ""} ${isOpen ? "is-open" : ""}`} data-kind={e.kind} data-action={e.action} data-origin={origin} data-tone={status?.tone}>
                  <button
                    type="button"
                    className="tm-actlog-main"
                    onClick={() => setOpen(isOpen ? null : e.id)}
                    aria-expanded={isOpen}
                    aria-label={`${clock(e.t)} ${e.text}${status ? `, ${runStatusWords(status)}` : ""}${e.ai ? `, AI: ${e.ai.by}` : e.actor.type !== "you" ? `, by ${actorLabel(e.actor)}` : ""}`}
                  >
                    <span className="tm-actlog-time">{clock(e.t)}</span>
                    <Codicon name={iconOf(e)} className="tm-actlog-icon" />
                    <RowText e={e} />
                    {status && <StatusChip status={status} />}
                    {e.ai ? (
                      <span className="tm-actlog-ai" title={`${e.ai.by}: ${e.ai.how}${e.ai.model ? ` (${e.ai.model})` : ""}`}>
                        <Codicon name="sparkle" /> {e.ai.by}
                      </span>
                    ) : (
                      e.actor.type !== "you" && <span className="tm-actlog-actor">{actorLabel(e.actor)}</span>
                    )}
                  </button>
                  {isOpen && <Details e={e} />}
                </div>
              );
            })}
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

function Details({ e }: { e: ActivityEvent }) {
  const rows = detailRows(e);
  return (
    <div className="tm-actlog-details">
      <dl>
        <dt>When</dt>
        <dd>{new Date(e.t).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</dd>
        <dt>By</dt>
        <dd>{actorLabel(e.actor)}</dd>
        {e.ai && (
          <>
            <dt>AI</dt>
            <dd className="tm-actlog-dd-ai">
              {e.ai.by}: {e.ai.how}
              {e.ai.model ? ` · ${e.ai.model}` : ""}
            </dd>
          </>
        )}
        {e.path && (
          <>
            <dt>File</dt>
            <dd>
              <button type="button" className="tm-link-button tm-actlog-file" onClick={() => openFile(e.to ?? e.path!)}>
                {e.path}
                {e.to ? ` → ${e.to}` : ""}
              </button>
            </dd>
          </>
        )}
        {rows.map((r) => (
          <React.Fragment key={r.key}>
            <dt>{r.label}</dt>
            <dd>{r.key === "command" ? <CommandChip command={r.value} wrap /> : r.value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}
