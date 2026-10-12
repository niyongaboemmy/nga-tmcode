import { useActivity } from "../state/activity";
import { useEffect, useMemo, useRef, useState } from "react";
import { executeCommand } from "../commands/registry";
import { useWorkbench, type EditorInput } from "../state/store";
import { openExternalUrl } from "../terminal/browser";
import { isExternalHref, renderDocMarkdown } from "../widgets/docMarkdown";
import { taskMentorHtml } from "../widgets/richHtml";
import { Codicon, FileIcon } from "../widgets/icons";
import { SkeletonLines } from "../widgets/Skeleton";
import { api, autoSaveMode, compareConflict, recheck, useProjects } from "./service";
import { changeCount } from "./plan";
import { normalizeRubric, rubricResults, rubricTotal, type RubricResult } from "./rubric";
import { SYNC_ICON, SYNC_TIP, SYNC_TONE, syncLineText } from "./syncLabels";
import { acceptsSubmissions, dueLabel, handedInLate, isOpenWorkspaceOf, latePolicyText, loadAssignment, refreshAssignments, startAssignment, STUDENT_STATUS_LABEL, submitAssignment, publishAsStarter, useAssignments } from "./assignments";
import { deriveStatus } from "./status";
import { useStatusSync } from "./useStatusSync";
import { StatusSteps } from "./StatusSteps";
import { QuizPracticalBrief } from "./QuizPracticalBrief";
import { ConflictList } from "./ConflictList";
import { STATE_LABEL } from "./AssignmentsView";
import { openInTaskMentor } from "./taskMentorLinks";
import { keyOf, openGrading } from "../grading/service";

type Input = Extract<EditorInput, { kind: "assignment" }>;

interface Workspace {
  /** id is null for enrolled students who never signed in to Task Mentor. */
  user: { id: number | null; mis_user_id?: number | null; name: string };
  project_id: number | null;
  state: keyof typeof STATE_LABEL;
  last_activity_at: string | null;
  presence: { online: boolean; shared?: boolean } | null;
  revision_number: number | null;
  submitted_at: string | null;
  grade: number | null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

/** Links in the brief open in the system browser, never inside the workbench. */
function onBriefClick(e: React.MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  const href = a?.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  if (isExternalHref(href)) void openExternalUrl(href);
}

function Workspaces({ id }: { id: number }) {
  const [rows, setRows] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ workspaces: Workspace[] }>("GET", `/assignments/${id}/workspaces`)
        .then((r) => alive && setRows(r.workspaces))
        .catch((e) => alive && setError((e as Error).message));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);
  if (error) return <p className="tm-error-text">{error}</p>;
  if (!rows) return <SkeletonLines lines={4} />;
  if (rows.length === 0) return <p className="tm-muted">No students are enrolled yet.</p>;
  return (
    <table className="tm-assignment-table" data-testid="assignment-workspaces">
      <thead>
        <tr>
          <th>Student</th>
          <th>State</th>
          <th>Last activity</th>
          <th>Grade</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((w, i) => (
          <tr key={w.user.id ?? `m${w.user.mis_user_id ?? i}`}>
            <td>
              {w.presence?.online && <span className="tm-live-dot" title="Working in TMCode now" />} {w.user.name}
              {w.presence?.shared === false && (
                <span className="tm-chip" title="This student doesn't share their live status">
                  Live status off
                </span>
              )}
            </td>
            <td>
              {STATE_LABEL[w.state] ?? w.state}
              {w.revision_number ? ` · version ${w.revision_number}` : ""}
            </td>
            <td>{when(w.submitted_at ?? w.last_activity_at)}</td>
            <td>{w.grade ?? "–"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "How it's graded": criteria and points; after grading, the score and note per criterion. */
function RubricTable({ results, graded }: { results: RubricResult[]; graded?: boolean }) {
  const total = rubricTotal(results);
  const scored = graded && results.some((r) => r.score !== null);
  const notes = graded && results.some((r) => r.comment);
  return (
    <table className="tm-assignment-table tm-rubric-table" data-testid={graded ? "assignment-rubric-scores" : "assignment-rubric-table"}>
      <thead>
        <tr>
          <th>Criterion</th>
          {scored ? <th className="tm-rubric-points">Score</th> : <th className="tm-rubric-points">Points</th>}
          {notes && <th>Teacher's note</th>}
        </tr>
      </thead>
      <tbody>
        {results.map((r, i) => (
          <tr key={i}>
            <td>
              <b>{r.name}</b>
              {r.description && !graded && <div className="tm-muted">{r.description}</div>}
            </td>
            <td className="tm-rubric-points">{scored ? `${r.score ?? "–"} / ${r.max}` : r.max || "–"}</td>
            {notes && <td className="tm-rubric-note">{r.comment || <span className="tm-muted">–</span>}</td>}
          </tr>
        ))}
      </tbody>
      {total > 0 && (
        <tfoot>
          <tr>
            <td>Total</td>
            <td className="tm-rubric-points">{scored ? `${results.reduce((n, r) => n + (r.score ?? 0), 0)} / ${total}` : total}</td>
            {notes && <td />}
          </tr>
        </tfoot>
      )}
    </table>
  );
}

const saveKey = () => (navigator.platform.toLowerCase().includes("mac") ? "⌘S" : "Ctrl+S");

/** The brief's working card says where the work is: "Saved online · 2 min ago", "Not saved yet · 3 changes"… (the Projects view's words). */
export function BriefSyncLine() {
  const live = useProjects((s) => s.sync);
  // The quick re-check after each edit keeps the last answer on screen (no "Checking…" flicker).
  const stable = useRef(live);
  if (live !== "checking" || stable.current === "unbound") stable.current = live;
  const sync = live === "checking" ? stable.current : live;
  const plan = useProjects((s) => s.plan);
  const savedAt = useProjects((s) => s.lastSyncAt ?? s.headAt ?? null);
  const message = useProjects((s) => s.syncMessage);
  // An automatic save failed: say so here at once, in the warning colour (it clears on the next good save).
  const autoError = useProjects((s) => s.autoSaveError ?? null);
  const changes = plan ? changeCount(plan.localChanges) : 0;
  // One saving story: unsaved editors count at once (the editor saves them, then Task Mentor gets them).
  const unsaved = useWorkbench((s) => Object.keys(s.dirty).length);
  const editorAutoSave = useWorkbench((s) => s.settings["files.autoSave"] !== "off");
  const autoOn = autoSaveMode() !== "off";
  const busy = sync === "saving" || sync === "pulling";
  const failing = !!autoError && !busy && sync !== "synced" && sync !== "conflict";
  const pending = autoOn && !failing && sync !== "conflict" && sync !== "error" && (unsaved > 0 || sync === "local-changes" || sync === "both");
  const files = `${unsaved} file${unsaved === 1 ? "" : "s"}`;
  const text = failing
    ? `Not saved to Task Mentor: ${autoError}`
    : pending && unsaved > 0 && !editorAutoSave
      ? `${files} not saved yet: press ${saveKey()} to save`
      : pending
        ? `Saving…${unsaved > 0 ? ` · ${files} with changes` : ""}`
        : syncLineText(sync, { changes, savedAt });
  return (
    <p
      className={`tm-brief-sync is-${failing ? "attention" : pending ? "info" : SYNC_TONE[sync]}`}
      data-testid="assignment-sync"
      data-state={pending ? "pending" : sync}
      data-failing={failing ? "true" : undefined}
      title={sync === "error" && message ? message : pending ? "Your files save by themselves, then go to Task Mentor a few seconds later." : SYNC_TIP[sync]}
    >
      <Codicon name={failing ? "warning" : pending ? "sync" : SYNC_ICON[sync]} className={busy || (pending && editorAutoSave) ? "codicon-modifier-spin" : ""} />
      <span>{text}</span>
      {failing && (
        <button type="button" className="tm-link-button" onClick={() => executeCommand("projects.save")} data-testid="assignment-sync-retry">
          Try Again
        </button>
      )}
      {sync === "conflict" && (
        <button type="button" className="tm-link-button" onClick={() => void compareConflict()}>
          Compare
        </button>
      )}
    </p>
  );
}

/** The teacher's note on returned work, in the next-step card. */
function ReturnedNote({ at, message }: { at: string | null; message: string | null }) {
  return (
    <p className="tm-assignment-returned-note" role="status" data-testid="assignment-returned">
      <span className="tm-muted">Returned by your teacher{at ? ` on ${when(at)}` : ""}</span>
      {message ? <q className="tm-assignment-returned-message">{message}</q> : null}
    </p>
  );
}

/** The brief tab: an assignment's, or a quiz practical's (same card, same status: 6.3). */
export function AssignmentEditor({ input }: { input: Input }) {
  return input.source === "quiz" ? <QuizPracticalBrief input={input} /> : <AssignmentBrief input={input} />;
}

/** The assignment page: the brief beside the code, with Start / Continue / Submit. */
function AssignmentBrief({ input }: { input: Input }) {
  const id = input.assignmentId;
  const detail = useAssignments((s) => s.details[id]);
  const busy = useAssignments((s) => s.busy[id]);
  const teaching = useAssignments((s) => !!s.teaching?.some((a) => a.id === id));
  const sync = useProjects((s) => s.sync);
  // Saving starts with a scan of the folder: "Saving…" from the click (a hook: before the early return).
  const savingNow = useActivity((s) => s.running.some((r) => r.label.startsWith("Saving to Task Mentor") || r.label === "Submitting…"));
  // The open project (when it is this assignment's workspace) is the second source of the one status.
  const current = useProjects((s) => s.current);
  useProjects((s) => s.binding);
  // The first minute: nothing to hand in until the project has a file (unknown while the folder loads: allowed).
  const hasFiles = useWorkbench((s) => !s.dirs[""] || s.dirs[""].some((e) => !e.name.startsWith(".")));
  const here = !!detail && isOpenWorkspaceOf(detail);
  // The sources disagree for a moment ("Updating…"): refresh both once, quietly, then settle.
  const view = useStatusSync(detail && !teaching ? deriveStatus(detail, current, { here }) : null, id, () => Promise.all([recheck(), refreshAssignments()]));
  const [, tick] = useState(0);

  useEffect(() => {
    if (!detail) void loadAssignment(id);
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [id, detail]);

  // Task Mentor's rich text, in the editor theme's colours and fonts, with its images (served by its API at /uploads).
  const tmApi = useProjects((s) => s.account?.tm_api ?? null);
  const brief = useMemo(() => (detail?.description_html ? taskMentorHtml(detail.description_html, tmApi) : ""), [detail?.description_html, tmApi]);
  const instructions = useMemo(() => (detail?.instructions ? taskMentorHtml(renderDocMarkdown(detail.instructions), tmApi) : ""), [detail?.instructions, tmApi]);

  if (!detail) {
    return (
      <div className="tm-assignment-page" data-testid="assignment-page">
        <SkeletonLines lines={8} />
      </div>
    );
  }
  const due = dueLabel(detail.due_date);
  const my = detail.my;
  const saving = savingNow || sync === "saving" || sync === "pulling";
  const autoSaving = here && autoSaveMode() !== "off";
  // Another assignment is open in this window: the brief says so before Continue switches.
  const otherWork = !here && current?.assignment && current.assignment.id !== id ? current.assignment.title : null;
  const criteria = normalizeRubric(detail.rubric);
  const graded = !teaching && my?.state === "graded" ? rubricResults(criteria, my) : null;
  // One status for the whole page (W4): header chip, card and button all come from `view`.
  // Teachers have no status of their own here (their page lists the students').
  const status = view?.status ?? "not_started";
  // Handed in: the countdown is over (and "late" is about the submission, below).
  const handedIn = status === "submitted" || status === "graded";
  const open = acceptsSubmissions(detail);
  const overdue = !teaching && open && !handedIn && due?.tone === "late";
  // The one main button of the next-step card, repeated by the sticky footer.
  const footerMain: { label: string; icon: string; run: () => void } | null =
    status === "not_started" && open
      ? { label: "Start", icon: "play", run: () => void startAssignment(id) }
      : !here && (status === "in_progress" || status === "returned" || status === "submitted")
        ? { label: "Continue", icon: "folder-opened", run: () => void startAssignment(id) }
        : here && (status === "in_progress" || status === "returned") && !detail.read_only && hasFiles
          ? { label: view!.primary?.label ?? "Submit", icon: "send", run: () => void submitAssignment(id) }
          : null;
  const busyIcon = (b: typeof busy, icon: string) => <Codicon name={busy === b ? "loading" : icon} className={busy === b ? "codicon-modifier-spin" : ""} />;
  const submittedLine = my?.submitted_at ? (
    <p className="tm-muted tm-next-step-meta" data-testid="assignment-submitted-at">
      Submitted {when(my.submitted_at)}
      {my.revision_number ? ` (version ${my.revision_number})` : ""}
      {handedInLate(detail) && (
        <>
          {" "}
          <span className="tm-chip is-late" data-testid="assignment-result-late">
            Late
          </span>
        </>
      )}
    </p>
  ) : null;

  return (
    <div className="tm-assignment-page" data-testid="assignment-page" onClick={onBriefClick}>
      <header className="tm-assignment-head">
        <div className="tm-assignment-kicker">
          <Codicon name={detail.kind === "case_study" ? "book" : "beaker"} />
          <span>{detail.kind === "case_study" ? "Case study" : "Practical"}</span>
          {detail.course_name && <span>· {detail.course_name}</span>}
        </div>
        <h1>{detail.title}</h1>
        <div className="tm-assignment-facts">
          {!teaching && (
            <span className="tm-fact tm-fact--state" data-testid="assignment-state" data-status={status} data-syncing={view!.syncing ? "true" : undefined}>
              <Codicon name="circle-filled" className={`tm-state-dot is-${status === "closed" ? "readonly" : status === "returned" ? "in_progress" : status}`} />
              {STUDENT_STATUS_LABEL[status]}
              {detail.read_only && status === "closed" ? " — read-only" : ""}
              {view!.syncing && (
                <span className="tm-muted tm-fact-updating" role="status" data-testid="assignment-updating">
                  {" "}
                  · Updating…
                </span>
              )}
            </span>
          )}
          {detail.due_date && (
            <span className={`tm-fact ${due && open && !handedIn ? `is-${due.tone}` : ""}`} data-testid="assignment-due" title={due?.tone === "late" && open && !handedIn ? latePolicyText(detail) : undefined}>
              <Codicon name="calendar" /> Due {when(detail.due_date)}
              {due && open && !handedIn && <b> · {due.text}</b>}
            </span>
          )}
          {detail.points != null && (
            <span className="tm-fact">
              <Codicon name="star-empty" /> {detail.points} points
            </span>
          )}
          {detail.language && (
            <span className="tm-fact">
              <Codicon name="code" /> {detail.language}
            </span>
          )}
        </div>
      </header>

      {/* The steps live here now, beside the one button (0.16; the side bar is one line). */}
      {!teaching && status !== "not_started" && status !== "closed" && <StatusSteps status={status} testId="assignment-steps" />}

      {!teaching && (
        <section className={`tm-next-step is-${status === "not_started" ? "start" : status === "graded" ? "graded" : !here ? "open" : status === "submitted" || status === "closed" ? "done" : "working"}`} data-testid="assignment-next-step" data-status={status} aria-label="Next step">
          {status === "not_started" ? (
            <>
              <div className="tm-next-step-text">
                <h2>
                  <Codicon name="rocket" /> {view!.headline}
                </h2>
                <p>
                  TMCode creates your own project{detail.starter ? ` with your teacher's ${detail.starter.file_count} starter file${detail.starter.file_count === 1 ? "" : "s"}` : ""} and opens it in this window, with this brief beside your code.
                  {!detail.starter && " Your teacher gave no starter files: you can begin from a template."}
                </p>
                <small className="tm-muted">The folder open now stays on this computer; it's under Recent on Home.</small>
              </div>
              <button type="button" className="tm-button tm-button--large" disabled={!!busy} onClick={() => void startAssignment(id)} data-testid="assignment-start" autoFocus>
                {busyIcon("starting", "play")} {busy === "starting" ? "Preparing your project…" : "Start"}
              </button>
            </>
          ) : status === "graded" ? (
            // L8: the result is the next step, at the top: score, feedback, criteria.
            <div className="tm-next-step-text tm-next-step-result" data-testid="assignment-result">
              <h2>
                <Codicon name="pass" /> {view!.headline}
              </h2>
              <div className="tm-assignment-grade">
                <b>{my?.grade ?? "–"}</b>
                <span>/ {my?.max_points ?? detail.points ?? "–"}</span>
              </div>
              {graded?.feedback && <p className="tm-assignment-feedback">{graded.feedback}</p>}
              {graded?.results && <RubricTable results={graded.results} graded />}
              {submittedLine}
              {!here && my?.project_id && (
                <button type="button" className="tm-button tm-button--secondary" disabled={!!busy} onClick={() => void startAssignment(id)} data-testid="assignment-continue">
                  {busyIcon("starting", "folder-opened")} {busy === "starting" ? "Opening…" : "Continue"}
                </button>
              )}
            </div>
          ) : status === "closed" ? (
            <>
              <div className="tm-next-step-text">
                <h2>
                  <Codicon name="lock" /> {view!.headline}
                </h2>
                <p data-testid={detail.read_only ? "assignment-readonly" : "assignment-closed"}>
                  {detail.read_only
                    ? "Your teacher marked this assignment as completed. You can still read your work, but it can no longer be changed, saved or submitted."
                    : "Your teacher closed this assignment: it no longer takes submissions. Your work is still saved to Task Mentor."}
                </p>
                {submittedLine}
                {here && !detail.read_only && <BriefSyncLine />}
              </div>
              {view!.primary?.id === "open_work" && (
                <button type="button" className="tm-button tm-button--secondary" disabled={!!busy} onClick={() => void startAssignment(id)} data-testid="assignment-continue">
                  {busyIcon("starting", "folder-opened")} {busy === "starting" ? "Opening…" : "Continue"}
                </button>
              )}
              {here && !detail.read_only && !autoSaving && (
                <button type="button" className="tm-button tm-button--secondary" disabled={saving || !!busy} onClick={() => executeCommand("projects.save")} data-testid="assignment-save" title="Save to Task Mentor">
                  <Codicon name={saving ? "loading" : "cloud-upload"} className={saving ? "codicon-modifier-spin" : ""} /> {saving ? "Saving…" : "Save to Task Mentor"}
                </button>
              )}
            </>
          ) : !here ? (
            <>
              <div className="tm-next-step-text">
                <h2>
                  <Codicon name={status === "returned" ? "reply" : status === "submitted" ? "lock" : "folder-opened"} /> {status === "in_progress" ? view!.headline : status === "returned" ? view!.headline : "Submitted"}
                </h2>
                {status === "returned" && <ReturnedNote at={my?.returned_at ?? null} message={my?.returned_message ?? null} />}
                <p>
                  {status === "submitted"
                    ? "Your teacher sees the version you handed in. Continue opens your project; withdraw it there if you need to change something before it's graded."
                    : `Your project is saved in Task Mentor. Continue opens it in this window${status === "returned" ? " to make the changes, then submit again" : ", then Submit"}.`}
                </p>
                {status === "submitted" && submittedLine}
                {otherWork && (
                  <p className="tm-muted tm-next-step-meta" data-testid="assignment-other-work">
                    <Codicon name="info" /> You're working on <strong>{otherWork}</strong> in this window. Continue saves it to Task Mentor and opens this one.
                  </p>
                )}
              </div>
              <button type="button" className="tm-button tm-button--large" disabled={!!busy} onClick={() => void startAssignment(id)} data-testid="assignment-continue" autoFocus>
                {busyIcon("starting", "folder-opened")} {busy === "starting" ? "Opening…" : "Continue"}
              </button>
            </>
          ) : status === "submitted" ? (
            <>
              <div className="tm-next-step-text">
                <h2>
                  <Codicon name="lock" /> {view!.headline}
                </h2>
                <p>Your teacher sees the version you handed in. Withdraw it if you need to change something before it's graded.</p>
                {submittedLine}
              </div>
              <button type="button" className="tm-button tm-button--secondary" onClick={() => executeCommand("projects.withdraw")} data-testid="assignment-withdraw">
                <Codicon name="discard" /> Withdraw to Edit
              </button>
            </>
          ) : (
            <>
              <div className="tm-next-step-text">
                <h2>
                  <Codicon name={status === "returned" ? "reply" : "edit"} /> {view!.headline}
                </h2>
                {status === "returned" && <ReturnedNote at={my?.returned_at ?? null} message={my?.returned_message ?? null} />}
                <p>
                  {status === "returned"
                    ? "Make the changes your teacher asked for, then submit again."
                    : autoSaving
                      ? "Your work saves to Task Mentor by itself as you go. Submit hands in your saved work; you can withdraw it until it's graded."
                      : "Save to Task Mentor as you go. Submit hands in your saved work; you can withdraw it until it's graded."}
                </p>
                {overdue && (
                  <p className="tm-brief-late" data-testid="assignment-late-policy">
                    <Codicon name="warning" /> {latePolicyText(detail)}
                  </p>
                )}
                <BriefSyncLine />
                <ConflictList testId="brief-conflicts" />
              </div>
              <div className="tm-next-step-actions">
                {!autoSaving && (
                  <button type="button" className="tm-button tm-button--secondary" disabled={saving || !!busy} onClick={() => executeCommand("projects.save")} data-testid="assignment-save" title="Save to Task Mentor">
                    <Codicon name={saving ? "loading" : "cloud-upload"} className={saving ? "codicon-modifier-spin" : ""} /> {saving ? "Saving…" : "Save to Task Mentor"}
                  </button>
                )}
                <button
                  type="button"
                  className="tm-button"
                  disabled={saving || !!busy || view!.syncing || !hasFiles}
                  onClick={() => void submitAssignment(id)}
                  data-testid="assignment-submit"
                  title={hasFiles ? undefined : "Create your first file (Explorer), then Submit."}
                >
                  {busyIcon("submitting", "send")} {busy === "submitting" ? "Submitting…" : !hasFiles ? "Nothing to hand in yet" : (view!.primary?.label ?? "Submit")}
                </button>
              </div>
            </>
          )}
          <span className="tm-next-step-break" />
          <button type="button" className="tm-link-button tm-next-step-tm" onClick={() => openInTaskMentor({ kind: "assignment", id: id })}>
            <Codicon name="link-external" /> Open in Task Mentor
          </button>
        </section>
      )}

      {teaching && (
        <>
          <div className="tm-assignment-actions">
            <button type="button" className="tm-button" onClick={() => void publishAsStarter()}>
              <Codicon name="file-symlink-directory" /> Use Open Project as Starter…
            </button>
            <button type="button" className="tm-button tm-button--secondary" onClick={() => openGrading(keyOf("assignment", id, null))} data-testid="assignment-grade">
              <Codicon name="tasklist" /> Grade Submissions
            </button>
            <button type="button" className="tm-button tm-button--secondary" onClick={() => openInTaskMentor({ kind: "assignment", id: id })}>
              <Codicon name="link-external" /> Open in Task Mentor
            </button>
          </div>
          {detail.teaching && (
            <div className="tm-assignment-stats">
              {(["students", "started", "submitted", "graded"] as const).map((k) => (
                <div key={k} className="tm-assignment-stat">
                  <b>{detail.teaching![k]}</b>
                  <span>{k[0].toUpperCase() + k.slice(1)}</span>
                </div>
              ))}
            </div>
          )}
          <h2>Students</h2>
          <Workspaces id={id} />
        </>
      )}

      {/* Students see the starter files in the Start card above. */}
      {detail.starter && teaching && (
        <p className="tm-muted tm-assignment-starter">
          <Codicon name="files" /> Starter files: {detail.starter.file_count} file{detail.starter.file_count === 1 ? "" : "s"}
        </p>
      )}

      {brief && (
        <section className="tm-assignment-section">
          <h2>Brief</h2>
          <div className="tm-markdown-body tm-rich" dangerouslySetInnerHTML={{ __html: brief }} />
        </section>
      )}
      {instructions && (
        <section className="tm-assignment-section">
          <h2>Instructions</h2>
          <div className="tm-markdown-body tm-rich" dangerouslySetInnerHTML={{ __html: instructions }} />
        </section>
      )}
      {detail.attachments?.length > 0 && (
        <section className="tm-assignment-section">
          <h2>Attachments</h2>
          <ul className="tm-assignment-attachments">
            {detail.attachments.map((f) => (
              <li key={f.url}>
                <a href={f.url}>
                  <FileIcon path={f.name} size={14} /> {f.name}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {criteria.length > 0 && !graded?.results && (
        <section className="tm-assignment-section" data-testid="assignment-rubric">
          <h2>How it's graded</h2>
          <RubricTable results={criteria.map((c) => ({ ...c, score: null, comment: "" }))} />
        </section>
      )}
      {!brief && !instructions && <p className="tm-muted">No brief was written for this assignment. Open it in Task Mentor for any details.</p>}
      {!teaching && footerMain && (
        <BriefFooter status={STUDENT_STATUS_LABEL[status]} tone={status} label={footerMain.label} icon={footerMain.icon} busy={!!busy || saving} onClick={footerMain.run} />
      )}
    </div>
  );
}

/**
 * Work mode: while the next-step card is scrolled away, a footer keeps the status and the one main
 * button on screen (Start, Continue or Submit), so reading the brief never hides what to do next.
 */
export function BriefFooter(props: { status: string; tone: string; label: string; icon: string; busy: boolean; onClick: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cardVisible, setCardVisible] = useState(true);
  useEffect(() => {
    const page = ref.current?.closest(".tm-assignment-page");
    const card = page?.querySelector('[data-testid="assignment-next-step"]');
    if (!page || !card || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setCardVisible(e.isIntersecting), { root: page, threshold: 0.2 });
    io.observe(card);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`tm-brief-footer${cardVisible ? " is-hidden" : ""}`} data-testid="brief-footer" aria-hidden={cardVisible ? "true" : undefined}>
      <span className="tm-brief-footer-status">
        <Codicon name="circle-filled" className={`tm-state-dot is-${props.tone}`} /> {props.status}
      </span>
      <button type="button" className="tm-button" disabled={props.busy} tabIndex={cardVisible ? -1 : 0} onClick={props.onClick} data-testid="brief-footer-main">
        <Codicon name={props.icon} /> {props.label}
      </button>
    </div>
  );
}
