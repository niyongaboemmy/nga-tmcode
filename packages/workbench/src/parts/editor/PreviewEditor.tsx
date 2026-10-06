import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getDocument, onDocumentChanged, onDocumentSaved } from "../../monaco/documents";
import { revealInEditor } from "../../monaco/reveal";
import { PREVIEW_MESSAGE_KEY, injectIntoHead, inlineAssets, resolveRelative, scrollTag, shimTag } from "../../preview/compose";
import type { JsValue } from "../../run/jsInspect";
import { JsArgs } from "../panel/JsConsoleView";
import { composeReactPage, errorPage } from "../../preview/page";
import { getPlatform, notify, updateSetting, useWorkbench, type EditorInput } from "../../state/store";
import { isWithin, join } from "../../util/paths";
import { ActionButton, Codicon } from "../../widgets/icons";
import { SkeletonLines } from "../../widgets/Skeleton";

type PreviewInput = Extract<EditorInput, { kind: "preview" }>;

export const DEVICES = {
  responsive: { label: "Responsive", icon: "screen-full", width: 0, height: 0 },
  mobile: { label: "Mobile (375)", icon: "device-mobile", width: 375, height: 667 },
  tablet: { label: "Tablet (768)", icon: "device-mobile", width: 768, height: 1024 },
  desktop: { label: "Laptop (1280)", icon: "device-desktop", width: 1280, height: 800 },
} as const;
export type Device = keyof typeof DEVICES;

interface LogLine {
  id: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  count: number;
  /** Structured values from the page (objects expand). */
  args?: JsValue[];
  /** Where an uncaught error was thrown (a URL of the preview origin). */
  source?: { file: string; line: number; column: number };
}

const noLoad = async () => [] as [string, JsValue][];

/** Opens the file behind a preview URL ("http://127.0.0.1:port/…/js/app.js") at a line, if it is in the project. */
async function revealPreviewSource(root: string, source: NonNullable<LogLine["source"]>) {
  let path: string;
  try {
    path = decodeURIComponent(new URL(source.file).pathname);
  } catch {
    return;
  }
  const parts = path.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const candidate = join(root, parts.slice(i).join("/"));
    if (getDocument(candidate) || (await getPlatform().fs.readFile(candidate).then(() => true, () => false))) {
      revealInEditor(candidate, source.line, source.column);
      return;
    }
  }
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
  const updateOn = useWorkbench((s) => s.settings["livePreview.updateOn"]);
  const follow = useWorkbench((s) => s.settings["livePreview.followActiveFile"]);
  // Where the student had scrolled: a live reload puts the page back there.
  const scroll = useRef({ x: 0, y: 0 });
  const platform = getPlatform();
  const generation = useRef(0);

  useEffect(() => setEntry(input.entry), [input.entry]);
  useEffect(() => {
    scroll.current = { x: 0, y: 0 };
  }, [entry]);

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
    html = injectIntoHead(html, scrollTag(scroll.current.x, scroll.current.y) + shimTag());
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

  // Live reload while typing (debounced) or on save (setting), for any file of this project.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const listen = updateOn === "onSave" ? onDocumentSaved : onDocumentChanged;
    const off = listen((path) => {
      if (!isWithin(path, input.root)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void compose(), updateOn === "onSave" ? 60 : 450);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [compose, input.root, updateOn]);

  function pushLog(level: LogLine["level"], text: string, extra: Pick<LogLine, "args" | "source"> = {}) {
    setLogs((list) => {
      const last = list[list.length - 1];
      if (last && last.text === text && last.level === level) return [...list.slice(0, -1), { ...last, count: last.count + 1 }];
      return [...list, { id: ++logSeq, level, text, count: 1, ...extra }].slice(-500);
    });
  }

  // Messages from the page (console shim).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || !d[PREVIEW_MESSAGE_KEY]) return;
      if (d.kind === "console") {
        const source = d.source as LogLine["source"] | undefined;
        pushLog((d.level as LogLine["level"]) ?? "log", String(d.text ?? ""), {
          args: Array.isArray(d.args) ? (d.args as JsValue[]) : undefined,
          source: source && /^https?:/.test(source.file) ? source : undefined,
        });
      } else if (d.kind === "scroll") scroll.current = { x: Number(d.x) || 0, y: Number(d.y) || 0 };
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
        <ActionButton
          icon={updateOn === "onSave" ? "save" : "zap"}
          label={updateOn === "onSave" ? "Updates on Save (click to update as you type)" : "Updates as You Type (click to update on save)"}
          onClick={() => updateSetting("livePreview.updateOn", updateOn === "onSave" ? "onType" : "onSave")}
        />
        {input.profile === "static" && (
          <ActionButton
            icon="arrow-swap"
            label="Follow Active HTML File"
            active={follow}
            aria-pressed={follow}
            onClick={() => updateSetting("livePreview.followActiveFile", !follow)}
          />
        )}
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
        {busy && frame.key === 0 && (
          <div className="tm-preview-loading">
            <SkeletonLines lines={7} label={input.profile === "bundle-react" ? "Building the React app" : "Loading the page"} />
          </div>
        )}
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
                <span className="tm-console-text">
                  {l.args?.length ? <JsArgs args={l.args} load={noLoad} /> : l.text}
                  {l.source && (
                    <>
                      {" "}
                      <button type="button" className="tm-jsv-link" title="Go to the line" onClick={() => void revealPreviewSource(input.root, l.source!)}>
                        {l.source.file.split("/").pop()}:{l.source.line}
                      </button>
                    </>
                  )}
                </span>
                {l.count > 1 && <span className="tm-console-count">{l.count}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
