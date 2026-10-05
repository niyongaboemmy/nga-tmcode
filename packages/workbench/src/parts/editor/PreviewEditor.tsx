import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getDocument, onDocumentChanged } from "../../monaco/documents";
import { PREVIEW_MESSAGE_KEY, injectIntoHead, inlineAssets, resolveRelative, shimTag } from "../../preview/compose";
import { composeReactPage, errorPage } from "../../preview/page";
import { getPlatform, notify, useWorkbench, type EditorInput } from "../../state/store";
import { isWithin, join } from "../../util/paths";
import { ActionButton, Codicon } from "../../widgets/icons";

type PreviewInput = Extract<EditorInput, { kind: "preview" }>;

const DEVICES = {
  responsive: { label: "Responsive", icon: "screen-full", width: 0, height: 0 },
  mobile: { label: "Mobile (375)", icon: "device-mobile", width: 375, height: 667 },
  tablet: { label: "Tablet (768)", icon: "device-mobile", width: 768, height: 1024 },
  desktop: { label: "Laptop (1280)", icon: "device-desktop", width: 1280, height: 800 },
} as const;
type Device = keyof typeof DEVICES;

interface LogLine {
  id: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  count: number;
}

let logSeq = 0;

export function PreviewEditor({ input }: { input: PreviewInput }) {
  const [entry, setEntry] = useState(input.entry);
  const [frame, setFrame] = useState<{ url?: string; srcdoc?: string; key: number }>({ key: 0 });
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<Device>("responsive");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [title, setTitle] = useState("");
  const [scale, setScale] = useState(1);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const internet = useWorkbench((s) => s.policy.internet_in_preview);
  const platform = getPlatform();
  const generation = useRef(0);

  useEffect(() => setEntry(input.entry), [input.entry]);

  /** Project-relative read that prefers unsaved editor contents. */
  const read = useCallback(
    async (rel: string): Promise<string | null> => {
      const path = join(input.root, rel);
      const model = getDocument(path);
      if (model) return model.getValue();
      return platform.fs.readFile(path).catch(() => null);
    },
    [input.root, platform],
  );

  const compose = useCallback(async () => {
    const gen = ++generation.current;
    setBusy(true);
    setLogs([]);
    let html = await read(entry);
    if (html === null) html = errorPage("Page not found", [`${join(input.root, entry)} does not exist.`]);
    else if (input.profile === "bundle-react") {
      html = await composeReactPage(html, entry, read);
      if (gen !== generation.current) return;
    }
    html = injectIntoHead(html, shimTag());
    try {
      if (platform.preview) {
        // Unsaved edits inside the project are served instead of what's on disk.
        const overlay: Record<string, string> = { [entry]: html };
        for (const path of Object.keys(useWorkbench.getState().dirty)) {
          if (isWithin(path, input.root) && path !== join(input.root, entry)) {
            const v = getDocument(path)?.getValue();
            if (v !== undefined) overlay[input.root ? path.slice(input.root.length + 1) : path] = v;
          }
        }
        const url = await platform.preview.publish(input.root, entry, overlay, { internet });
        if (gen === generation.current) setFrame((f) => ({ url, key: f.key + 1 }));
      } else {
        const inlined = await inlineAssets(html, entry, read);
        for (const m of inlined.missing) pushLog("error", `Failed to load resource: ${m}`);
        if (gen === generation.current) setFrame((f) => ({ srcdoc: inlined.html, key: f.key + 1 }));
      }
    } catch (e) {
      notify("error", `Preview failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      if (gen === generation.current) setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, input.root, input.profile, internet, platform, read]);

  useEffect(() => {
    void compose();
  }, [compose]);

  // Live reload while typing (debounced), for any file of this project.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onDocumentChanged((path) => {
      if (!isWithin(path, input.root)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void compose(), 450);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [compose, input.root]);

  function pushLog(level: LogLine["level"], text: string) {
    setLogs((list) => {
      const last = list[list.length - 1];
      if (last && last.text === text && last.level === level) return [...list.slice(0, -1), { ...last, count: last.count + 1 }];
      return [...list, { id: ++logSeq, level, text, count: 1 }].slice(-500);
    });
  }

  // Messages from the page (console shim).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || !d[PREVIEW_MESSAGE_KEY]) return;
      if (d.kind === "console") pushLog((d.level as LogLine["level"]) ?? "log", String(d.text ?? ""));
      else if (d.kind === "loaded") setTitle(String(d.title ?? ""));
      else if (d.kind === "navigate") {
        const next = resolveRelative(entry, String(d.href));
        if (next) setEntry(next);
      } else if (d.kind === "external") pushLog("info", `Links to other websites are disabled in the preview: ${String(d.href)}`);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [entry]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  // Scale fixed-size devices down to fit the stage.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const d = DEVICES[device];
      if (!d.width) return setScale(1);
      const s = Math.min(1, (el.clientWidth - 32) / d.width, (el.clientHeight - 32) / d.height);
      setScale(Math.max(0.2, s));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [device]);

  const errors = logs.filter((l) => l.level === "error").reduce((n, l) => n + l.count, 0);
  const warnings = logs.filter((l) => l.level === "warn").reduce((n, l) => n + l.count, 0);
  const d = DEVICES[device];

  return (
    <div className="tm-preview">
      <div className="tm-preview-toolbar">
        <ActionButton icon="refresh" label="Reload" onClick={() => void compose()} />
        <div className="tm-preview-address" title={join(input.root, entry)}>
          <Codicon name={busy ? "loading" : internet ? "globe" : "lock"} className={busy ? "codicon-modifier-spin" : ""} />
          <span>{join(input.root, entry) || entry}</span>
          {title && <span className="tm-preview-title">— {title}</span>}
        </div>
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
        <button type="button" className={`tm-preview-console-toggle ${consoleOpen ? "is-on" : ""}`} onClick={() => setConsoleOpen(!consoleOpen)} aria-pressed={consoleOpen}>
          <Codicon name="debug-console" /> Console
          {errors > 0 && <span className="tm-badge tm-badge--error">{errors}</span>}
          {warnings > 0 && <span className="tm-badge tm-badge--warning">{warnings}</span>}
        </button>
      </div>
      <div ref={stageRef} className={`tm-preview-stage ${d.width ? "is-device" : ""}`}>
        <div
          className="tm-preview-device"
          style={d.width ? { width: d.width, height: d.height, transform: `scale(${scale})` } : undefined}
        >
          <iframe
            key={frame.key}
            ref={iframeRef}
            title="Preview"
            className="tm-preview-frame"
            sandbox="allow-scripts allow-forms allow-modals"
            src={frame.url}
            srcDoc={frame.url ? undefined : frame.srcdoc}
            data-testid="preview-frame"
          />
        </div>
        {d.width > 0 && scale < 1 && <div className="tm-preview-scale">{Math.round(scale * 100)}%</div>}
      </div>
      {consoleOpen && (
        <div className="tm-preview-console">
          <div className="tm-preview-console-head">
            <span>Console</span>
            <ActionButton icon="clear-all" label="Clear Console" onClick={() => setLogs([])} />
          </div>
          <div ref={logRef} className="tm-preview-console-body tm-scroll tm-mono" role="log" aria-live="polite">
            {logs.length === 0 && <div className="tm-muted tm-preview-console-empty">Output from console.log() appears here.</div>}
            {logs.map((l) => (
              <div key={l.id} className={`tm-console-line is-${l.level}`}>
                {(l.level === "error" || l.level === "warn") && <Codicon name={l.level === "error" ? "error" : "warning"} />}
                <span className="tm-console-text">{l.text}</span>
                {l.count > 1 && <span className="tm-console-count">{l.count}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
