import { useLayoutEffect, useRef, useState } from "react";
import { openExternalUrl } from "../../terminal/browser";
import type { EditorInput } from "../../state/store";
import { ActionButton, Codicon } from "../../widgets/icons";
import { SkeletonLines } from "../../widgets/Skeleton";
import { DEVICES, type Device } from "./PreviewEditor";

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
  const [device, setDevice] = useState<Device>("responsive");
  const [scale, setScale] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
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

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const d = DEVICES[device];
      if (!d.width) return setScale(1);
      setScale(Math.max(0.2, Math.min(1, (el.clientWidth - 32) / d.width, (el.clientHeight - 32) / d.height)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [device]);

  const d = DEVICES[device];
  return (
    <div className="tm-preview tm-browser">
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
        <div className="tm-segmented" role="radiogroup" aria-label="Device">
          {(Object.keys(DEVICES) as Device[]).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={device === k}
              className={device === k ? "is-on" : ""}
              title={DEVICES[k].label}
              aria-label={DEVICES[k].label}
              onClick={() => setDevice(k)}
            >
              <Codicon name={DEVICES[k].icon} />
              {k !== "responsive" && <span>{DEVICES[k].width}</span>}
            </button>
          ))}
        </div>
        <ActionButton icon="link-external" label="Open in External Browser" onClick={() => void openExternalUrl(url)} />
      </div>
      <div ref={stageRef} className={`tm-preview-stage ${d.width ? "is-device" : ""}`}>
        <div className="tm-preview-device" style={d.width ? { width: d.width, height: d.height, transform: `scale(${scale})` } : undefined}>
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
        </div>
        {loading && loadedOnce && <div className="tm-progress tm-browser-progress" role="progressbar" aria-label="Loading" />}
        {loading && !loadedOnce && (
          <div className="tm-preview-loading">
            <SkeletonLines lines={7} label={`Loading ${url}`} />
          </div>
        )}
      </div>
    </div>
  );
}
