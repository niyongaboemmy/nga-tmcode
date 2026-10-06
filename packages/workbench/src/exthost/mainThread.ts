import { terminalOp } from "./terminals";
import type { DecorationOptionsDTO, DecorationRangeDTO, DiagnosticDTO, ExtensionStateDTO, ProviderKind, ProviderMeta, QuickPickItemDTO, RangeDTO, RpcConnection, SelectionDTO, SelectorDTO, StatusBarEntryDTO, TextEditDTO, WorkspaceEditDTO } from "@tmcode/exthost";
import { allCommands, executeCommand, getCommand, registerCommand } from "../commands/registry";
import { monaco } from "../monaco/setup";
import { ensureDocument, extraProblems, getDocument, pathOfUri, recomputeProblems, saveDocument, uriFor } from "../monaco/documents";
import { codeEditorFor, runEditorAction } from "../monaco/editors";
import { dismissNotification, getPlatform, log, moveEntry, notify, notifyProgress, openFile, openSpecialEditor, refreshExplorer, showDialog, useWorkbench, type Problem } from "../state/store";
import { showInputBox, showQuickPick, type PickItem } from "../widgets/QuickPick";
import { editorFor, flushEditors, fromRange } from "./documentSync";
import { registerProvider, unregisterProvider } from "./languageBridge";
import { createDecorationType, disposeDecorationType, setDecorations } from "./decorations";
import { HOST_CHANNEL, outputOp } from "./output";
import { setContextKey, useExtHost, useExtStatusBar, type HostKind } from "./state";
import { updateExtensionSetting } from "./config";
import { contributedCommand } from "./contributions";

/**
 * The workbench's half of the extension host protocol ("MainThread*" in VS
 * Code): what extensions ask the editor to do. Registered on each host
 * connection; hostService undoes what a host registered when it stops.
 */

export interface MainContext {
  kind: HostKind;
  rpc: RpcConnection;
  /** Runs an extension command (in whichever host owns it). */
  runCommand(id: string, args: unknown[]): Promise<unknown>;
  /** Commands this host registered at runtime → unregister. */
  commands: Map<string, () => void>;
  persistState(scope: "global" | "workspace", extensionId: string, key: string, value: unknown): void;
}

const MONACO_SEVERITY = [8, 4, 2, 1];

// ───────────── diagnostics (owner → path → list) ─────────────

const diagnostics = new Map<string, Map<string, DiagnosticDTO[]>>();

function markersFor(list: DiagnosticDTO[]): monaco.editor.IMarkerData[] {
  return list.map((d) => ({
    ...fromRange(d.range),
    message: d.message,
    severity: MONACO_SEVERITY[d.severity] ?? 8,
    source: d.source,
    code: d.code === undefined ? undefined : d.codeTarget ? { value: String(d.code), target: monaco.Uri.parse(d.codeTarget) } : String(d.code),
    tags: d.tags as monaco.MarkerTag[] | undefined,
    relatedInformation: d.related?.filter((r) => r.path !== null).map((r) => ({ resource: uriFor(r.path!), message: r.message, ...fromRange(r.range) })),
  }));
}

function applyDiagnostics(owner: string, path: string) {
  const model = getDocument(path);
  if (model) monaco.editor.setModelMarkers(model, `ext:${owner}`, markersFor(diagnostics.get(owner)?.get(path) ?? []));
}

extraProblems.get = () => {
  const out: Problem[] = [];
  for (const byPath of diagnostics.values()) {
    for (const [path, list] of byPath) {
      for (const d of list) {
        if (d.severity === 3) continue;
        out.push({ path, message: d.message, severity: d.severity === 0 ? "error" : d.severity === 1 ? "warning" : "info", line: d.range[0] + 1, column: d.range[1] + 1, source: d.source });
      }
    }
  }
  return out;
};

let modelHook = false;
function hookModels() {
  if (modelHook) return;
  modelHook = true;
  // A file opened after an extension reported on it gets its markers.
  monaco.editor.onDidCreateModel((m) => {
    if (m.uri.scheme !== "tmcode") return;
    const path = pathOfUri(m.uri);
    for (const [owner, byPath] of diagnostics) if (byPath.has(path)) applyDiagnostics(owner, path);
  });
}

function dropOwner(owner: string) {
  const byPath = diagnostics.get(owner);
  if (!byPath) return;
  diagnostics.delete(owner);
  for (const p of byPath.keys()) {
    const model = getDocument(p);
    if (model) monaco.editor.setModelMarkers(model, `ext:${owner}`, []);
  }
}

export function clearDiagnosticsOf(kind: HostKind) {
  for (const owner of [...diagnostics.keys()]) if (owner.startsWith(`${kind}|`)) dropOwner(owner);
  recomputeProblems();
}

// ───────────── messages ─────────────

function showMessage(severity: "info" | "warning" | "error", message: string, opts: { modal?: boolean; detail?: string }, items: string[]): Promise<number | null> {
  if (opts.modal) {
    const buttons = items.map((label, i) => ({ id: String(i), label, primary: i === 0 }));
    return showDialog({ message, detail: opts.detail, severity: severity === "info" ? "info" : "warning", buttons: [...buttons, { id: "cancel", label: "Cancel" }], cancelId: "cancel" }).then((id) => (id === "cancel" ? null : Number(id)));
  }
  return new Promise((resolve) => {
    let done = false;
    let un: () => void = () => {};
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      un();
      resolve(v);
    };
    const id = notify(
      severity,
      message,
      items.length
        ? items.map((label, i) => ({
            label,
            run: () => {
              finish(i);
              dismissNotification(id);
            },
          }))
        : undefined,
    );
    // Closed (or timed out) without a choice: undefined, as in VS Code.
    un = useWorkbench.subscribe((s) => {
      if (!s.notifications.some((n) => n.id === id)) finish(null);
    });
  });
}

// ───────────── progress ─────────────

interface ProgressEntry {
  close(): void;
  update(p: { message?: string; progress?: number | null }): void;
  total: number;
  title?: string;
  message?: string;
}
const progress = new Map<string, ProgressEntry>();

function removeStatus(key: string) {
  useExtStatusBar.setState((s) => {
    const items = { ...s.items };
    delete items[key];
    return { items };
  });
}

// ───────────── edits ─────────────

function toOps(model: monaco.editor.ITextModel, edits: TextEditDTO[]) {
  const ops: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  for (const e of edits) {
    if (e.eol) {
      model.setEOL(e.eol === 2 ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      continue;
    }
    ops.push({ range: monaco.Range.lift(fromRange(e.range)), text: e.text, forceMoveMarkers: false });
  }
  return ops;
}

function applyTextEdits(path: string, model: monaco.editor.ITextModel, edits: TextEditDTO[], opts: { undoStopBefore?: boolean; undoStopAfter?: boolean } = {}) {
  const ops = toOps(model, edits);
  if (!ops.length) return true;
  const ed = editorFor(path);
  if (ed && ed.getModel() === model) {
    if (opts.undoStopBefore !== false) ed.pushUndoStop();
    const ok = ed.executeEdits("extension", ops);
    if (opts.undoStopAfter !== false) ed.pushUndoStop();
    return ok;
  }
  model.pushEditOperations([], ops, () => null);
  return true;
}

function openInSomeEditor(path: string) {
  return useWorkbench.getState().groups.some((g) => g.editors.some((e) => e.kind === "file" && e.path === path));
}

/** Applies a WorkspaceEdit: text edits (files no editor shows are saved), creates, deletes, renames. */
export async function applyWorkspaceEdit(dto: WorkspaceEditDTO): Promise<boolean> {
  const fs = getPlatform().fs;
  const byPath = new Map<string, TextEditDTO[]>();
  const steps: (() => Promise<void>)[] = [];
  for (const e of dto.entries) {
    if (e.kind === "text") {
      if (!byPath.has(e.path)) {
        byPath.set(e.path, []);
        steps.push(async () => {
          const model = await ensureDocument(e.path);
          // Snippet edits become plain text outside an editor.
          applyTextEdits(e.path, model, byPath.get(e.path)!.map((x) => (x.snippet ? { ...x, text: x.text.replace(/\$\{\d+:([^}]*)\}|\$\{?\d+\}?/g, "$1") } : x)));
          if (!openInSomeEditor(e.path)) await saveDocument(e.path);
        });
      }
      byPath.get(e.path)!.push(e.edit);
    } else if (e.kind === "create") {
      steps.push(async () => {
        const exists = await fs.readFile(e.path).then(() => true, () => false);
        if (exists && e.options?.ignoreIfExists) return;
        if (exists && !e.options?.overwrite) throw new Error(`${e.path} already exists`);
        await fs.writeFile(e.path, e.contents ?? "");
        await refreshExplorer();
      });
    } else if (e.kind === "delete") {
      steps.push(async () => {
        const exists = await fs.readFile(e.path).then(() => true, () => fs.readDir(e.path).then(() => true, () => false));
        if (!exists && e.options?.ignoreIfNotExists) return;
        await fs.remove(e.path);
        await refreshExplorer();
      });
    } else if (e.kind === "rename") {
      steps.push(async () => {
        await moveEntry(e.path, e.to);
        await refreshExplorer();
      });
    }
  }
  try {
    for (const step of steps) await step();
    return true;
  } catch (err) {
    log(HOST_CHANNEL, `applyEdit failed: ${String((err as Error)?.message ?? err)}`, "error");
    return false;
  }
}

async function showDocument(path: string, opts: { preserveFocus?: boolean; preview?: boolean; selection?: RangeDTO }): Promise<string | null> {
  openFile(path, { pinned: opts.preview !== true });
  for (let i = 0; i < 80; i++) {
    const ed = editorFor(path);
    if (ed) {
      if (opts.selection) {
        const r = fromRange(opts.selection);
        ed.setSelection(r);
        ed.revealRangeInCenterIfOutsideViewport(r);
      }
      if (!opts.preserveFocus) ed.focus();
      flushEditors();
      return `g${useWorkbench.getState().activeGroup}`;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

// ───────────── built-in commands extensions call ─────────────

async function runBuiltin(id: string, args: unknown[]): Promise<unknown> {
  const pathArg = (a: unknown) => (a && typeof a === "object" && typeof (a as { $path?: unknown }).$path === "string" ? (a as { $path: string }).$path : null);
  switch (id) {
    case "vscode.open": {
      const p = pathArg(args[0]);
      if (p !== null) {
        openFile(p, { pinned: true });
        return;
      }
      const uri = (args[0] as { $uri?: string })?.$uri;
      if (uri && /^https?:/.test(uri)) return getPlatform().openExternal?.(uri);
      throw new Error("vscode.open: TMCode can only open files of the open folder and web links.");
    }
    case "workbench.action.openSettings":
    case "workbench.action.openGlobalSettings":
      openSpecialEditor("settings");
      return;
    case "workbench.action.focusActiveEditorGroup":
      codeEditorFor(useWorkbench.getState().activeGroup)?.focus();
      return;
  }
  if (id.startsWith("editor.action.") || id === "actions.find") {
    runEditorAction(useWorkbench.getState().activeGroup, id);
    return;
  }
  if (getCommand(id)) {
    if (!executeCommand(id)) throw new Error(`command '${id}' is not available right now`);
    return;
  }
  throw new Error(`command '${id}' not found`);
}

// ───────────── Web Worker host: workspace.fs ─────────────

function b64encode(text: string) {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64decode(b64: string) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return new TextDecoder().decode(out);
}

async function workerFs(op: string, path: string, args: unknown[]): Promise<unknown> {
  const fs = getPlatform().fs;
  const isDir = (p: string) => fs.readDir(p).then(() => true, () => false);
  switch (op) {
    case "stat": {
      if (path === "" || (await isDir(path))) return { type: 2, ctime: 0, mtime: 0, size: 0 };
      const text = await fs.readFile(path);
      return { type: 1, ctime: 0, mtime: 0, size: text.length };
    }
    case "readDirectory":
      return (await fs.readDir(path)).map((e) => [e.name, e.kind === "dir" ? 2 : 1]);
    case "createDirectory":
      if (!(await isDir(path))) await fs.createDir(path);
      return null;
    case "readFile":
      return fs.readBase64 ? fs.readBase64(path) : b64encode(await fs.readFile(path));
    case "writeFile":
      await fs.writeFile(path, b64decode(String(args[0] ?? "")));
      await refreshExplorer();
      return null;
    case "delete":
      await fs.remove(path);
      await refreshExplorer();
      return null;
    case "rename":
      await moveEntry(path, String(args[0]));
      return null;
  }
  throw new Error(`Unknown fs operation ${op}`);
}

// ───────────── handler registration ─────────────

export function installMainThread(ctx: MainContext) {
  const r = ctx.rpc;
  const kind = ctx.kind;
  hookModels();
  r.register("$main.ready", () => null);
  // window.createTerminal (exthost/terminals.ts)
  r.register("$main.terminal", ([op, id, arg]) => terminalOp(kind, (m, p) => r.notify(m, p), String(op), Number(id), arg));
  r.register("$main.log", ([level, extId, text]) => log(HOST_CHANNEL, `${extId ? `[${extId}] ` : ""}${text}`, level === "error" ? "error" : level === "warn" ? "warn" : "info"));
  r.register("$main.extensionState", ([dto]) => {
    const s = dto as ExtensionStateDTO;
    const prev = useExtHost.getState().runtime[s.id];
    useExtHost.setState((st) => ({ runtime: { ...st.runtime, [s.id]: { ...prev, ...s, host: kind, unsupported: prev?.unsupported ?? [] } } }));
    if (s.state === "failed") notify("error", `Activating extension '${s.id}' failed: ${s.error ?? "unknown error"}.`);
  });
  r.register("$main.unsupported", ([extId, what]) => {
    const id = String(extId);
    const prev = useExtHost.getState().runtime[id];
    if (prev) useExtHost.setState((st) => ({ runtime: { ...st.runtime, [id]: { ...prev, unsupported: [...new Set([...prev.unsupported, String(what)])] } } }));
  });

  // commands
  r.register("$main.registerCommand", ([id]) => {
    const cid = String(id);
    if (ctx.commands.has(cid) || contributedCommand(cid) || getCommand(cid)) return;
    // Registered at runtime without a contribution: runnable (keybindings, menus, executeCommand), not in the palette.
    ctx.commands.set(cid, registerCommand({ id: cid, title: cid, hidden: true, run: () => void ctx.runCommand(cid, []) }) as () => void);
  });
  r.register("$main.unregisterCommand", ([id]) => {
    ctx.commands.get(String(id))?.();
    ctx.commands.delete(String(id));
  });
  r.register("$main.executeCommand", ([id, args]) => {
    const cid = String(id);
    if (contributedCommand(cid) || ctx.commands.has(cid)) return ctx.runCommand(cid, (args as unknown[]) ?? []);
    return runBuiltin(cid, (args as unknown[]) ?? []);
  });
  r.register("$main.getCommands", () => allCommands().map((c) => c.id));
  r.register("$main.setContext", ([key, value]) => setContextKey(String(key), value));

  // window
  r.register("$main.showMessage", ([severity, message, opts, items]) => showMessage(severity as "info", String(message), (opts ?? {}) as { modal?: boolean }, (items as string[]) ?? []));
  r.register("$main.showQuickPick", async ([items, options]) => {
    const list = (items as QuickPickItemDTO[]) ?? [];
    const o = (options ?? {}) as { title?: string; placeHolder?: string; matchOnDescription?: boolean; canPickMany?: boolean };
    let separator: string | undefined;
    const picks: PickItem[] = [];
    list.forEach((it, i) => {
      if (it.separator) {
        separator = it.label || " ";
        return;
      }
      picks.push({ id: String(i), label: it.label.replace(/\$\(([\w-]+)(~spin)?\)\s*/g, ""), description: it.description, detail: it.detail, icon: it.iconPath ?? /^\$\(([\w-]+)/.exec(it.label)?.[1], alwaysShow: it.alwaysShow, separator });
      separator = undefined;
    });
    const picked: PickItem | PickItem[] | undefined = await showQuickPick({
      title: o.title,
      placeholder: o.placeHolder,
      items: picks,
      matchOnDescription: o.matchOnDescription,
      canPickMany: o.canPickMany,
      initiallyPicked: list.flatMap((it, i) => (it.picked ? [String(i)] : [])),
    });
    if (!picked) return null;
    return (Array.isArray(picked) ? picked : [picked]).map((p) => Number(p.id));
  });
  r.register("$main.showInputBox", async ([options]) => {
    const o = (options ?? {}) as { title?: string; prompt?: string; placeHolder?: string; value?: string; password?: boolean; validator?: number | null };
    const v = await showInputBox({
      title: o.title,
      prompt: o.prompt,
      placeholder: o.placeHolder,
      value: o.value,
      password: o.password,
      validateAsync: o.validator ? (value) => r.request<string | null>("$validateInput", [o.validator, value]).catch(() => null) : undefined,
    });
    return v === undefined ? null : v;
  });
  r.register("$main.output", ([op, id, arg]) => outputOp(String(op), String(id), arg));
  r.register("$main.statusBar", ([op, dto]) => {
    const e = dto as StatusBarEntryDTO;
    if (op === "dispose") removeStatus(e.id);
    else useExtStatusBar.setState((s) => ({ items: { ...s.items, [e.id]: { ...e, host: kind } } }));
  });
  r.register("$main.progress", ([op, handle, data]) => {
    const key = `${kind}:progress:${handle}`;
    const d = (data ?? {}) as { location?: number; title?: string; cancellable?: boolean; message?: string; increment?: number };
    if (op === "start") {
      if (d.location === 15) {
        const p = notifyProgress(d.title ?? "Working…", d.cancellable ? { cancel: () => r.notify("$progressCancel", [handle]) } : {});
        progress.set(key, { ...p, total: 0, title: d.title });
      } else {
        // Window / Source Control progress: a spinning item in the status bar.
        const text = (msg?: string) => `$(loading~spin) ${[d.title, msg].filter(Boolean).join(": ")}`.trim();
        useExtStatusBar.setState((s) => ({ items: { ...s.items, [key]: { id: key, extensionId: "", text: text(), alignment: 1, priority: -100, visible: true, host: kind, progress: true } } }));
        progress.set(key, {
          close: () => removeStatus(key),
          update: (p) => useExtStatusBar.setState((s) => (s.items[key] ? { items: { ...s.items, [key]: { ...s.items[key], text: text(p.message) } } } : s)),
          total: 0,
          title: undefined,
        });
      }
    } else if (op === "report") {
      const p = progress.get(key);
      if (!p) return;
      if (typeof d.increment === "number") p.total = Math.min(100, p.total + d.increment);
      if (d.message !== undefined) p.message = d.message;
      p.update({ message: [p.title, p.message].filter(Boolean).join(": ") || undefined, progress: p.total ? p.total : null });
    } else if (op === "end") {
      progress.get(key)?.close();
      progress.delete(key);
    }
  });

  // documents & editors
  r.register("$main.openTextDocument", async ([path]) => {
    const model = await ensureDocument(String(path));
    return { path: String(path), languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue(), eol: model.getEOL() === "\r\n" ? "\r\n" : "\n", isDirty: !!useWorkbench.getState().dirty[String(path)] };
  });
  r.register("$main.saveDocument", async ([path]) => {
    if (!getDocument(String(path))) return false;
    await saveDocument(String(path));
    return true;
  });
  r.register("$main.showTextDocument", ([path, opts]) => showDocument(String(path), (opts ?? {}) as { preserveFocus?: boolean }));
  r.register("$main.editorEdit", ([path, edits, opts]) => {
    const model = getDocument(String(path));
    if (!model || useWorkbench.getState().readOnly) return false;
    return applyTextEdits(String(path), model, edits as TextEditDTO[], (opts ?? {}) as { undoStopBefore?: boolean });
  });
  r.register("$main.applyEdit", ([dto]) => (useWorkbench.getState().readOnly ? false : applyWorkspaceEdit(dto as WorkspaceEditDTO)));
  r.register("$main.insertSnippet", ([path, snippet, ranges]) => {
    const ed = editorFor(String(path));
    if (!ed) return false;
    const sels = (ranges as RangeDTO[]).map((x) => {
      const rr = fromRange(x);
      return new monaco.Selection(rr.startLineNumber, rr.startColumn, rr.endLineNumber, rr.endColumn);
    });
    if (sels.length) ed.setSelections(sels);
    const ctrl = ed.getContribution("snippetController2") as unknown as { insert(template: string): void } | null;
    if (ctrl) ctrl.insert(String(snippet));
    else ed.trigger("extension", "type", { text: String(snippet) });
    return true;
  });
  r.register("$main.editorSetSelections", ([path, sels]) => {
    editorFor(String(path))?.setSelections((sels as SelectionDTO[]).map((s) => new monaco.Selection(s.anchor[0] + 1, s.anchor[1] + 1, s.active[0] + 1, s.active[1] + 1)));
  });
  r.register("$main.revealRange", ([path, range, type]) => {
    const ed = editorFor(String(path));
    if (!ed) return;
    const rr = fromRange(range as RangeDTO);
    if (type === 1) ed.revealRangeInCenter(rr);
    else if (type === 2) ed.revealRangeInCenterIfOutsideViewport(rr);
    else if (type === 3) ed.revealRangeAtTop(rr);
    else ed.revealRange(rr);
  });
  r.register("$main.decorationType", ([op, key, options]) => (op === "create" ? createDecorationType(`${kind}-${key}`, options as DecorationOptionsDTO) : disposeDecorationType(`${kind}-${key}`)));
  r.register("$main.setDecorations", ([path, key, ranges]) => {
    const ed = editorFor(String(path));
    if (ed) setDecorations([ed], `${kind}-${key}`, ranges as DecorationRangeDTO[]);
  });
  r.register("$main.setTextDocumentLanguage", ([path, languageId]) => {
    const model = getDocument(String(path));
    if (model) monaco.editor.setModelLanguage(model, String(languageId));
  });
  r.register("$main.languageConfiguration", ([op, , language, dto]) => {
    if (op !== "set") return;
    // Monaco replaces (not merges) a language's configuration: only languages without a built-in one take it.
    const builtin = ["javascript", "typescript", "html", "css", "scss", "less", "json", "python", "c", "cpp", "java", "markdown", "php", "sql"];
    if (builtin.includes(String(language))) return;
    const re = (v?: { source: string; flags: string }) => (v?.source ? new RegExp(v.source, v.flags) : undefined);
    const d = (dto ?? {}) as Record<string, unknown> & { wordPattern?: { source: string; flags: string } };
    monaco.languages.setLanguageConfiguration(String(language), {
      comments: d.comments as monaco.languages.CommentRule,
      brackets: d.brackets as monaco.languages.CharacterPair[],
      wordPattern: re(d.wordPattern),
      autoClosingPairs: d.autoClosingPairs as monaco.languages.IAutoClosingPairConditional[],
      surroundingPairs: d.surroundingPairs as monaco.languages.IAutoClosingPair[],
    });
  });

  // languages
  r.register("$main.registerProvider", ([handle, k, selector, meta]) => registerProvider(kind, Number(handle), k as ProviderKind, selector as SelectorDTO[], meta as ProviderMeta));
  r.register("$main.unregisterProvider", ([handle]) => unregisterProvider(kind, Number(handle)));
  r.register("$main.setDiagnostics", ([owner, entries]) => {
    const key = `${kind}|${owner}`;
    let byPath = diagnostics.get(key);
    if (!byPath) diagnostics.set(key, (byPath = new Map()));
    for (const [path, list] of entries as [string, DiagnosticDTO[] | null][]) {
      if (list && list.length) byPath.set(path, list);
      else byPath.delete(path);
      applyDiagnostics(key, path);
    }
    recomputeProblems();
  });
  r.register("$main.clearDiagnostics", ([owner]) => {
    dropOwner(`${kind}|${owner}`);
    recomputeProblems();
  });

  // configuration, state, env
  r.register("$main.updateConfiguration", ([key, value, language]) => updateExtensionSetting(String(key), value, (language as string | null) ?? null));
  r.register("$main.state", ([scope, extId, key, value]) => ctx.persistState(scope as "global", String(extId), String(key), value));
  r.register("$main.secrets", async ([op, extId, key, value]) => {
    const host = getPlatform().extensions;
    if (!host?.secrets) throw new Error("Secret storage is not available here.");
    return host.secrets(op as "get", String(extId), key === undefined || key === null ? undefined : String(key), value === undefined || value === null ? undefined : String(value));
  });
  r.register("$main.clipboard", async ([op, text]) => {
    if (op === "write") {
      await navigator.clipboard?.writeText(String(text ?? ""));
      return null;
    }
    return (await navigator.clipboard?.readText?.().catch(() => "")) ?? "";
  });
  r.register("$main.openExternal", async ([uri]) => {
    const u = String(uri);
    if (!/^(https?|mailto):/i.test(u)) return false;
    const p = getPlatform();
    if (p.openExternal) await p.openExternal(u);
    else window.open(u, "_blank", "noopener");
    return true;
  });

  // Web Worker host: extension files and the workspace come from the workbench.
  r.register("$main.readExtensionFile", ([extId, path]) => getPlatform().extensions!.readFile(String(extId), String(path), "text"));
  r.register("$main.fs", ([op, path, ...rest]) => workerFs(String(op), String(path), rest));
}
