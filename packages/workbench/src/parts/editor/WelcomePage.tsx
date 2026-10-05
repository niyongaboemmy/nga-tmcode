import { executeCommand, formatKeybinding } from "../../commands/registry";
import { getPlatform, openRecent, useWorkbench } from "../../state/store";
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
              <div className="tm-welcome-card">
                <Codicon name="mortar-board" className="tm-welcome-card-icon" />
                <div>
                  <h3>Taking a test or exam</h3>
                  <p>
                    Open the quiz in Task Mentor and choose <strong>Open in TMCode</strong>. Your task, starter files and timer appear here, and
                    your work is saved automatically — even offline.
                  </p>
                </div>
              </div>
              <div className="tm-welcome-card">
                <Codicon name="beaker" className="tm-welcome-card-icon" />
                <div>
                  <h3>Practising on your own</h3>
                  <p>Open any folder to write and run code with the full editor. Practice mode has no restrictions.</p>
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
          <span className={`tm-mode-pill is-${mode}`}>{mode === "practice" ? "Practice mode" : mode === "monitored" ? "Monitored exam" : "Secure exam"}</span>
          <span className="tm-muted">New Generation Academy · TMCode {getPlatform().version}</span>
        </footer>
      </div>
    </div>
  );
}
