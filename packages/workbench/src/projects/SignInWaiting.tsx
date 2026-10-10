import { getPlatform, notify } from "../state/store";
import { writeClipboardText } from "../util/clipboard";
import { Codicon } from "../widgets/icons";
import { useProjects } from "./service";

/**
 * While TMCode waits for the browser sign-in (up to 5 minutes): what to do if
 * the browser tab got lost (review F1). Cancel, open it again, or copy the link
 * into another browser.
 */
export function SignInWaiting({ compact = false }: { compact?: boolean }) {
  const account = useProjects((s) => s.account);
  if (account?.phase !== "waiting" && account?.phase !== "completing") return null;
  const host = getPlatform().account;
  const completing = account.phase === "completing";
  const url = account.signin_url ?? null;
  return (
    <div className={`tm-signin-wait ${compact ? "is-compact" : ""}`} role="status" aria-live="polite" data-testid="signin-waiting">
      <p className="tm-signin-wait-line">
        <Codicon name="loading" className="codicon-modifier-spin" />
        {completing ? "Finishing the sign-in…" : "Finish signing in in your browser. TMCode waits up to 5 minutes."}
      </p>
      {!completing && (
        <div className="tm-signin-wait-actions">
          {host?.reopenBrowser && (
            <button
              type="button"
              className="tm-button tm-button--small tm-button--secondary"
              data-testid="signin-reopen"
              onClick={() => void host.reopenBrowser!().catch((e) => notify("error", String((e as Error)?.message ?? e)))}
            >
              <Codicon name="link-external" /> Open the Browser Again
            </button>
          )}
          {url && (
            <button
              type="button"
              className="tm-button tm-button--small tm-button--secondary"
              data-testid="signin-copy"
              onClick={() =>
                void writeClipboardText(url)
                  .then(() => notify("info", "Sign-in link copied. Paste it into a browser on this computer."))
                  .catch(() => notify("error", "TMCode couldn't copy the link."))
              }
            >
              <Codicon name="copy" /> Copy Sign-in Link
            </button>
          )}
          <button type="button" className="tm-button tm-button--small tm-button--secondary" data-testid="signin-cancel" onClick={() => void host?.cancel()}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
