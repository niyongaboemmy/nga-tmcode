import { useState } from "react";
import { getPlatform, notify } from "../state/store";
import type { OsKind } from "../platform/types";
import { ActionButton, Codicon } from "../widgets/icons";
import { dismissInstallGuide, loadToolchains, useDebug } from "./debugService";
import type { InstallGuide } from "./installGuide";

const OS_LABEL: Record<OsKind, string> = { windows: "Windows", mac: "macOS", linux: "Linux" };

function copy(text: string) {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => notify("info", `Copied: ${text}`))
    .catch(() => {});
}

/**
 * The friendly "how to install" card: what is missing, the commands for this
 * operating system (others one click away), how to check, and Refresh.
 */
export function InstallCard({ guide, missing, onClose }: { guide: InstallGuide; missing: string[]; onClose?: () => void }) {
  const platform = getPlatform();
  const [os, setOs] = useState<OsKind>(platform.os);
  const [refreshing, setRefreshing] = useState(false);
  const message = useDebug((s) => s.missingMessage);
  const web = platform.kind === "web";
  const runs = guide.tools.length > 0 || !!guide.terminal;
  const headline = guide.terminal
    ? `${guide.language} runs in TMCode's terminal`
    : !runs
    ? `TMCode doesn't run ${guide.language} programs yet`
    : web
      ? `${guide.language} runs in the TMCode desktop app`
      : `${guide.language} is not installed`;
  const lead = guide.terminal
    ? `Run Project and ▶ run ${guide.language} in a terminal. Install ${guide.summary} first:`
    : !runs
    ? `You can still edit ${guide.language} files. To build and run them on this computer, install ${guide.summary}:`
    : web
      ? `The browser can't run ${guide.language}. Install ${guide.summary} and use the TMCode desktop app:`
      : `TMCode needs ${guide.summary}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}. To install it:`;

  return (
    <section className="tm-install-card" role="region" aria-label={`How to install ${guide.language}`} data-testid="install-card" data-guide={guide.id}>
      <header className="tm-install-card-head">
        <Codicon name={guide.icon} className="tm-install-card-icon" />
        <h3>{headline}</h3>
        <ActionButton
          icon="close"
          label="Dismiss"
          onClick={() => {
            dismissInstallGuide();
            onClose?.();
          }}
        />
      </header>
      {message && runs && !web && <p className="tm-install-card-error">{message}</p>}
      <p>{lead}</p>
      <div className="tm-install-os" role="tablist" aria-label="Operating system">
        {(Object.keys(OS_LABEL) as OsKind[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={os === k} className={`tm-install-os-tab ${os === k ? "is-active" : ""}`} onClick={() => setOs(k)}>
            {OS_LABEL[k]}
          </button>
        ))}
      </div>
      <ol className="tm-install-steps">
        {guide.steps[os].map((step, i) => (
          <li key={i}>
            <span>{step.text}</span>
            {step.command && (
              <div className="tm-install-cmd">
                <code className="tm-mono">{step.command}</code>
                <ActionButton icon="copy" label="Copy Command" onClick={() => copy(step.command!)} />
              </div>
            )}
          </li>
        ))}
        <li>
          <span>Check it worked in a new terminal:</span>
          <div className="tm-install-cmd">
            <code className="tm-mono">{guide.verify}</code>
            <ActionButton icon="copy" label="Copy Command" onClick={() => copy(guide.verify)} />
          </div>
        </li>
      </ol>
      {guide.debugger && <p className="tm-muted tm-install-note">{guide.debugger}</p>}
      <div className="tm-install-actions">
        {runs && !web && (
          <button
            type="button"
            className="tm-button"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              await loadToolchains(true);
              setRefreshing(false);
            }}
          >
            {refreshing ? "Looking for toolchains…" : "Refresh Toolchains"}
          </button>
        )}
        <button type="button" className="tm-link-button" title={guide.url} onClick={() => copy(guide.url)}>
          Copy download link
        </button>
      </div>
    </section>
  );
}
