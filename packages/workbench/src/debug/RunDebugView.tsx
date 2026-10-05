import { useEffect, useRef, useState, type ReactNode } from "react";
import { executeCommand, formatKeybinding } from "../commands/registry";
import { activeFilePath, getPlatform, openContextMenu, openFile, useWorkbench } from "../state/store";
import { basename, dirname } from "../util/paths";
import { ActionButton, Codicon } from "../widgets/icons";
import { SkeletonRows as SkeletonRows_ } from "../widgets/Skeleton";
import type { Variable } from "./dap";
import {
  addWatch,
  currentConfig,
  debugAllowed,
  debugKindForPath,
  editWatch,
  loadChildren,
  pickConfiguration,
  removeAllBreakpoints,
  removeAllWatches,
  removeBreakpoint,
  removeWatch,
  revealLocation,
  selectConfiguration,
  selectFrame,
  setAllBreakpointsEnabled,
  setExceptionFilter,
  setVariableValue,
  startDebugging,
  toggleBreakpointsActive,
  updateBreakpoint,
  useDebug,
  type BreakpointModel,
  type ThreadView,
} from "./debugService";
import { editBreakpointCondition } from "./editorContrib";
import { LAUNCH_FILE } from "./launchJson";
import { InstallCard } from "./InstallCard";
import { guideById, missingToolchain } from "./installGuide";
import { useExam } from "../exam/state";

// ───────────── shared bits ─────────────

/** VS Code colours debug values by kind (number, string, boolean, null). */
export function valueClass(value: string, type?: string): string {
  const t = (type ?? "").toLowerCase();
  if (/^-?\d/.test(value) || ["int", "float", "number", "double", "long", "bigint"].includes(t)) return "tm-dv-number";
  if (/^['"`]/.test(value) || t === "str" || t === "string") return "tm-dv-string";
  if (/^(true|false)$/i.test(value) || t === "bool" || t === "boolean") return "tm-dv-boolean";
  if (/^(none|null|undefined|nil)$/i.test(value)) return "tm-dv-null";
  return "tm-dv-value";
}

/** Expanded tree nodes survive stepping (keys are name paths, not adapter references). */
const expandedKeys = new Set<string>();

function Section({ id, title, actions, children, defaultOpen = true, grow = 1 }: { id: string; title: string; actions?: ReactNode; children: ReactNode; defaultOpen?: boolean; grow?: number }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`tm-pane tm-debug-section ${open ? "is-open" : "is-collapsed"}`} style={open ? { flexGrow: grow } : undefined} aria-label={title} data-section={id}>
      <div className="tm-pane-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}>
        <span className="tm-twistie">
          <Codicon name={open ? "chevron-down" : "chevron-right"} />
        </span>
        <span className="tm-pane-title">{title}</span>
        {open && actions && (
          <div className="tm-pane-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
      {open && <div className="tm-pane-body tm-scroll tm-debug-section-body">{children}</div>}
    </section>
  );
}

function SkeletonRows({ n = 3 }: { n?: number }) {
  return (
    <div className="tm-debug-skeleton">
      <SkeletonRows_ rows={n} icon={false} label="Loading" />
    </div>
  );
}

// ───────────── variables ─────────────

function VariableRow({ v, parentRef, depth, path }: { v: Variable; parentRef: number; depth: number; path: string }) {
  const key = `${path}/${v.name}`;
  const [open, setOpen] = useState(expandedKeys.has(key));
  const [editing, setEditing] = useState(false);
  const children = useDebug((s) => (v.variablesReference ? s.children[v.variablesReference] : undefined));
  const canSet = useDebug((s) => !!s.capabilities.supportsSetVariable);
  const expandable = v.variablesReference > 0;

  useEffect(() => {
    if (open && expandable && children === undefined) void loadChildren(v.variablesReference);
  }, [open, expandable, children, v.variablesReference]);

  const toggle = () => {
    if (!expandable) return;
    if (open) expandedKeys.delete(key);
    else expandedKeys.add(key);
    setOpen(!open);
  };

  return (
    <>
      <div
        className="tm-list-row tm-debug-var"
        role="treeitem"
        aria-expanded={expandable ? open : undefined}
        aria-level={depth + 1}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={v.type ? `${v.name}: ${v.type}` : v.name}
        onClick={toggle}
        onDoubleClick={() => canSet && !expandable && setEditing(true)}
        onContextMenu={(e) => {
          e.preventDefault();
          openContextMenu(e.clientX, e.clientY, [
            { kind: "item", label: "Set Value", disabled: !canSet, run: () => setEditing(true) },
            { kind: "item", label: "Copy Value", run: () => void navigator.clipboard?.writeText(v.value) },
            { kind: "item", label: "Copy as Expression", disabled: !v.evaluateName, run: () => void navigator.clipboard?.writeText(v.evaluateName ?? v.name) },
            { kind: "separator" },
            { kind: "item", label: "Add to Watch", disabled: !v.evaluateName, run: () => void addWatch(v.evaluateName ?? v.name) },
          ]);
        }}
      >
        <span className="tm-twistie">{expandable && <Codicon name={open ? "chevron-down" : "chevron-right"} />}</span>
        <span className={`tm-dv-name ${v.presentationHint?.kind === "virtual" ? "is-virtual" : ""}`}>{v.name}</span>
        {editing ? (
          <InlineInput
            initial={v.value}
            label={`Set value of ${v.name}`}
            onDone={(value) => {
              setEditing(false);
              if (value !== null && value !== v.value) void setVariableValue(parentRef, v, value);
            }}
          />
        ) : (
          <span className={`tm-dv-v ${valueClass(v.value, v.type)}`}>{v.value}</span>
        )}
      </div>
      {open && expandable && <Children ref_={v.variablesReference} depth={depth + 1} path={key} />}
    </>
  );
}

function Children({ ref_, depth, path }: { ref_: number; depth: number; path: string }) {
  const children = useDebug((s) => s.children[ref_]);
  if (children === undefined || children === "loading") return <div style={{ paddingLeft: 8 + depth * 12 }}><SkeletonRows n={2} /></div>;
  if (!Array.isArray(children)) return <div className="tm-debug-error" style={{ paddingLeft: 24 + depth * 12 }}>{children.error}</div>;
  return (
    <>
      {children.map((c, i) => (
        <VariableRow key={`${c.name}-${i}`} v={c} parentRef={ref_} depth={depth} path={path} />
      ))}
    </>
  );
}

function InlineInput({ initial, label, onDone, placeholder }: { initial: string; label: string; placeholder?: string; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      className="tm-input tm-debug-inline-input"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value)}
    />
  );
}

function VariablesSection() {
  const scopes = useDebug((s) => s.scopes);
  const phase = useDebug((s) => s.phase);
  const [openScopes, setOpenScopes] = useState<Record<string, boolean>>({});
  return (
    <Section id="variables" title="Variables" grow={3}>
      <div role="tree" aria-label="Variables" className="tm-debug-tree">
        {phase === "stopped" && !scopes.length && <SkeletonRows />}
        {scopes.map((sc, i) => {
          const open = openScopes[sc.name] ?? (i === 0 && !sc.expensive);
          return (
            <div key={sc.name}>
              <div
                className="tm-list-row tm-debug-scope"
                role="treeitem"
                aria-expanded={open}
                onClick={() => {
                  setOpenScopes({ ...openScopes, [sc.name]: !open });
                  if (!open) void loadChildren(sc.ref);
                }}
              >
                <span className="tm-twistie">
                  <Codicon name={open ? "chevron-down" : "chevron-right"} />
                </span>
                <span className="tm-debug-scope-name">{sc.name}</span>
              </div>
              {open && <Children ref_={sc.ref} depth={1} path={sc.name} />}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ───────────── watch ─────────────

function WatchSection() {
  const watches = useDebug((s) => s.watches);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  return (
    <Section
      id="watch"
      title="Watch"
      grow={1}
      actions={
        <>
          <ActionButton icon="add" label="Add Expression" onClick={() => setAdding(true)} />
          <ActionButton icon="close-all" label="Remove All Expressions" onClick={removeAllWatches} />
        </>
      }
    >
      <div role="tree" aria-label="Watch" className="tm-debug-tree">
        {watches.map((w) =>
          editing === w.id ? (
            <div key={w.id} className="tm-list-row tm-debug-var" style={{ paddingLeft: 24 }}>
              <InlineInput
                initial={w.expression}
                label="Edit watch expression"
                onDone={(v) => {
                  setEditing(null);
                  if (v !== null) void editWatch(w.id, v);
                }}
              />
            </div>
          ) : (
            <div key={w.id}>
              <div
                className="tm-list-row tm-debug-var tm-debug-watch"
                role="treeitem"
                aria-expanded={w.ref ? !!open[w.id] : undefined}
                style={{ paddingLeft: 8 }}
                onClick={() => {
                  if (!w.ref) return;
                  setOpen({ ...open, [w.id]: !open[w.id] });
                  if (!open[w.id]) void loadChildren(w.ref);
                }}
                onDoubleClick={() => setEditing(w.id)}
              >
                <span className="tm-twistie">{w.ref ? <Codicon name={open[w.id] ? "chevron-down" : "chevron-right"} /> : null}</span>
                <span className="tm-dv-name">{w.expression}</span>
                {w.error ? (
                  <span className="tm-dv-v tm-dv-error" title={w.error}>
                    {w.error}
                  </span>
                ) : w.result !== undefined ? (
                  <span className={`tm-dv-v ${valueClass(w.result, w.type)}`}>{w.result}</span>
                ) : (
                  <span className="tm-dv-v tm-dv-unavailable">not available</span>
                )}
                <span className="tm-row-actions">
                  <ActionButton icon="edit" label="Edit Expression" onClick={(e) => (e.stopPropagation(), setEditing(w.id))} />
                  <ActionButton icon="close" label="Remove Expression" onClick={(e) => (e.stopPropagation(), removeWatch(w.id))} />
                </span>
              </div>
              {w.ref && open[w.id] && <Children ref_={w.ref} depth={1} path={`watch:${w.expression}`} />}
            </div>
          ),
        )}
        {adding && (
          <div className="tm-list-row tm-debug-var" style={{ paddingLeft: 24 }}>
            <InlineInput
              initial=""
              label="Expression to watch"
              placeholder="Expression to watch"
              onDone={(v) => {
                setAdding(false);
                if (v) void addWatch(v);
              }}
            />
          </div>
        )}
      </div>
    </Section>
  );
}

// ───────────── call stack ─────────────

const REASON: Record<string, string> = { breakpoint: "Paused on breakpoint", step: "Paused on step", exception: "Paused on exception", pause: "Paused", entry: "Paused on entry", "function breakpoint": "Paused on function breakpoint", goto: "Paused" };

function ThreadRows({ t }: { t: ThreadView }) {
  const focus = useDebug((s) => s.focus);
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div className="tm-list-row tm-debug-thread" role="treeitem" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tm-twistie">
          <Codicon name={open ? "chevron-down" : "chevron-right"} />
        </span>
        <span className="tm-debug-thread-name">{t.name}</span>
        <span className="tm-debug-state">{t.stopped ? (REASON[t.reason ?? "pause"] ?? `Paused on ${t.reason}`) : "Running"}</span>
      </div>
      {open &&
        t.frames.map((f) => {
          const focused = focus?.sessionId === t.sessionId && focus.threadId === t.id && focus.frameId === f.id;
          return (
            <div
              key={f.id}
              role="treeitem"
              aria-selected={focused}
              className={`tm-list-row tm-debug-frame ${focused ? "is-selected" : ""} ${f.subtle || !f.path ? "is-subtle" : ""}`}
              title={f.path ? `${f.path}:${f.line}` : (f.sourceName ?? "Unknown Source")}
              onClick={() => void selectFrame(t.sessionId, t.id, f)}
            >
              <span className="tm-debug-frame-name">{f.name}</span>
              <span className="tm-debug-frame-loc">
                {f.sourceName ?? "Unknown Source"}
                {f.line ? `  ${f.line}:${f.column}` : ""}
              </span>
            </div>
          );
        })}
    </div>
  );
}

function CallStackSection() {
  const threads = useDebug((s) => s.threads);
  const phase = useDebug((s) => s.phase);
  const name = useDebug((s) => s.sessionName);
  return (
    <Section id="callstack" title="Call Stack" grow={2}>
      <div role="tree" aria-label="Call Stack" className="tm-debug-tree">
        {phase === "initializing" && <SkeletonRows n={2} />}
        {phase === "running" && !threads.some((t) => t.stopped) && (
          <div className="tm-list-row tm-debug-thread">
            <span className="tm-twistie" />
            <span className="tm-debug-thread-name">{name}</span>
            <span className="tm-debug-state">Running</span>
          </div>
        )}
        {threads.filter((t) => t.stopped || threads.length < 6).map((t) => (
          <ThreadRows key={`${t.sessionId}:${t.id}`} t={t} />
        ))}
      </div>
    </Section>
  );
}

// ───────────── breakpoints ─────────────

function BreakpointRow({ bp }: { bp: BreakpointModel }) {
  const active = useDebug((s) => s.breakpointsActive);
  const debugging = useDebug((s) => s.phase !== "inactive");
  const kind = bp.logMessage ? "log" : bp.condition || bp.hitCondition ? "conditional" : "";
  const icon = `debug-breakpoint${kind ? `-${kind}` : ""}${!bp.enabled || !active ? "-disabled" : debugging && bp.verified === false ? "-unverified" : ""}`;
  return (
    <div
      className="tm-list-row tm-debug-bp"
      role="treeitem"
      title={bp.logMessage ? `Log Message: ${bp.logMessage}` : bp.condition ? `Expression: ${bp.condition}` : bp.message ?? `${bp.path}:${bp.line}`}
      onClick={() => revealLocation(bp.path, bp.line)}
      onDoubleClick={() => void editBreakpointCondition(bp.path, bp.line, bp.logMessage ? "logMessage" : "condition")}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          { kind: "item", label: "Edit Condition...", run: () => void editBreakpointCondition(bp.path, bp.line, "condition") },
          { kind: "item", label: "Edit Log Message...", run: () => void editBreakpointCondition(bp.path, bp.line, "logMessage") },
          { kind: "item", label: "Edit Hit Count...", run: () => void editBreakpointCondition(bp.path, bp.line, "hitCondition") },
          { kind: "separator" },
          { kind: "item", label: bp.enabled ? "Disable Breakpoint" : "Enable Breakpoint", run: () => updateBreakpoint(bp.id, { enabled: !bp.enabled }) },
          { kind: "item", label: "Remove Breakpoint", run: () => removeBreakpoint(bp.id) },
          { kind: "item", label: "Remove All Breakpoints", run: removeAllBreakpoints },
        ]);
      }}
    >
      <input
        type="checkbox"
        className="tm-checkbox"
        aria-label={`${bp.enabled ? "Disable" : "Enable"} breakpoint ${basename(bp.path)}:${bp.line}`}
        checked={bp.enabled}
        onClick={(e) => e.stopPropagation()}
        onChange={() => updateBreakpoint(bp.id, { enabled: !bp.enabled })}
      />
      <Codicon name={icon} className={`tm-bp-icon ${icon.includes("disabled") || icon.includes("unverified") ? "is-muted" : ""}`} />
      <span className="tm-debug-bp-file">{basename(bp.path)}</span>
      <span className="tm-debug-bp-dir">{dirname(bp.path)}</span>
      <span className="tm-debug-bp-line">{bp.line}</span>
      <span className="tm-row-actions">
        <ActionButton icon="edit" label="Edit Condition" onClick={(e) => (e.stopPropagation(), void editBreakpointCondition(bp.path, bp.line, "condition"))} />
        <ActionButton icon="close" label="Remove Breakpoint" onClick={(e) => (e.stopPropagation(), removeBreakpoint(bp.id))} />
      </span>
    </div>
  );
}

function BreakpointsSection() {
  const breakpoints = useDebug((s) => s.breakpoints);
  const filters = useDebug((s) => s.exceptionFilters);
  const active = useDebug((s) => s.breakpointsActive);
  const sorted = [...breakpoints].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return (
    <Section
      id="breakpoints"
      title="Breakpoints"
      grow={1}
      actions={
        <>
          <ActionButton icon={active ? "activate-breakpoints" : "debug-breakpoint-unsupported"} label={active ? "Deactivate Breakpoints" : "Activate Breakpoints"} onClick={toggleBreakpointsActive} />
          <ActionButton icon="close-all" label="Remove All Breakpoints" onClick={removeAllBreakpoints} />
        </>
      }
    >
      <div role="tree" aria-label="Breakpoints" className="tm-debug-tree">
        {filters.map((f) => (
          <label key={f.filter} className="tm-list-row tm-debug-bp tm-debug-exc" title={f.description ?? f.label}>
            <input type="checkbox" className="tm-checkbox" checked={f.enabled} onChange={() => setExceptionFilter(f.filter, !f.enabled)} />
            <span className="tm-debug-bp-file">{f.label}</span>
          </label>
        ))}
        {sorted.map((bp) => (
          <BreakpointRow key={bp.id} bp={bp} />
        ))}
        {!sorted.length && !filters.length && <div className="tm-view-hint">Click in the editor's left margin (or press F9) to add a breakpoint.</div>}
        {sorted.length > 1 && (
          <div className="tm-debug-bp-tools">
            <button type="button" className="tm-link-button" onClick={() => setAllBreakpointsEnabled(!sorted.every((b) => b.enabled))}>
              {sorted.every((b) => b.enabled) ? "Disable All" : "Enable All"}
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

// ───────────── toolchain help ─────────────

/** The "how to install" card: asked for, or because the active file's toolchain is missing. */
function ToolchainHelp() {
  const file = useWorkbench((s) => activeFilePath(s));
  const toolchains = useDebug((s) => s.toolchains);
  const explicit = useDebug((s) => s.guide);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const platform = getPlatform();
  let shown: ReturnType<typeof missingToolchain> = null;
  if (explicit) {
    const guide = guideById(explicit);
    const have = new Set((toolchains ?? []).map((t) => t.tool));
    shown = { guide, missing: guide.tools.filter((t) => !have.has(t)) };
  } else if (file && dismissed !== file) {
    const auto = missingToolchain(file, toolchains);
    const kind = debugKindForPath(file);
    // The browser build's simulated debugger covers its language: nothing to install there.
    const simulated = platform.kind === "web" && !!kind && !!platform.debug?.kinds.includes(kind);
    if (auto && !simulated) shown = auto;
  }
  if (!shown) return null;
  return <InstallCard guide={shown.guide} missing={shown.missing} onClose={() => setDismissed(file)} />;
}

// ───────────── top: configuration picker / welcome ─────────────

function ProgressBar() {
  const progress = useDebug((s) => s.progress);
  if (!progress) return null;
  return (
    <div className="tm-debug-progress" role="status" aria-live="polite">
      <div className={`tm-progress ${progress.percent == null ? "is-indeterminate" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent ?? undefined} aria-label={progress.title}>
        <div className="tm-progress-bar" style={progress.percent != null ? { width: `${progress.percent}%` } : undefined} />
      </div>
      <div className="tm-debug-progress-text">
        <Codicon name="loading" className="codicon-modifier-spin" />
        <span>{progress.title}</span>
        {progress.detail && <span className="tm-muted">{progress.detail}</span>}
      </div>
    </div>
  );
}

function ConfigBar() {
  const configs = useDebug((s) => s.configs);
  const selected = useDebug((s) => s.selected);
  const phase = useDebug((s) => s.phase);
  useWorkbench((s) => activeFilePath(s));
  const os = getPlatform().os;
  const current = currentConfig();
  return (
    <div className="tm-debug-configbar">
      <ActionButton icon="debug-start" className="tm-debug-start" label={`Start Debugging (${formatKeybinding("f5", os)})`} disabled={phase !== "inactive" || !current} onClick={() => void startDebugging(current)} />
      <select
        className="tm-select tm-debug-config-select"
        aria-label="Debug Launch Configurations"
        value={selected ?? "__auto"}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__add") void executeCommand("debug.addConfiguration");
          else selectConfiguration(v === "__auto" ? null : v);
        }}
      >
        {configs.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
        <option value="__auto">{!selected && current ? current.name : "Current File (automatic)"}</option>
        <option disabled>──────────</option>
        <option value="__add">Add Configuration...</option>
      </select>
      <ActionButton icon="gear" label="Open 'launch.json'" onClick={() => (configs.length ? openFile(LAUNCH_FILE, { pinned: true }) : void executeCommand("debug.addConfiguration"))} />
    </div>
  );
}

function Welcome() {
  const os = getPlatform().os;
  const current = currentConfig();
  const file = useWorkbench((s) => activeFilePath(s));
  return (
    <div className="tm-view-empty tm-debug-welcome">
      <button type="button" className="tm-button tm-button--block" onClick={() => void startDebugging()} title={`Run and Debug (${formatKeybinding("f5", os)})`}>
        Run and Debug
      </button>
      {!current && <p className="tm-muted">{file ? `TMCode can't debug ${basename(file)}.` : "Open a Python, JavaScript, TypeScript or C/C++ file, then press Run and Debug."}</p>}
      <p>
        To customize Run and Debug,{" "}
        <button type="button" className="tm-link-button" onClick={() => void executeCommand("debug.addConfiguration")}>
          create a launch.json file
        </button>
        .
      </p>
      <p>
        <button type="button" className="tm-link-button" onClick={() => void pickConfiguration(true)}>
          Show all automatic debug configurations
        </button>
        .
      </p>
    </div>
  );
}

export function RunDebugView() {
  const workspace = useWorkbench((s) => s.workspace);
  const configs = useDebug((s) => s.configs);
  const phase = useDebug((s) => s.phase);
  const launchError = useDebug((s) => s.launchError);
  useExam((s) => s.phase);
  useWorkbench((s) => s.policy.mode);
  const allowed = debugAllowed();
  const host = getPlatform().debug;

  if (!allowed) return <div className="tm-view-empty">Debugging is turned off during exams. Use Run (Ctrl+F5) to run your program.</div>;
  if (!workspace) return <div className="tm-view-empty">Open a folder to run and debug your programs.</div>;

  return (
    <div className="tm-pane tm-debug-view" data-testid="debug-view">
      {(configs.length > 0 || phase !== "inactive") && <ConfigBar />}
      <ProgressBar />
      {launchError && (
        <div className="tm-debug-error tm-debug-banner" role="alert">
          <Codicon name="warning" /> {launchError}
        </div>
      )}
      {!host && <div className="tm-view-hint">Debugging is available in the TMCode desktop app.</div>}
      {host?.note && <div className="tm-view-hint tm-debug-note">{host.note}</div>}
      <ToolchainHelp />
      {phase === "inactive" && configs.length === 0 ? (
        <>
          <Welcome />
          <div className="tm-debug-sections">
            <BreakpointsSection />
          </div>
        </>
      ) : (
        <div className="tm-debug-sections">
          <VariablesSection />
          <WatchSection />
          <CallStackSection />
          <BreakpointsSection />
        </div>
      )}
    </div>
  );
}

export { pickConfiguration };
