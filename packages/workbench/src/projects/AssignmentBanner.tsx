import { useState } from "react";
import { Codicon } from "../widgets/icons";
import { dueLabel, showAssignment, submitAssignment, useAssignments } from "./assignments";
import { useProjects, withdrawSubmission } from "./service";
import { deriveStatus } from "./status";

/**
 * Over the code of an assignment's workspace: whether it is handed in, in
 * plain words and colour, with the one thing to do — so "did I submit?" is
 * never a question. Not submitted (orange) stays until it is; Submitted
 * (green), Graded (blue) and Closed can be hidden for the session.
 */
export function AssignmentBanner() {
  const binding = useProjects((s) => s.binding);
  const current = useProjects((s) => s.current);
  const a = useAssignments((s) => (current?.assignment ? (s.student?.find((x) => x.id === current.assignment!.id) ?? null) : null));
  const busy = useAssignments((s) => (a ? s.busy[a.id] : undefined));
  const [hidden, setHidden] = useState<string | null>(null);
  if (!binding || !current || !a || current.id !== binding.project_id) return null;
  const view = deriveStatus(a, current, { here: true });
  const key = `${a.id}:${view.status}`;
  if (hidden === key || view.status === "not_started") return null;
  const due = dueLabel(a.due_date);
  const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");
  const submit = () => void submitAssignment(a.id);
  let tone: "warning" | "success" | "info" | "muted";
  let icon: string;
  let text: React.ReactNode;
  let action: { label: string; run: () => void; testid: string } | null = null;
  switch (view.status) {
    case "in_progress":
      tone = "warning";
      icon = "warning";
      text = (
        <>
          <b>Not submitted yet.</b> Your teacher can't see this work until you submit it.{due ? ` ${due.text}.` : ""}
        </>
      );
      action = { label: busy === "submitting" ? "Submitting…" : "Submit…", run: submit, testid: "banner-submit" };
      break;
    case "returned":
      tone = "warning";
      icon = "reply";
      text = (
        <>
          <b>Returned by your teacher</b>{a.my?.returned_message ? `: “${a.my.returned_message}”` : ""}. Make the changes, then submit again.
        </>
      );
      action = { label: "Submit Again…", run: submit, testid: "banner-submit" };
      break;
    case "submitted":
      tone = "success";
      icon = "pass-filled";
      text = (
        <>
          <b>Submitted</b>
          {a.my?.submitted_at ? ` on ${when(a.my.submitted_at)}` : ""}. Your teacher sees this version.
        </>
      );
      action = a.read_only ? null : { label: "Withdraw to Edit", run: () => void withdrawSubmission(current.id), testid: "banner-withdraw" };
      break;
    case "graded":
      tone = "info";
      icon = "mortar-board";
      text = (
        <>
          <b>Graded</b>
          {a.my?.grade != null ? `: ${a.my.grade}${a.my.max_points ? ` / ${a.my.max_points}` : ""}` : ""}. Your teacher's feedback is in the brief.
        </>
      );
      action = { label: "View Feedback", run: () => showAssignment(a.id, { toSide: true }), testid: "banner-feedback" };
      break;
    default:
      tone = "muted";
      icon = "lock";
      text = <>{a.read_only ? "Completed: this work can't be changed or submitted any more." : "Closed by your teacher: it no longer accepts work."}</>;
  }
  return (
    <div className={`tm-assignment-banner is-${tone}`} role="status" data-testid="assignment-banner" data-status={view.status}>
      <Codicon name={icon} />
      <span className="tm-assignment-banner-text">
        <span className="tm-assignment-banner-title">{a.title}</span> · {text}
      </span>
      <button type="button" className="tm-link-button" onClick={() => showAssignment(a.id, { toSide: true })}>
        Brief
      </button>
      {action && (
        <button type="button" className={`tm-button tm-button--small ${tone === "warning" ? "" : "tm-button--secondary"}`} disabled={busy === "submitting"} onClick={action.run} data-testid={action.testid}>
          {action.label}
        </button>
      )}
      {tone !== "warning" && (
        <button type="button" className="tm-assignment-banner-close" aria-label="Hide" title="Hide until this changes" onClick={() => setHidden(key)}>
          <Codicon name="close" />
        </button>
      )}
    </div>
  );
}
