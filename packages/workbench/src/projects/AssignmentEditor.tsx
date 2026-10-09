import { useActivity } from "../state/activity";
import { useEffect, useMemo, useState } from "react";
import { executeCommand } from "../commands/registry";
import type { EditorInput } from "../state/store";
import { openExternalUrl } from "../terminal/browser";
import { isExternalHref, renderDocMarkdown } from "../widgets/docMarkdown";
import { taskMentorHtml } from "../widgets/richHtml";
import { Codicon } from "../widgets/icons";
import { SkeletonLines } from "../widgets/Skeleton";
import { api, useProjects } from "./service";
import { dueLabel, isOpenWorkspaceOf, loadAssignment, startAssignment, submitAssignment, publishAsStarter, useAssignments } from "./assignments";
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
              {w.revision_number ? ` · r${w.revision_number}` : ""}
            </td>
            <td>{when(w.submitted_at ?? w.last_activity_at)}</td>
            <td>{w.grade ?? "–"}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
          {detail.due_date && (
            <span className={`tm-fact ${due && !detail.read_only ? `is-${due.tone}` : ""}`}>
              <Codicon name="calendar" /> Due {when(detail.due_date)}
              {due && !detail.read_only && my?.state !== "submitted" && my?.state !== "graded" && <b> · {due.text}</b>}
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
          {!teaching && (
            <span className="tm-fact" data-testid="assignment-state">
              <Codicon name="circle-filled" className={`tm-state-dot is-${detail.read_only ? "readonly" : (my?.state ?? "not_started")}`} />
              {detail.read_only ? "Completed — read-only" : STATE_LABEL[my?.state ?? "not_started"]}
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

      {!teaching && (
        <div className="tm-assignment-actions">
          {!started && !detail.read_only && (
            <button type="button" className="tm-button" disabled={!!busy} onClick={() => void startAssignment(id)} data-testid="assignment-start">
              <Codicon name={busy === "starting" ? "loading" : "play"} className={busy === "starting" ? "codicon-modifier-spin" : ""} /> {busy === "starting" ? "Preparing your workspace…" : "Start"}
            </button>
          )}
          {started && !here && (
            <button type="button" className="tm-button" disabled={!!busy} onClick={() => void startAssignment(id)} data-testid="assignment-continue">
              <Codicon name="folder-opened" /> {detail.read_only ? "Open My Work" : "Continue"}
            </button>
          )}
          {started && here && !detail.read_only && projectStatus === "submitted" && (
            <button type="button" className="tm-button tm-button--secondary" onClick={() => executeCommand("projects.withdraw")} data-testid="assignment-withdraw">
              <Codicon name="discard" /> Withdraw Submission to Edit
            </button>
          )}
          {started && here && !detail.read_only && projectStatus !== "submitted" && projectStatus !== "graded" && (
            <>
              <button type="button" className="tm-button tm-button--secondary" disabled={saving || !!busy} onClick={() => executeCommand("projects.save")} data-testid="assignment-save">
                <Codicon name={saving ? "loading" : "cloud-upload"} className={saving ? "codicon-modifier-spin" : ""} /> {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" className="tm-button" disabled={saving || !!busy} onClick={() => void submitAssignment(id)} data-testid="assignment-submit">
                <Codicon name={busy === "submitting" ? "loading" : "send"} className={busy === "submitting" ? "codicon-modifier-spin" : ""} />{" "}
                {busy === "submitting" ? "Submitting…" : my?.state === "submitted" || my?.state === "graded" ? "Submit Again" : "Submit"}
              </button>
            </>
          )}
          <button type="button" className="tm-button tm-button--secondary" onClick={() => openAssignmentInTaskMentor(id)}>
            <Codicon name="link-external" /> Open in Task Mentor
          </button>
        </div>
      )}

      {!teaching && my && (my.submitted_at || my.state === "graded") && (
        <div className={`tm-assignment-card ${my.state === "graded" ? "is-graded" : ""}`} data-testid="assignment-result">
          {my.state === "graded" ? (
            <>
              <div className="tm-assignment-grade">
                <b>{my.grade ?? "–"}</b>
                <span>/ {my.max_points ?? detail.points ?? "–"}</span>
              </div>
              {my.feedback && <p className="tm-assignment-feedback">{my.feedback}</p>}
            </>
          ) : null}
          {my.submitted_at && (
            <p className="tm-muted">
              Submitted {when(my.submitted_at)}
              {my.revision_number ? ` (version ${my.revision_number})` : ""}
              {detail.late ? " — late" : ""}
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

      {detail.starter && (
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
      {!brief && !instructions && <p className="tm-muted">No brief was written for this assignment. Open it in Task Mentor for any details.</p>}
    </div>
  );
}
