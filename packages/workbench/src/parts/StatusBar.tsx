import { executeCommand } from "../commands/registry";
import { languageLabel } from "../monaco/documents";
import { activeFilePath, showPanel, useWorkbench } from "../state/store";
import { Codicon } from "../widgets/icons";
import { SyncStatus } from "../exam/ExamViews";
import { showReleaseNotes, useUpdate } from "../update/updateService";

const MODE_LABEL = { practice: "Practice", monitored: "Monitored exam", secure: "Secure exam" } as const;
const MODE_ICON = { practice: "beaker", monitored: "eye", secure: "shield" } as const;

function Item({
  children,
  title,
  onClick,
  className = "",
}: {
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
  className?: string;
}) {
  if (!onClick) {
    return (
      <span className={`tm-status-item ${className}`} title={title}>
        {children}
      </span>
    );
  }
  return (
    <button type="button" className={`tm-status-item is-clickable ${className}`} title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}

function UpdateItem() {
  const { status, info, progress } = useUpdate();
  if (status === "available" && info) {
    return (
      <Item className="tm-status-update" title={`TMCode ${info.version} is available — click for details`} onClick={() => void showReleaseNotes()}>
        <Codicon name="arrow-circle-up" /> Update to {info.version}
      </Item>
    );
  }
  if (status === "downloading" || status === "installing") {
    return (
      <Item className="tm-status-update" title="Updating TMCode">
        <Codicon name="loading" className="codicon-modifier-spin" />
        {status === "installing" ? "Installing update…" : `Downloading update ${progress ?? 0}%`}
      </Item>
    );
  }
  return null;
}

export function StatusBar({ chord }: { chord: string | null }) {
  const mode = useWorkbench((s) => s.policy.mode);
  const problems = useWorkbench((s) => s.problems);
  const cursor = useWorkbench((s) => s.cursor);
  const language = useWorkbench((s) => s.activeLanguage);
  const eol = useWorkbench((s) => s.eol);
  const tabSize = useWorkbench((s) => s.settings["editor.tabSize"]);
  const spaces = useWorkbench((s) => s.settings["editor.insertSpaces"]);
  const hasFile = useWorkbench((s) => !!activeFilePath(s));
  const dirtyCount = useWorkbench((s) => Object.keys(s.dirty).length);
  const autoSave = useWorkbench((s) => s.settings["files.autoSave"]);
  const notifications = useWorkbench((s) => s.notifications.length);
  const run = useWorkbench((s) => s.run);
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.filter((p) => p.severity === "warning").length;

  return (
    <footer className={`tm-statusbar is-${mode}`} role="status" aria-label="Status Bar">
      <div className="tm-status-left">
        <Item className="tm-status-mode" title={`TMCode — ${MODE_LABEL[mode]}`}>
          <Codicon name={MODE_ICON[mode]} />
          <span>{MODE_LABEL[mode]}</span>
        </Item>
        <SyncStatus />
        <Item title={`Errors: ${errors}, Warnings: ${warnings}`} onClick={() => showPanel("problems")}>
          <Codicon name="error" /> {errors} <Codicon name="warning" /> {warnings}
        </Item>
        {dirtyCount > 0 && autoSave === "off" && (
          <Item title={`${dirtyCount} unsaved file${dirtyCount > 1 ? "s" : ""}`} onClick={() => executeCommand("workbench.action.files.saveAll")}>
            <Codicon name="circle-filled" className="tm-status-unsaved" /> {dirtyCount} unsaved
          </Item>
        )}
        {run.status !== "idle" && (
          <Item title="Show the Run panel" onClick={() => showPanel("run")} className="tm-status-running">
            <Codicon name="loading" className="codicon-modifier-spin" />
            {run.status === "building" ? "Building" : "Running"} {run.entry?.split("/").pop()}
          </Item>
        )}
        {chord && <Item title="Waiting for second key of chord">({chord}) was pressed. Waiting for second key of chord...</Item>}
      </div>
      <div className="tm-status-right">
        {hasFile && (
          <>
            <Item title="Go to Line/Column" onClick={() => executeCommand("workbench.action.gotoLine")}>
              Ln {cursor.line}, Col {cursor.column}
              {cursor.selected > 0 && ` (${cursor.selected} selected)`}
            </Item>
            <Item className="tm-prio-low" title="Indentation (Settings)" onClick={() => executeCommand("workbench.action.openSettings")}>
              {spaces ? "Spaces" : "Tab Size"}: {tabSize}
            </Item>
            <Item className="tm-prio-low" title="Encoding">UTF-8</Item>
            <Item className="tm-prio-low" title="End of Line Sequence">{eol}</Item>
            <Item className="tm-prio-mid" title="Language Mode">{languageLabel(language)}</Item>
          </>
        )}
        <Item className="tm-prio-low" title={autoSave === "off" ? "Auto Save is off" : "Auto Save is on"} onClick={() => executeCommand("workbench.action.openSettings")}>
          <Codicon name={autoSave === "off" ? "circle-slash" : "check-all"} />
          {autoSave === "off" ? "Auto Save Off" : "Auto Save"}
        </Item>
        <UpdateItem />
        <Item title={notifications ? `${notifications} notifications` : "No Notifications"}>
          <Codicon name={notifications ? "bell-dot" : "bell"} />
        </Item>
      </div>
    </footer>
  );
}
