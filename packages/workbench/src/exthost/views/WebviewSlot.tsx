import { useEffect, useRef } from "react";
import { useExtensions } from "../../extensions/service";
import { showPanel } from "../../state/store";
import { Codicon } from "../../widgets/icons";
import { HOST_CHANNEL, useOutputChannel } from "../output";
import { attachSlot, detachSlot, reloadWebview, setWebviewLayer, showWebviewAnyway, useWebviewStatus, useWebviews } from "./webviews";

/**
 * Where a webview shows (editor area, side bar view): its iframe, in the layer, follows this box.
 * Until the page has started, the iframe stays hidden and the box says "Starting <extension>…";
 * a page that never starts gets what went wrong on it, Reload and the log.
 */
export function WebviewSlot({ handle, className = "" }: { handle: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const status = useWebviewStatus((s) => s[handle]);
  const extensionId = useWebviews((s) => s.entries[handle]?.extensionId);
  const name = useExtensions((s) => s.installed.find((x) => x.id.toLowerCase() === extensionId?.toLowerCase())?.manifest.displayName) ?? extensionId ?? "the extension";
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    attachSlot(handle, el);
    return () => detachSlot(handle, el);
  }, [handle]);
  const phase = status?.phase ?? "starting";
  const problems = (status?.diagnostics ?? []).filter((d) => !(d.kind === "csp" && /CSP refused style-src/.test(d.text)));
  return (
    <div ref={ref} className={`tm-webview-slot ${className}`} data-webview-slot={handle} data-phase={phase}>
      {phase === "starting" && (
        <div className="tm-webview-starting" role="status" data-testid="webview-starting">
          <Codicon name="loading" className="codicon-modifier-spin" />
          <span>Starting {name}…</span>
        </div>
      )}
      {phase === "stuck" && (
        <div className="tm-webview-stuck" role="alert" data-testid="webview-stuck">
          <p className="tm-webview-stuck-title">
            <Codicon name="warning" /> {name} didn&apos;t start
          </p>
          <p className="tm-muted">{problems.length ? "Its page reported:" : "Its page loaded, but the extension's interface never answered."}</p>
          {problems.length > 0 && (
            <ul className="tm-webview-stuck-list">
              {problems.slice(0, 5).map((d, i) => (
                <li key={i}>{d.text}</li>
              ))}
            </ul>
          )}
          <div className="tm-webview-stuck-actions">
            <button type="button" className="tm-button tm-button--small" onClick={() => reloadWebview(handle)} data-testid="webview-reload">
              <Codicon name="refresh" /> Reload
            </button>
            <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => (useOutputChannel.setState({ selected: HOST_CHANNEL }), showPanel("output"))}>
              Show Log
            </button>
            <button type="button" className="tm-link-button" onClick={() => showWebviewAnyway(handle)}>
              Show It Anyway
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The layer every webview iframe lives in (over the workbench, under menus and dialogs). */
export function WebviewLayer() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setWebviewLayer(ref.current);
    return () => setWebviewLayer(null);
  }, []);
  return <div ref={ref} className="tm-webview-layer" aria-hidden={false} />;
}

/** A webview panel as an editor (`window.createWebviewPanel`). */
export function WebviewEditor({ handle }: { handle: string }) {
  const exists = useWebviews((s) => !!s.entries[handle]);
  if (!exists) return <div className="tm-view-hint">This webview is no longer available.</div>;
  return <WebviewSlot handle={handle} className="tm-webview-editor" />;
}

export function webviewTitle(handle: string): string {
  const e = useWebviews.getState().entries[handle];
  return e?.title || e?.viewType || "Webview";
}
