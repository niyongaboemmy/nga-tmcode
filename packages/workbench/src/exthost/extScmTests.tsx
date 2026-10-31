import { useState } from "react";
import { create } from "zustand";
import type { CommandDTO, RpcConnection, ScmProviderDTO, TestControllerDTO, TestItemDTO, TestStateDTO } from "@tmcode/exthost";
import { openFile } from "../state/store";
import { revealInEditor } from "../monaco/reveal";
import { basename, dirname } from "../util/paths";
import { ActionButton, Codicon, FileIcon } from "../widgets/icons";

/**
 * Extensions' source controls (scm.createSourceControl) in the Source Control
 * view, and their test controllers (tests.createTestController) in Testing:
 * the state each host sent ($main.scm / $main.tests), and the requests back
 * (input box, commands, running tests).
 */

type Key = string;
const rpcs = new Map<string, RpcConnection>();

interface ExtState {
  scm: Record<Key, ScmProviderDTO>;
  tests: Record<Key, TestControllerDTO>;
  /** Controller key → item id → its last result. */
  results: Record<Key, Record<string, { state: TestStateDTO; message?: string; duration?: number }>>;
  output: Record<Key, string>;
  running: Record<Key, boolean>;
}

export const useExtScmTests = create<ExtState>(() => ({ scm: {}, tests: {}, results: {}, output: {}, running: {} }));

const keyOf = (kind: string, handle: unknown) => `${kind}:${String(handle)}`;
const split = (key: Key) => {
  const at = key.indexOf(":");
  return { kind: key.slice(0, at), handle: Number(key.slice(at + 1)) };
};

/** Called by installMainThread for each host. */
export function installExtScmTests(kind: string, r: RpcConnection) {
  rpcs.set(kind, r);
  r.register("$main.scm", ([op, handle, dto]) => {
    const key = keyOf(kind, handle);
    const scm = { ...useExtScmTests.getState().scm };
    if (op === "remove") delete scm[key];
    else scm[key] = dto as ScmProviderDTO;
    useExtScmTests.setState({ scm });
    return null;
  });
  r.register("$main.tests", ([op, handle, dto]) => {
    const key = keyOf(kind, handle);
    const tests = { ...useExtScmTests.getState().tests };
    if (op === "remove") delete tests[key];
    else tests[key] = dto as TestControllerDTO;
    useExtScmTests.setState({ tests });
    return null;
  });
  r.register("$main.testState", ([handle, id, state, message, duration]) => {
    const key = keyOf(kind, handle);
    const s = useExtScmTests.getState();
    useExtScmTests.setState({
      results: { ...s.results, [key]: { ...(s.results[key] ?? {}), [String(id)]: { state: state as TestStateDTO, ...(message ? { message: String(message) } : {}), ...(typeof duration === "number" ? { duration } : {}) } } },
    });
    return null;
  });
  r.register("$main.testRun", ([handle, op, text]) => {
    const key = keyOf(kind, handle);
    const s = useExtScmTests.getState();
    if (op === "start") useExtScmTests.setState({ running: { ...s.running, [key]: true }, output: { ...s.output, [key]: "" } });
    else if (op === "end") useExtScmTests.setState({ running: { ...s.running, [key]: false } });
    else if (op === "output") useExtScmTests.setState({ output: { ...s.output, [key]: ((s.output[key] ?? "") + String(text)).slice(-20000) } });
    return null;
  });
}

/** A host stopped: its contributions go. */
export function forgetExtScmTests(kind: string) {
  const drop = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith(`${kind}:`)));
  const s = useExtScmTests.getState();
  useExtScmTests.setState({ scm: drop(s.scm), tests: drop(s.tests), results: drop(s.results), output: drop(s.output), running: drop(s.running) });
  rpcs.delete(kind);
}

function runCached(key: Key, cmd?: CommandDTO) {
  if (!cmd?.ref) return;
  void rpcs.get(split(key).kind)?.request("$executeCachedCommand", [cmd.ref]).catch(() => undefined);
}

export function runExtensionTests(key: Key, ids: string[] | null) {
  const { kind, handle } = split(key);
  const s = useExtScmTests.getState();
  useExtScmTests.setState({ running: { ...s.running, [key]: true } });
  void rpcs.get(kind)?.request("$runTests", [handle, ids]).catch(() => useExtScmTests.setState({ running: { ...useExtScmTests.getState().running, [key]: false } }));
}

// ───────────── Source Control ─────────────

function ScmProvider({ id, p }: { id: Key; p: ScmProviderDTO }) {
  const [value, setValue] = useState(p.input.value);
  const send = (v: string) => {
    setValue(v);
    void rpcs.get(split(id).kind)?.request("$scmInput", [split(id).handle, v]).catch(() => undefined);
  };
  return (
    <div className="tm-scm-section tm-ext-scm" data-testid="ext-scm" data-provider={p.id}>
      <div className="tm-scm-section-header">
        <Codicon name="source-control" />
        <span className="tm-scm-section-title">{p.label}</span>
        {p.count !== undefined && p.count > 0 && <span className="tm-badge">{p.count}</span>}
      </div>
      {p.input.visible && (
        <div className="tm-ext-scm-input">
          <input
            className="tm-input"
            aria-label={`${p.label} message`}
            placeholder={p.input.placeholder}
            disabled={!p.input.enabled}
            value={value}
            onChange={(e) => send(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runCached(id, p.acceptInputCommand);
            }}
          />
          {p.acceptInputCommand && (
            <button type="button" className="tm-button tm-button--small" onClick={() => runCached(id, p.acceptInputCommand)}>
              {p.acceptInputCommand.title || "Accept"}
            </button>
          )}
        </div>
      )}
      {p.groups
        .filter((g) => g.resources.length || !g.hideWhenEmpty)
        .map((g) => (
          <div key={g.id} role="group" aria-label={g.label}>
            <div className="tm-ext-scm-group">
              {g.label} <span className="tm-muted">{g.resources.length}</span>
            </div>
            {g.resources.map((r) => (
              <div
                key={r.uri}
                className={`tm-list-row tm-scm-row ${r.faded ? "is-faded" : ""}`}
                role="listitem"
                title={r.tooltip ?? r.path}
                onClick={() => (r.command ? runCached(id, r.command) : r.path && openFile(r.path, { pinned: false }))}
              >
                <FileIcon path={r.path || r.uri} />
                <span className={`tm-scm-name ${r.strikeThrough ? "is-deleted" : ""}`}>{basename(r.path || r.uri)}</span>
                <span className="tm-scm-folder">{dirname(r.path)}</span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

export function ExtensionScm() {
  const scm = useExtScmTests((s) => s.scm);
  const entries = Object.entries(scm);
  if (!entries.length) return null;
  return (
    <div className="tm-ext-scm-list">
      {entries.map(([k, p]) => (
        <ScmProvider key={k} id={k} p={p} />
      ))}
    </div>
  );
}

// ───────────── Testing ─────────────

const STATE_ICON: Record<TestStateDTO, string> = { queued: "history", running: "loading~spin", passed: "pass", failed: "error", errored: "error", skipped: "debug-step-over" };

function TestRow({ ctrl, item, depth }: { ctrl: Key; item: TestItemDTO; depth: number }) {
  const r = useExtScmTests((s) => s.results[ctrl]?.[item.id]);
  const [open, setOpen] = useState(depth < 1);
  return (
    <>
      <div className={`tm-list-row tm-ext-test is-${r?.state ?? "none"}`} style={{ paddingLeft: 8 + depth * 12 }} role="treeitem" aria-expanded={item.children.length ? open : undefined} data-testid="ext-test" title={r?.message ?? item.label}>
        <span className="tm-twistie" onClick={() => setOpen(!open)}>
          {item.children.length > 0 && <Codicon name={open ? "chevron-down" : "chevron-right"} />}
        </span>
        <Codicon name={r ? STATE_ICON[r.state] : "circle-large-outline"} className={`tm-ext-test-icon is-${r?.state ?? "none"}`} />
        <span className="tm-ext-test-label" onClick={() => item.path && (item.line !== undefined ? revealInEditor(item.path, item.line + 1, 1) : openFile(item.path, { pinned: true }))}>
          {item.label}
        </span>
        {item.description && <span className="tm-muted">{item.description}</span>}
        {r?.duration !== undefined && <span className="tm-muted">{Math.round(r.duration)} ms</span>}
        <ActionButton icon="run" label={`Run ${item.label}`} onClick={() => runExtensionTests(ctrl, [item.id])} />
      </div>
      {r?.message && (r.state === "failed" || r.state === "errored") && (
        <pre className="tm-ext-test-message" style={{ marginLeft: 28 + depth * 12 }}>
          {r.message}
        </pre>
      )}
      {open && item.children.map((c) => <TestRow key={c.id} ctrl={ctrl} item={c} depth={depth + 1} />)}
    </>
  );
}

export function ExtensionTests() {
  const tests = useExtScmTests((s) => s.tests);
  const running = useExtScmTests((s) => s.running);
  const entries = Object.entries(tests);
  if (!entries.length) return null;
  return (
    <div className="tm-ext-tests" data-testid="ext-tests">
      {entries.map(([k, c]) => (
        <section key={k} className="tm-scm-section">
          <div className="tm-scm-section-header">
            <Codicon name="beaker" />
            <span className="tm-scm-section-title">{c.label}</span>
            {running[k] && <Codicon name="loading~spin" />}
            {c.canRun && (
              <span className="tm-scm-section-actions">
                <ActionButton icon="run-all" label={`Run All Tests (${c.label})`} onClick={() => runExtensionTests(k, null)} />
              </span>
            )}
          </div>
          <div role="tree" aria-label={`${c.label} tests`}>
            {c.items.map((i) => (
              <TestRow key={i.id} ctrl={k} item={i} depth={0} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
