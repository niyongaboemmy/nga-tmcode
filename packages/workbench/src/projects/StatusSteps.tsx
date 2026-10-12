import { Codicon } from "../widgets/icons";
import { STATUS_LABEL, type StudentStatus } from "./status";

/** In progress → Submitted → (Returned →) Graded, with the one status as the current step. */
export function StatusSteps({ status, testId = "project-steps" }: { status: StudentStatus; testId?: string }) {
  const steps: StudentStatus[] = status === "returned" ? ["in_progress", "submitted", "returned", "graded"] : ["in_progress", "submitted", "graded"];
  const at = steps.indexOf(status === "closed" || status === "not_started" ? "in_progress" : status);
  return (
    <ol className="tm-status-steps" aria-label="Status" data-testid={testId}>
      {steps.map((st, i) => (
        <li key={st} className={`${i < at ? "is-done" : ""} ${i === at ? "is-current" : ""} ${st === "returned" ? "is-returned" : ""}`} aria-current={i === at ? "step" : undefined}>
          <span className="tm-status-dot">{i < at ? <Codicon name="check" /> : null}</span>
          <span>{STATUS_LABEL[st]}</span>
        </li>
      ))}
    </ol>
  );
}
