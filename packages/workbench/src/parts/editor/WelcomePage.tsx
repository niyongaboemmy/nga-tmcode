import { executeCommand, formatKeybinding } from "../../commands/registry";
import type { ReactNode } from "react";
import { getPlatform, openRecent, revealView, useWorkbench } from "../../state/store";
import { useAssignments } from "../../projects/assignments";
import { openTaskMentorPage } from "../../projects/commands";
import { projectsSupported, signIn, useProjects } from "../../projects/service";
import { todoOf, todoSummary } from "../../projects/studentHome";
import { Codicon } from "../../widgets/icons";
import { Logo } from "../../widgets/Logo";

function StartLink({ icon, label, command, kb }: { icon: string; label: string; command: string; kb?: string }) {
  const os = getPlatform().os;
  return (
    <button type="button" className="tm-welcome-link" onClick={() => executeCommand(command)}>
      <Codicon name={icon} />
      <span>{label}</span>
      {kb && <span className="tm-welcome-kb">{formatKeybinding(kb, os)}</span>}
    </button>
  );
}

/** "Your assignments": sign in, or what is to do and when the next is due. */
function AssignmentsCard() {
  const account = useProjects((s) => s.account);
  const student = useAssignments((s) => s.student);
  const staff = useAssignments((s) => s.staff === true);
  const busy = account?.phase === "waiting" || account?.phase === "completing";
  const { count } = todoOf(student);
  const open = () => revealView("assignments");
  let body: ReactNode;
  if (!account?.signed_in) {
    body = (
      <>
        <p>Sign in to see the work your teachers set, start it with their starter files, and hand it in from here.</p>
        <div className="tm-welcome-card-actions">
          <button type="button" className="tm-button tm-button--small" disabled={busy} onClick={() => void signIn()} data-testid="welcome-signin">
            <Codicon name={busy ? "loading" : "account"} className={busy ? "codicon-modifier-spin" : ""} /> {busy ? "Continue in your browser…" : "Sign in with NGA"}
          </button>
        </div>
      </>
    );
  } else {
    const summary =
      student === null
        ? "Checking Task Mentor…"
        : staff
          ? "Your subjects' TMCode assignments, with each student's progress."
          : todoSummary(student);
    body = (
      <>
        <p data-testid="welcome-assignments-summary">{summary}</p>
        <div className="tm-welcome-card-actions">
          <button type="button" className={`tm-button tm-button--small ${count === 0 ? "tm-button--secondary" : ""}`} onClick={open} data-testid="welcome-open-assignments">
            Open Assignments
          </button>
        </div>
      </>
    );
  }
  return (
    <div className="tm-welcome-card is-primary" data-testid="welcome-assignments-card">
      <Codicon name="mortar-board" className="tm-welcome-card-icon" />
      <div>
        <h3>Your assignments</h3>
        {body}
      </div>
    </div>
  );
}

export function WelcomePage() {
  const recent = useWorkbench((s) => s.recent);
  const mode = useWorkbench((s) => s.policy.mode);
  return (
    <div className="tm-welcome tm-scroll">
      <div className="tm-welcome-inner">
        <header className="tm-welcome-hero">
          <Logo size={64} className="tm-welcome-logo" />
          <div>
            <h1>TMCode</h1>
            <p className="tm-welcome-tagline">Write, run and submit your code — connected to Task Mentor.</p>
          </div>
        </header>

        <div className="tm-welcome-columns">
          <div className="tm-welcome-col">
            <section>
              <h2>Start</h2>
              <StartLink icon="new-file" label="New File..." command="explorer.newFile" kb="mod+alt+n" />
              <StartLink icon="folder-opened" label="Open Folder..." command="workbench.action.files.openFolder" kb="mod+o" />
              <StartLink icon="new-folder" label="New Project from Template..." command="workbench.action.newProjectFromTemplate" />
              <StartLink icon="symbol-color" label="Choose a Color Theme" command="workbench.action.selectTheme" kb="mod+k mod+t" />
            </section>
            <section>
              <h2>Recent</h2>
              {recent.length === 0 ? (
                <p className="tm-muted">You have no recent folders, open a folder to start.</p>
              ) : (
                recent.slice(0, 6).map((r) => (
                  <button key={r.root} type="button" className="tm-welcome-recent" onClick={() => void openRecent(r.root)} title={r.root}>
                    <span className="tm-welcome-recent-name">{r.name}</span>
                    <span className="tm-welcome-recent-path">{r.root}</span>
                  </button>
                ))
              )}
            </section>
          </div>

          <div className="tm-welcome-col">
            <section>
              <h2>Get started</h2>
              {mode === "practice" && projectsSupported() && <AssignmentsCard />}
              <button
                type="button"
                className="tm-welcome-card is-action"
                data-testid="welcome-exam-card"
                title="Open your quizzes in Task Mentor"
                onClick={() => mode === "practice" && openTaskMentorPage("/quizzes")}
              >
                <Codicon name="checklist" className="tm-welcome-card-icon" />
                <div>
                  <h3>Taking a test or exam</h3>
                  <p>
                    Open the quiz in Task Mentor and choose <strong>Open in TMCode</strong>. Your task, starter files and timer appear here, and your work is saved automatically, even
                    offline.
                  </p>
                  <span className="tm-welcome-card-link">Open my quizzes in Task Mentor</span>
                </div>
                <Codicon name="link-external" className="tm-welcome-card-go" />
              </button>
              <div className="tm-welcome-card" data-testid="welcome-practice-card">
                <Codicon name="beaker" className="tm-welcome-card-icon" />
                <div>
                  <h3>Practising on your own</h3>
                  <p>Open any folder to write and run code with the full editor. Practice mode has no restrictions.</p>
                  <div className="tm-welcome-card-actions">
                    <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => executeCommand("workbench.action.files.openFolder")}>
                      Open Folder...
                    </button>
                    <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => executeCommand("workbench.action.newProjectFromTemplate")}>
                      New Project from Template...
                    </button>
                  </div>
                </div>
              </div>
              <button type="button" className="tm-welcome-card is-action" onClick={() => executeCommand("workbench.action.keybindingsReference")}>
                <Codicon name="keyboard" className="tm-welcome-card-icon" />
                <div>
                  <h3>Learn the keyboard shortcuts</h3>
                  <p>TMCode uses the same shortcuts as Visual Studio Code.</p>
                </div>
                <Codicon name="arrow-right" className="tm-welcome-card-go" />
              </button>
            </section>
          </div>
        </div>
        <footer className="tm-welcome-footer">
          <span className={`tm-mode-pill is-${mode}`}>{mode === "practice" ? "Practice mode" : "Monitored exam"}</span>
          <span className="tm-muted">New Generation Academy · TMCode {getPlatform().version}</span>
        </footer>
      </div>
    </div>
  );
}
