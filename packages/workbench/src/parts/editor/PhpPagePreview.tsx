import { useCallback, useEffect, useRef, useState } from "react";
import { onDocumentSaved } from "../../monaco/documents";
import { renderPhpPage, requestFor } from "../../run/phpRunner";
import type { PhpRequest } from "../../run/phpPages";
import { getPlatform, notify, useWorkbench, type EditorInput } from "../../state/store";
import { isWithin, join } from "../../util/paths";
import { listenToRun, newRunId, type ConsoleEntry } from "../../vendor/nga-webrun";
import { ActionButton, Codicon } from "../../widgets/icons";
import { SkeletonLines } from "../../widgets/Skeleton";
import { DeviceControls, DeviceStage } from "./deviceView";

type PreviewInput = Extract<EditorInput, { kind: "preview" }>;

interface LogLine {
  id: number;
  level: ConsoleEntry["level"];
  text: string;
}

/** The page the desktop serves at its preview origin (scripts may not run in an srcdoc there). */
const PAGE_FILE = "_tmcode_php_page.html";

let logSeq = 0;

/**
 * A PHP site's pages run on the school's code runner (run/phpRunner): the page PHP printed, in a
 * sandboxed frame, its links and forms running the next page the same way. Saving a file of the
 * site runs the page again; Back returns to the page before.
 */
export function PhpPagePreview({ input }: { input: PreviewInput }) {
  const [req, setReq] = useState<PhpRequest>({ path: input.entry, method: "GET", query: "", fields: [] });
  const [history, setHistory] = useState<PhpRequest[]>([]);
  const [frame, setFrame] = useState<{ url?: string; srcdoc?: string; key: number }>({ key: 0 });
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const internet = useWorkbench((s) => s.policy.internet_in_preview);
  const logRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);

  const pushLog = useCallback((level: LogLine["level"], text: string) => {
    setLogs((list) => [...list, { id: ++logSeq, level, text }].slice(-500));
  }, []);

  const run = useCallback(
    async (next: PhpRequest) => {
      const gen = ++generation.current;
      const id = newRunId();
      setBusy(true);
      pushLog("info", `${next.method} ${next.path}${next.query ? `?${next.query}` : ""}${next.fields.length ? ` (${next.fields.length} field${next.fields.length === 1 ? "" : "s"})` : ""}`);
      try {
        const page = await renderPhpPage(input.root, next, id);
        if (gen !== generation.current) return;
        for (const l of page.logs) pushLog(l.level, l.text);
        const preview = getPlatform().preview;
        const url = preview ? await preview.publish(input.root, PAGE_FILE, { [PAGE_FILE]: page.doc }, { internet }) : undefined;
        if (gen !== generation.current) return;
        setRunId(id);
        setFrame((f) => (url ? { url, key: f.key + 1 } : { srcdoc: page.doc, key: f.key + 1 }));
      } catch (e) {
        notify("error", `Preview failed: ${String((e as Error)?.message ?? e)}`);
      } finally {
        if (gen === generation.current) setBusy(false);
      }
    },
    [input.root, internet, pushLog],
  );

  // Opened (or opened again by Run): the entry page, with the note on why it runs here.
  useEffect(() => {
    const first: PhpRequest = { path: input.entry, method: "GET", query: "", fields: [] };
    setLogs(input.note ? [{ id: ++logSeq, level: "info", text: input.note }] : []);
    setHistory([]);
    setReq(first);
    void run(first);
  }, [input.entry, input.note, input.opened, run]);

  // A link or form in the page: run what it asks for.
  const reqRef = useRef(req);
  reqRef.current = req;
  useEffect(() => {
    if (!runId) return;
    return listenToRun(
      runId,
      (e) => pushLog(e.level === "result" ? "log" : e.level, e.text),
      () => {},
      (nav) => {
        const next = requestFor(reqRef.current.path, nav);
        setHistory((h) => [...h, reqRef.current].slice(-30));
        setReq(next);
        void run(next);
      },
    );
  }, [runId, run, pushLog]);

  // Saving a file of the site shows its change: the page runs again (a form's POST becomes a GET).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onDocumentSaved((path) => {
      if (!isWithin(path, input.root)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const again = { ...reqRef.current, method: "GET" as const, fields: [] };
        setReq(again);
        void run(again);
      }, 150);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [input.root, run]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    const again = { ...prev, method: "GET" as const, fields: [] };
    setReq(again);
    void run(again);
  };

  const errors = logs.filter((l) => l.level === "error").length;
  const warnings = logs.filter((l) => l.level === "warn").length;
  const address = `${join(input.root, req.path)}${req.query ? `?${req.query}` : ""}`;
  return (
    <div className="tm-preview" data-testid="php-preview">
      <div className="tm-preview-toolbar">
        <ActionButton icon="arrow-left" label="Back" disabled={!history.length} onClick={back} />
        <ActionButton icon="refresh" label="Run the Page Again" onClick={() => void run({ ...req, method: "GET", fields: [] })} />
        <div className="tm-preview-address" title={`${address}, run on the school's code runner`}>
          <Codicon name={busy ? "loading" : "cloud"} className={busy ? "codicon-modifier-spin" : ""} />
          <span>{address}</span>
          <span className="tm-preview-title">— school's code runner</span>
        </div>
        <DeviceControls />
        <button type="button" className={`tm-preview-console-toggle ${consoleOpen ? "is-on" : ""}`} onClick={() => setConsoleOpen(!consoleOpen)} aria-pressed={consoleOpen}>
          <Codicon name="debug-console" /> Console
          {errors > 0 && <span className="tm-badge tm-badge--error">{errors}</span>}
          {warnings > 0 && <span className="tm-badge tm-badge--warning">{warnings}</span>}
        </button>
      </div>
      <DeviceStage
        overlay={
          busy &&
          frame.key === 0 && (
            <div className="tm-preview-loading">
              <SkeletonLines lines={7} label="Running the page on the school's code runner" />
            </div>
          )
        }
      >
        <iframe
          key={frame.key}
          title="PHP page"
          className="tm-preview-frame"
          sandbox="allow-scripts allow-forms allow-modals"
          src={frame.url}
          srcDoc={frame.url ? undefined : frame.srcdoc}
          data-testid="php-preview-frame"
        />
      </DeviceStage>
      {consoleOpen && (
        <div className="tm-preview-console">
          <div className="tm-preview-console-head">
            <span>Console</span>
            <ActionButton icon="clear-all" label="Clear Console" onClick={() => setLogs([])} />
          </div>
          <div ref={logRef} className="tm-preview-console-body tm-scroll tm-mono" role="log" aria-live="polite">
            {logs.length === 0 && <div className="tm-muted tm-preview-console-empty">PHP warnings and the page's console.log() appear here.</div>}
            {logs.map((l) => (
              <div key={l.id} className={`tm-console-line is-${l.level}`}>
                {(l.level === "error" || l.level === "warn") && <Codicon name={l.level === "error" ? "error" : "warning"} />}
                <span className="tm-console-text">{l.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
