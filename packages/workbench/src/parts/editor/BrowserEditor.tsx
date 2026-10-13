import { useEffect, useState } from "react";
import { openExternalUrl } from "../../terminal/browser";
import type { EditorInput } from "../../state/store";
import { ActionButton, Codicon } from "../../widgets/icons";
import { SkeletonLines } from "../../widgets/Skeleton";
import { DeviceControls, DeviceStage } from "./deviceView";

type BrowserInput = Extract<EditorInput, { kind: "browser" }>;

/** Accepts "localhost:3000", ":8080/api" or a full URL. */
export function normalizeUrl(raw: string): string | null {
  let v = raw.trim();
  if (!v) return null;
  if (/^:\d+/.test(v)) v = `localhost${v}`;
  if (!/^[a-z]+:\/\//i.test(v)) v = `http://${v}`;
  try {
    return new URL(v).toString();
  } catch {
    return null;
  }
}

/**
 * VS Code's Simple Browser: the developer's own dev server (Vite, Next, Angular,
 * Spring, Django…) inside the workbench, with history, reload and device sizes.
 */
export function BrowserEditor({ input }: { input: BrowserInput }) {
  const [history, setHistory] = useState({ list: [input.url], at: 0 });
  const [draft, setDraft] = useState(input.url);
  const [reloads, setReloads] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const url = history.list[history.at];

  const navigate = (next: string) => {
    setHistory((h) => ({ list: [...h.list.slice(0, h.at + 1), next], at: h.at + 1 }));
    setDraft(next);
    setLoading(true);
  };
  const go = (delta: number) => {
    setHistory((h) => {
      const at = Math.max(0, Math.min(h.list.length - 1, h.at + delta));
      setDraft(h.list[at]);
      return { ...h, at };
    });
    setLoading(true);
  };

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);

  return (
    <div className={`tm-preview tm-browser ${fullscreen ? "is-fullscreen" : ""}`} role={fullscreen ? "dialog" : undefined} aria-modal={fullscreen || undefined}>
      <div className="tm-preview-toolbar">
        <ActionButton icon="arrow-left" label="Back" disabled={history.at === 0} onClick={() => go(-1)} />
        <ActionButton icon="arrow-right" label="Forward" disabled={history.at >= history.list.length - 1} onClick={() => go(1)} />
        <ActionButton
          icon="refresh"
          label="Reload"
          onClick={() => {
            setLoading(true);
            setReloads((n) => n + 1);
          }}
        />
        <form
          className="tm-preview-address tm-browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            const next = normalizeUrl(draft);
            if (next) navigate(next);
          }}
        >
          <Codicon name={loading ? "loading" : "globe"} className={loading ? "codicon-modifier-spin" : ""} />
          <input className="tm-browser-url" value={draft} spellCheck={false} aria-label="Address" onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()} />
        </form>
        <DeviceControls />
        <ActionButton icon="link-external" label="Open in External Browser" onClick={() => void openExternalUrl(url)} />
        <ActionButton icon={fullscreen ? "screen-normal" : "screen-full"} label={fullscreen ? "Exit Full Screen (Escape)" : "Full Screen"} active={fullscreen} aria-pressed={fullscreen} onClick={() => setFullscreen(!fullscreen)} />
      </div>
      <DeviceStage
        overlay={
          <>
        {loading && loadedOnce && <div className="tm-progress tm-browser-progress" role="progressbar" aria-label="Loading" />}
        {loading && !loadedOnce && (
          <div className="tm-preview-loading">
            <SkeletonLines lines={7} label={`Loading ${url}`} />
          </div>
        )}
          </>
        }
      >
          <iframe
            key={`${history.at}:${reloads}`}
            title={`Browser ${url}`}
            className="tm-preview-frame"
            // The dev server is its own origin (localhost:port), never TMCode's, so same-origin is safe and HMR/storage work.
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
            src={url}
            onLoad={() => {
              setLoading(false);
              setLoadedOnce(true);
            }}
            data-testid="browser-frame"
          />
      </DeviceStage>
    </div>
  );
}
