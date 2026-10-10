import { useActivity } from "../state/activity";
import { useEffect, useMemo, useRef, useState } from "react";
import { executeCommand } from "../commands/registry";
import type { EditorInput } from "../state/store";
import { openExternalUrl } from "../terminal/browser";
import { isExternalHref, renderDocMarkdown } from "../widgets/docMarkdown";
import { taskMentorHtml } from "../widgets/richHtml";
import { Codicon } from "../widgets/icons";
import { SkeletonLines } from "../widgets/Skeleton";
import { api, autoSaveMode, compareConflict, useProjects } from "./service";
import { changeCount } from "./plan";
import { normalizeRubric, rubricResults, rubricTotal, type RubricResult } from "./rubric";
import { SYNC_ICON, SYNC_TIP, SYNC_TONE, syncLineText } from "./syncLabels";
import { acceptsSubmissions, dueLabel, handedInLate, isOpenWorkspaceOf, latePolicyText, loadAssignment, returnedForChanges, startAssignment, STUDENT_STATUS_LABEL, studentStatus, submitAssignment, publishAsStarter, useAssignments } from "./assignments";
import { STATE_LABEL } from "./AssignmentsView";
import { openAssignmentInTaskMentor } from "./commands";
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

/** The brief's working card says where the work is: "Saved online · 2 min ago", "Not saved yet · 3 changes"… (the Projects view's words). */
function BriefSyncLine() {
  const live = useProjects((s) => s.sync);
  // The quick re-check after each edit keeps the last answer on screen (no "Checking…" flicker).
  const stable = useRef(live);
  if (live !== "checking" || stable.current === "unbound") stable.current = live;
  const sync = live === "checking" ? stable.current : live;
  const plan = useProjects((s) => s.plan);
  const savedAt = useProjects((s) => s.lastSyncAt ?? s.headAt ?? null);
  const message = useProjects((s) => s.syncMessage);
  const changes = plan ? changeCount(plan.localChanges) : 0;
  const busy = sync === "saving" || sync === "pulling";
  const text = syncLineText(sync, { changes, savedAt });
  return (
    <p className={`tm-brief-sync is-${SYNC_TONE[sync]}`} data-testid="assignment-sync" data-state={sync} title={sync === "error" && message ? message : SYNC_TIP[sync]}>
      <Codicon name={SYNC_ICON[sync]} className={busy ? "codicon-modifier-spin" : ""} />
      <span>{text}</span>
      {sync === "conflict" && (
        <button type="button" className="tm-link-button" onClick={() => void compareConflict()}>
          Compare
        </button>
      )}
    </p>
  );
}

/** The assignment page: the brief beside the code, with Start / Continue / Submit. */
export function AssignmentEditor({ input }: { input: Input }) {
  const id = input.assignmentId;
  const detail = useAssignments((s) => s.details[id]);
  const busy = useAssignments((s) => s.busy[id]);
  const teaching = useAssignments((s) => !!s.teaching?.some((a) => a.id === id));
  const sync = useProjects((s) => s.sync);
  // Saving starts with a scan of the folder: "Saving…" from the click (a hook: before the early return).
  const savingNow = useActivity((s) => s.running.some((r) => r.label.startsWith("Saving to Task Mentor") || r.label === "Submitting…"));
  // Task Mentor's project lifecycle (when the server has it): a submitted workspace is locked until withdrawn.
  const projectStatus = useProjects((s) => s.current?.status);
  useProjects((s) => s.binding);
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
  const started = !!my?.project_id;
  const here = isOpenWorkspaceOf(detail);
  const saving = savingNow || sync === "saving" || sync === "pulling";
  const autoSaving = here && autoSaveMode() !== "off";
  const criteria = normalizeRubric(detail.rubric);
  const graded = !teaching && my?.state === "graded" ? rubricResults(criteria, my) : null;
  // Handed in: the countdown is over (and "late" is about the submission, below).
  const handedIn = my?.state === "submitted" || my?.state === "graded";
  const returned = !teaching && returnedForChanges(detail);
  // Shared words with Task Mentor: Not started · In progress · Submitted · Returned · Graded · Closed.
  const status = studentStatus(detail);
  const open = acceptsSubmissions(detail);
  const overdue = !teaching && open && !handedIn && due?.tone === "late";

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
            <span className="tm-fact tm-fact--state" data-testid="assignment-state" data-status={status}>
              <Codicon name="circle-filled" className={`tm-state-dot is-${detail.read_only || status === "closed" ? "readonly" : (my?.state ?? "not_started")}`} />
              {STUDENT_STATUS_LABEL[status]}
              {detail.read_only && status === "closed" ? " — read-only" : ""}
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

      {detail.read_only && (
        <div className="tm-assignment-banner" role="status" data-testid="assignment-readonly">
          <Codicon name="lock" />
          <span>Your teacher marked this assignment as completed. You can still read your work, but it can no longer be changed, saved or submitted.</span>
        </div>
      )}

      {returned && (
        <div className="tm-assignment-banner is-warning" role="status" data-testid="assignment-returned">
          <Codicon name="reply" />
          <span>
            <b>Returned by your teacher</b> on {when(my!.returned_at!)}. Make the changes, then submit again.
            {my!.returned_message && <q className="tm-assignment-returned-message">{my!.returned_message}</q>}
          </span>
        </div>
      )}

      {!teaching && (
        <section className={`tm-next-step is-${!started ? "start" : !here ? "open" : projectStatus === "submitted" || projectStatus === "graded" ? "done" : "working"}`} data-testid="assignment-next-step" aria-label="Next step">
          {!started && !detail.read_only ? (
            <>
              <div className="tm-next-step-text">
                <h2>
                  <Codicon name="rocket" /> Start this assignment
                </h2>
                <p>
                  TMCode creates your own project{detail.starter ? ` with your teacher's ${detail.starter.file_count} starter file${detail.starter.file_count === 1 ? "" : "s"}` : ""} and opens it in this window, with this brief beside your code.
                  {!detail.starter && " Your teacher gave no starter files: you can begin from a template."}
                </p>
                <small className="tm-muted">The folder open now stays on this computer; reopen it any time from Recent on the Welcome page (Help › Welcome).</small>
              </div>
              <button type="button" className="tm-button tm-button--large" disabled={!!busy} onClick={() => void startAssignment(id)} data-testid="assignment-start" autoFocus>
                <Codicon name={busy === "starting" ? "loading" : "play"} className={busy === "starting" ? "codicon-modifier-spin" : ""} /> {busy === "starting" ? "Preparing your project…" : "Start Assignment"}
              </button>
            </>
          ) : started && !here ? (
            <>
              <div className="tm-next-step-text">
                <h2>
                  <Codicon name="folder-opened" /> {detail.read_only ? "Your work" : "Continue your work"}
                </h2>
                <p>
                  {detail.read_only
                    ? "This assignment is completed. Open your project to read it."
                    : `Your project is saved in Task Mentor${my?.state === "submitted" ? " and submitted" : my?.state === "graded" ? " and graded" : ""}. Open it in this window to keep working${my?.state === "in_progress" ? ", then Submit" : ""}.`}
                </p>
              </div>
              <button type="button" className="tm-button tm-button--large" disabled={!!busy} onClick={() => void startAssignment(id)} data-testid="assignment-continue" autoFocus>
                <Codicon name={busy === "starting" ? "loading" : "folder-opened"} className={busy === "starting" ? "codicon-modifier-spin" : ""} /> {busy === "starting" ? "Opening…" : detail.read_only ? "Open My Work" : "Open My Project"}
              </button>
            </>
          ) : here && !detail.read_only && projectStatus === "submitted" ? (
            <>
              <div className="tm-next-step-text">
                <h2>
                  <Codicon name="lock" /> Submitted
                </h2>
                <p>Your teacher sees the version you handed in. Withdraw it if you need to change something before it's graded.</p>
              </div>
              <button type="button" className="tm-button tm-button--secondary" onClick={() => executeCommand("projects.withdraw")} data-testid="assignment-withdraw">
                <Codicon name="discard" /> Withdraw to Edit
              </button>
            </>
          ) : here && !detail.read_only && projectStatus !== "graded" ? (
            <>
              <div className="tm-next-step-text">
                <h2>
                  <Codicon name="edit" /> You're working on it in this window
                </h2>
                <p>
                  {!open
                    ? "Your teacher closed this assignment: it no longer takes submissions. Your work is still saved to Task Mentor."
                    : returned
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
              </div>
              <div className="tm-next-step-actions">
                <button type="button" className="tm-button tm-button--secondary" disabled={saving || !!busy} onClick={() => executeCommand("projects.save")} data-testid="assignment-save" title="Save to Task Mentor">
                  <Codicon name={saving ? "loading" : "cloud-upload"} className={saving ? "codicon-modifier-spin" : ""} /> {saving ? "Saving…" : "Save to Task Mentor"}
                </button>
                <button type="button" className="tm-button" disabled={saving || !!busy || !open} onClick={() => void submitAssignment(id)} data-testid="assignment-submit" title={open ? undefined : "Closed: your teacher no longer takes submissions"}>
                  <Codicon name={!open ? "lock" : busy === "submitting" ? "loading" : "send"} className={busy === "submitting" ? "codicon-modifier-spin" : ""} />{" "}
                  {!open ? "Closed" : busy === "submitting" ? "Submitting…" : my?.state === "submitted" || my?.state === "graded" ? "Submit Again" : "Submit"}
                </button>
              </div>
            </>
          ) : (
            <div className="tm-next-step-text">
              <h2>
                <Codicon name={detail.read_only ? "lock" : "pass"} /> {detail.read_only ? "Completed" : "Graded"}
              </h2>
              <p>{detail.read_only ? "Your teacher marked this assignment as completed." : "Your grade and your teacher's feedback are below."}</p>
            </div>
          )}
          <span className="tm-next-step-break" />
          <button type="button" className="tm-link-button tm-next-step-tm" onClick={() => openAssignmentInTaskMentor(id)}>
            <Codicon name="link-external" /> Open in Task Mentor
          </button>
        </section>
      )}

      {!teaching && my && (my.submitted_at || my.state === "graded") && (
        <div className={`tm-assignment-card ${my.state === "graded" ? "is-graded" : ""}`} data-testid="assignment-result">
          {my.state === "graded" ? (
            <>
              <div className="tm-assignment-grade">
                <b>{my.grade ?? "–"}</b>
                <span>/ {my.max_points ?? detail.points ?? "–"}</span>
              </div>
              {graded?.feedback && <p className="tm-assignment-feedback">{graded.feedback}</p>}
              {graded?.results && <RubricTable results={graded.results} graded />}
            </>
          ) : null}
          {my.submitted_at && (
            <p className="tm-muted">
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
          )}
        </div>
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
            <button type="button" className="tm-button tm-button--secondary" onClick={() => openAssignmentInTaskMentor(id)}>
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

      {detail.starter && teaching && (
        <p className="tm-muted tm-assignment-starter">
          <Codicon name="files" /> Starter files: {detail.starter.file_count} file{detail.starter.file_count === 1 ? "" : "s"}
          {!teaching && !started && " — copied into your own workspace when you start."}
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
                  <Codicon name="file" /> {f.name}
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
    </div>
  );
}
