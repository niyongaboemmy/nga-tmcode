import { ActionButton, Codicon, FileIcon } from "../widgets/icons";
import { compareConflict, resolveConflict, useProjects } from "./service";

const NONE: string[] = [];

/** Files changed both here and in Task Mentor, each with Compare, Keep Mine and Take Task Mentor's. */
export function ConflictList({ testId = "conflicts" }: { testId?: string }) {
  // A stable empty list: a new [] per call would re-render forever.
  const conflicts = useProjects((s) => s.plan?.conflicts ?? NONE);
  if (!conflicts.length) return null;
  return (
    <div className="tm-projects-conflicts" data-testid={testId} id="tm-conflicts">
      <p>These files changed here and in Task Mentor:</p>
      {conflicts.map((path) => (
        <div key={path} className="tm-list-row">
          <Codicon name="warning" />
          <FileIcon path={path} />
          <span className="tm-project-name">{path}</span>
          <ActionButton icon="diff" label="Compare with Task Mentor's" onClick={() => void compareConflict(path)} />
          <ActionButton icon="check" label="Keep Mine" onClick={() => void resolveConflict(path, "mine")} />
          <ActionButton icon="cloud-download" label="Take Task Mentor's" onClick={() => void resolveConflict(path, "theirs")} />
        </div>
      ))}
    </div>
  );
}
