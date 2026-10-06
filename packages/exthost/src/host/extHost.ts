/**
 * The extension host: keeps the host-side state (documents, editors,
 * commands, providers, diagnostics, configuration…), activates extensions on
 * their activation events and builds the `vscode` API each extension
 * receives from `require('vscode')`. The same code runs in Node.js (desktop)
 * and in a Web Worker (browser extensions); only `HostEnvironment` differs.
 *
 * Rule: a missing or broken API never takes the host down. Unknown members
 * of the API log "… is not supported in TMCode yet" to the extension's
 * Output channel; a throwing extension is marked Failed, the others keep running.
 */

import * as T from "../api/types";
import { Uri, setUriPlatform } from "../api/uri";
import { CancellationTokenSource, EventEmitter, type CancellationToken, type Event } from "../api/events";
import { RpcConnection } from "../rpc";
import { activationEventsOf, matchesActivationEvent, STARTUP_EVENTS, workspaceContainsPatterns } from "../activation";
import { ConfigurationModel, affects, configurationDefaults, configurationProperties, type Flat } from "../configuration";
import * as C from "./convert";
import { DocumentData, type ContentChange } from "./document";
import { enabledPatterns, matchGlob } from "./glob";
import type { ExtensionModule, HostFs, ModuleLoader } from "./fs";
import { createApi } from "./api";
import { TerminalService } from "./terminals";

import { ViewsHost } from "./views";
import type {
  CompletionListDTO,
  ContentChangeDTO,
  DecorationOptionsDTO,
  DecorationRangeDTO,
  DiagnosticDTO,
  DocumentDTO,
  EditorDTO,
  ExtensionDescription,
  ExtensionStateDTO,
  InitData,
  ProviderKind,
  ProviderMeta,
  QuickPickItemDTO,
  RangeDTO,
  SelectorDTO,
  StatusBarEntryDTO,
  TextEditDTO,
} from "../protocol";

export const API_VERSION = "1.96.0";

export interface HostEnvironment {
  kind: "node" | "worker";
  isWindows: boolean;
  createFs(host: ExtHost): HostFs;
  createLoader(apiFor: (extensionId: string) => unknown): ModuleLoader;
  /** Node: the real path of a folder (extension folders may be reached through symlinks). */
  realPath?(path: string): string;
  /** Where console output of extensions goes (the "Extension Host" Output channel). */
  onConsole?(write: (level: "info" | "warn" | "error", text: string) => void): void;
}

interface ExtState {
  desc: ExtensionDescription;
  events: string[];
  activation?: Promise<void>;
  module?: ExtensionModule;
  exports?: unknown;
  context?: { subscriptions: { dispose(): unknown }[] };
  active: boolean;
  api?: unknown;
  logChannel?: OutputChannelImpl;
  unsupported: Set<string>;
}

class NotSupportedError extends Error {
  constructor(what: string) {
    super(`'${what}' is not supported in TMCode yet.`);
    this.name = "NotSupportedError";
  }
}

function errorText(e: unknown): string {
  const err = e as Error;
  return err?.stack || String(err?.message ?? e);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ───────────────────────── output channels ─────────────────────────

class OutputChannelImpl {
  #disposed = false;
  logLevel = T.LogLevel.Info;
  readonly #onDidChangeLogLevel = new EventEmitter<T.LogLevel>();
  readonly onDidChangeLogLevel = this.#onDidChangeLogLevel.event;
  constructor(
    readonly name: string,
    private readonly id: string,
    private readonly rpc: RpcConnection,
    readonly log: boolean,
  ) {
    rpc.notify("$main.output", ["create", id, name]);
  }
  #op(op: string, arg?: unknown) {
    if (!this.#disposed) this.rpc.notify("$main.output", [op, this.id, arg]);
  }
  append(value: string) {
    this.#op("append", String(value));
  }
  appendLine(value: string) {
    this.#op("append", `${value}\n`);
  }
  replace(value: string) {
    this.#op("replace", String(value));
  }
  clear() {
    this.#op("clear");
  }
  show() {
    this.#op("show");
  }
  hide() {
    this.#op("hide");
  }
  dispose() {
    this.#op("dispose");
    this.#disposed = true;
  }
  // LogOutputChannel
  #line(level: string, message: unknown, args: unknown[]) {
    const text = [message instanceof Error ? errorText(message) : String(message), ...args.map((a) => (a instanceof Error ? errorText(a) : typeof a === "string" ? a : safeJson(a)))].join(" ");
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    this.appendLine(`${ts} [${level}] ${text}`);
  }
  trace(m: unknown, ...a: unknown[]) {
    if (this.logLevel <= T.LogLevel.Trace) this.#line("trace", m, a);
  }
  debug(m: unknown, ...a: unknown[]) {
    if (this.logLevel <= T.LogLevel.Debug) this.#line("debug", m, a);
  }
  info(m: unknown, ...a: unknown[]) {
    if (this.logLevel <= T.LogLevel.Info) this.#line("info", m, a);
  }
  warn(m: unknown, ...a: unknown[]) {
    if (this.logLevel <= T.LogLevel.Warning) this.#line("warning", m, a);
  }
  error(m: unknown, ...a: unknown[]) {
    if (this.logLevel <= T.LogLevel.Error) this.#line("error", m, a);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ───────────────────────── editors ─────────────────────────

class TextEditorImpl {
  selections: T.Selection[];
  visibleRanges: T.Range[];
  options: { tabSize: number; insertSpaces: boolean; cursorStyle: number; lineNumbers: number };
  viewColumn: number;
  constructor(
    readonly id: string,
    readonly path: string,
    private readonly host: ExtHost,
    dto: EditorDTO,
  ) {
    this.selections = dto.selections.map(C.selection.to);
    this.visibleRanges = dto.visibleRanges.map(C.range.to);
    this.options = { ...dto.options, cursorStyle: T.TextEditorCursorStyle.Line, lineNumbers: T.TextEditorLineNumbersStyle.On };
    this.viewColumn = dto.viewColumn;
  }
  update(dto: EditorDTO) {
    this.selections = dto.selections.map(C.selection.to);
    this.visibleRanges = dto.visibleRanges.map(C.range.to);
    Object.assign(this.options, dto.options);
    this.viewColumn = dto.viewColumn;
  }
  get document() {
    return this.host.documentFor(this.path)!.document;
  }
  get selection(): T.Selection {
    return this.selections[0] ?? new T.Selection(0, 0, 0, 0);
  }
  set selection(s: T.Selection) {
    this.setSelections([s]);
  }
  setSelections(list: T.Selection[]) {
    this.selections = list;
    this.host.rpc.notify("$main.editorSetSelections", [this.path, list.map(C.selection.from)]);
  }
  async edit(callback: (b: TextEditorEditBuilder) => void, options: { undoStopBefore?: boolean; undoStopAfter?: boolean } = {}): Promise<boolean> {
    const builder = new TextEditorEditBuilder(this.document);
    callback(builder);
    return this.host.applyEditorEdits(this.path, builder.edits, options);
  }
  async insertSnippet(snippet: T.SnippetString, where?: T.Position | T.Range | readonly (T.Position | T.Range)[]): Promise<boolean> {
    const toRange = (p: T.Position | T.Range) => (T.Range.isRange(p) ? p : new T.Range(p, p));
    const ranges = where === undefined ? this.selections : Array.isArray(where) ? where.map(toRange) : [toRange(where as T.Position | T.Range)];
    return this.host.rpc.request<boolean>("$main.insertSnippet", [this.path, snippet.value, ranges.map(C.range.from)]);
  }
  setDecorations(type: { key: string }, rangesOrOptions: readonly (T.Range | { range: T.Range; hoverMessage?: unknown; renderOptions?: DecorationRangeDTO["renderOptions"] })[]) {
    const list: DecorationRangeDTO[] = [];
    for (const r of rangesOrOptions ?? []) {
      if (T.Range.isRange(r)) list.push({ range: C.range.from(r) });
      else if (r && T.Range.isRange(r.range)) {
        const hover = r.hoverMessage === undefined ? undefined : (Array.isArray(r.hoverMessage) ? r.hoverMessage : [r.hoverMessage]).map(C.markdown).filter((x) => !!x) as { value: string }[];
        list.push({ range: C.range.from(r.range), hoverMessage: hover, renderOptions: r.renderOptions });
      }
    }
    this.host.rpc.notify("$main.setDecorations", [this.path, type.key, list]);
  }
  revealRange(range: T.Range, revealType?: T.TextEditorRevealType) {
    this.host.rpc.notify("$main.revealRange", [this.path, C.range.from(range), revealType ?? 0]);
  }
  show() {
    void this.host.rpc.request("$main.showTextDocument", [this.path, {}]).catch(() => {});
  }
  hide() {}
}

class TextEditorEditBuilder {
  edits: TextEditDTO[] = [];
  constructor(private readonly doc: { validateRange(r: T.Range): T.Range }) {}
  replace(location: T.Position | T.Range | T.Selection, value: string) {
    const r = T.Range.isRange(location) ? location : new T.Range(location as T.Position, location as T.Position);
    this.edits.push({ range: C.range.from(this.doc.validateRange(r)), text: value ?? "" });
  }
  insert(location: T.Position, value: string) {
    this.replace(new T.Range(location, location), value);
  }
  delete(location: T.Range | T.Selection) {
    this.replace(location, "");
  }
  setEndOfLine(eol: T.EndOfLine) {
    this.edits.push({ range: [0, 0, 0, 0], text: "", eol: eol as 1 | 2 });
  }
}

// ───────────────────────── mementos ─────────────────────────

class Memento {
  constructor(
    private readonly values: Record<string, unknown>,
    private readonly persist: (key: string, value: unknown) => void,
  ) {}
  keys() {
    return Object.keys(this.values);
  }
  get<V>(key: string, defaultValue?: V): V | undefined {
    const v = this.values[key];
    return v === undefined ? defaultValue : (JSON.parse(JSON.stringify(v)) as V);
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.values[key];
    else this.values[key] = JSON.parse(JSON.stringify(value));
    this.persist(key, value);
    return Promise.resolve();
  }
  setKeysForSync() {}
}

// ───────────────────────── the host ─────────────────────────

type Provider = { kind: ProviderKind; provider: Record<string, (...args: unknown[]) => unknown>; ext: ExtState; selector: SelectorDTO[] };

export class ExtHost {
  readonly rpc: RpcConnection;
  readonly env: HostEnvironment;
  data!: InitData;
  fs!: HostFs;
  #loader!: ModuleLoader;
  folder: Uri | undefined;
  readonly exts = new Map<string, ExtState>();
  readonly #docs = new Map<string, DocumentData>();
  /** Documents the host opened itself (outside the workspace, untitled): never synced. */
  readonly #looseDocs = new Map<string, DocumentData>();
  readonly #editors = new Map<string, TextEditorImpl>();
  #activeEditor: string | null = null;
  readonly #commands = new Map<string, { fn: (...args: unknown[]) => unknown; thisArg: unknown; ext?: ExtState }>();
  readonly #providers = new Map<number, Provider>();
  #handleSeq = 0;
  readonly #completionCache = new Map<number, T.CompletionItem[]>();
  readonly #codeLensCache = new Map<number, { lenses: T.CodeLens[]; handle: number }>();
  #cacheSeq = 0;
  readonly #commandCache = new Map<number, T.Command>();
  #commandRef = 0;
  readonly #diagnostics = new Map<string, Map<string, T.Diagnostic[]>>();
  #outputSeq = 0;
  #statusSeq = 0;
  #progressSeq = 0;
  readonly #progress = new Map<number, CancellationTokenSource>();
  #decorationSeq = 0;
  readonly #inputValidators = new Map<number, (v: string) => unknown>();
  #inputSeq = 0;
  config!: ConfigurationModel;
  readonly #contextKeys = new Map<string, unknown>();
  #languages: string[] = [];
  #untitledSeq = 0;
  readonly #fileWatchers = new Set<{ glob: string; base?: string; fire: (type: "create" | "change" | "delete", uri: Uri) => void }>();
  #hostLog?: (level: "info" | "warn" | "error", text: string) => void;

  // Events
  readonly onDidOpenTextDocument = new EventEmitter<unknown>();
  readonly onDidCloseTextDocument = new EventEmitter<unknown>();
  readonly onDidChangeTextDocument = new EventEmitter<unknown>();
  readonly onDidSaveTextDocument = new EventEmitter<unknown>();
  readonly onWillSaveTextDocument = new EventEmitter<unknown>();
  readonly onDidChangeActiveTextEditor = new EventEmitter<unknown>();
  readonly onDidChangeVisibleTextEditors = new EventEmitter<unknown>();
  readonly onDidChangeTextEditorSelection = new EventEmitter<unknown>();
  readonly onDidChangeTextEditorVisibleRanges = new EventEmitter<unknown>();
  readonly onDidChangeTextEditorOptions = new EventEmitter<unknown>();
  readonly onDidChangeConfiguration = new EventEmitter<unknown>();
  readonly onDidChangeDiagnostics = new EventEmitter<unknown>();
  readonly onDidChangeWindowState = new EventEmitter<unknown>();
  readonly onDidChangeExtensions = new EventEmitter<void>();
  readonly onDidCreateFiles = new EventEmitter<unknown>();
  readonly onDidDeleteFiles = new EventEmitter<unknown>();
  readonly onDidRenameFiles = new EventEmitter<unknown>();
  windowFocused = true;
  /** Tree views and webviews (host/views.ts). */
  readonly views: ViewsHost;

  constructor(send: (message: unknown) => void, env: HostEnvironment) {
    this.env = env;
    setUriPlatform(env.isWindows);
    this.rpc = new RpcConnection(send);
    EventEmitter.onListenerError = (e) => this.log("error", `An extension's event listener threw: ${errorText(e)}`);
    env.onConsole?.((level, text) => this.log(level, text));
    this.#registerHandlers();
    this.views = new ViewsHost(this);
  }

  /** Host-level diagnostics: the "Extension Host" Output channel. */
  log(level: "info" | "warn" | "error", text: string, extensionId?: string) {
    this.#hostLog?.(level, text);
    this.rpc.notify("$main.log", [level, extensionId ?? null, text]);
  }

  setHostLog(fn: (level: "info" | "warn" | "error", text: string) => void) {
    this.#hostLog = fn;
  }

  // ───────────── path mapping ─────────────

  #terminals: TerminalService | null = null;
  /** window.createTerminal and friends (created on first use). */
  get terminals(): TerminalService {
    return (this.#terminals ??= new TerminalService(this.rpc, this.paths));
  }

  readonly paths: C.PathMapper = {
    toPath: (uri: Uri) => {
      if (!this.folder || !uri || uri.scheme !== "file") return null;
      const base = this.folder.path.replace(/\/+$/, "");
      const p = uri.path;
      const eq = this.env.isWindows ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b;
      if (eq(p, base)) return "";
      if (p.length > base.length && eq(p.slice(0, base.length + 1), base + "/")) return p.slice(base.length + 1);
      return null;
    },
    toUri: (path: string) => Uri.joinPath(this.folder ?? Uri.file("/"), path),
  };

  readonly #commandCacheApi: C.CommandCache = {
    add: (cmd) => {
      const ref = ++this.#commandRef;
      this.#commandCache.set(ref, cmd);
      if (this.#commandCache.size > 5000) this.#commandCache.delete(this.#commandCache.keys().next().value!);
      return ref;
    },
  };

  documentFor(path: string) {
    return this.#docs.get(path) ?? this.#looseDocs.get(path);
  }

  /** `workspace.textDocuments`: the synced documents plus those the host opened itself. */
  allDocuments() {
    return [...this.#docs.values(), ...this.#looseDocs.values()].map((d) => d.document);
  }

  // ───────────── RPC handlers (main → host) ─────────────

  #registerHandlers() {
    const r = this.rpc;
    r.register("$init", ([data]) => this.#init(data as InitData));
    r.register("$startup", () => this.#startup());
    r.register("$activateByEvent", ([event]) => this.activateByEvent(String(event)));
    r.register("$activate", ([id, reason]) => this.activate(String(id), String(reason ?? "api")));
    r.register("$executeCommand", ([id, args]) => this.executeCommand(String(id), ...this.#reviveArgs(args as unknown[])));
    r.register("$executeCachedCommand", ([ref]) => {
      const cmd = this.#commandCache.get(Number(ref));
      if (!cmd) throw new Error("The command is no longer available.");
      return this.executeCommand(cmd.command, ...(cmd.arguments ?? []));
    });
    r.register("$documentOpened", ([dto]) => this.#documentOpened(dto as DocumentDTO));
    r.register("$documentChanged", ([path, version, changes, isDirty]) => this.#documentChanged(String(path), Number(version), changes as ContentChangeDTO[], !!isDirty));
    // Before TMCode writes a file: extensions may add edits (organize imports, fix-all) through waitUntil.
    r.register("$willSaveTextDocument", ([path, reason]) => this.#willSave(String(path), Number(reason ?? 1)));
    r.register("$documentSaved", ([path]) => {
      const d = this.#docs.get(String(path));
      if (!d) return;
      d.isDirty = false;
      this.onDidSaveTextDocument.fire(d.document);
    });
    r.register("$documentDirty", ([path, dirty]) => {
      const d = this.#docs.get(String(path));
      if (d) d.isDirty = !!dirty;
    });
    r.register("$documentClosed", ([path]) => this.#documentClosed(String(path)));
    r.register("$documentLanguageChanged", ([path, languageId]) => {
      const d = this.#docs.get(String(path));
      if (!d || d.languageId === languageId) return;
      // VS Code closes and reopens a document whose language changes.
      this.onDidCloseTextDocument.fire(d.document);
      d.languageId = String(languageId);
      this.onDidOpenTextDocument.fire(d.document);
      void this.activateByEvent(`onLanguage:${languageId}`);
    });
    r.register("$editorsChanged", ([editors, active]) => this.#editorsChanged(editors as EditorDTO[], (active as string | null) ?? null));
    r.register("$editorSelection", ([id, selections, kind]) => {
      const ed = this.#editors.get(String(id));
      if (!ed) return;
      ed.selections = (selections as EditorDTO["selections"]).map(C.selection.to);
      this.onDidChangeTextEditorSelection.fire({ textEditor: ed, selections: ed.selections, kind: kind ?? undefined });
    });
    r.register("$editorVisibleRanges", ([id, ranges]) => {
      const ed = this.#editors.get(String(id));
      if (!ed) return;
      ed.visibleRanges = (ranges as RangeDTO[]).map(C.range.to);
      this.onDidChangeTextEditorVisibleRanges.fire({ textEditor: ed, visibleRanges: ed.visibleRanges });
    });
    r.register("$configurationChanged", ([user, changed]) => {
      this.config.setUser((user as Flat) ?? {});
      const keys = (changed as string[]) ?? [];
      this.onDidChangeConfiguration.fire({ affectsConfiguration: (section: string) => affects(keys, section) });
    });
    r.register("$defaultsChanged", ([defaults]) => this.config.setDefaults(this.#defaults((defaults as Flat) ?? {}, this.data.extensions)));
    r.register("$languagesChanged", ([langs]) => {
      this.#languages = (langs as string[]) ?? [];
    });
    r.register("$windowFocus", ([focused]) => {
      this.windowFocused = !!focused;
      this.onDidChangeWindowState.fire({ focused: this.windowFocused, active: this.windowFocused });
    });
    // The workbench's own problems (TypeScript, CSS, JSON… from Monaco, run errors): VS Code's
    // languages.getDiagnostics() includes the built-in extensions' too (Error Lens relies on it).
    r.register("$workbenchDiagnostics", ([entries]) => this.#workbenchDiagnostics(entries as [string, DiagnosticDTO[]][]));
    r.register("$terminalEvent", ([id, kind, value]) => this.terminals.event(Number(id), String(kind), value));
    r.register("$fileEvents", ([events]) => this.#fileEvents(events as { path: string; type: "create" | "change" | "delete" }[]));
    r.register("$provide", ([handle, method, args], cancel) => {
      const src = new CancellationTokenSource();
      cancel.onCancel(() => src.cancel());
      return this.#provide(Number(handle), String(method), (args as unknown[]) ?? [], src.token);
    });
    r.register("$releaseCache", ([kind, id]) => {
      if (kind === "completion") this.#completionCache.delete(Number(id));
      else this.#codeLensCache.delete(Number(id));
    });
    r.register("$validateInput", async ([id, value]) => {
      const v = this.#inputValidators.get(Number(id));
      if (!v) return null;
      const res = await v(String(value));
      if (!res) return null;
      return typeof res === "string" ? res : String((res as { message?: string }).message ?? "");
    });
    r.register("$progressCancel", ([handle]) => this.#progress.get(Number(handle))?.cancel());
    r.register("$deactivate", () => this.deactivateAll());
    r.register("$ping", () => "pong");
  }

  #reviveArgs(args: unknown[] | undefined): unknown[] {
    return (args ?? []).map((a) => {
      if (isObj(a) && typeof a.$path === "string") return this.paths.toUri(a.$path);
      if (isObj(a) && typeof a.$uri === "string") return Uri.parse(a.$uri);
      return a;
    });
  }

  /** Arguments for a workbench command: URIs become {$path} (workspace) or {$uri}. */
  #serializeArgs(args: unknown[]): unknown[] {
    const conv = (a: unknown, depth: number): unknown => {
      if (a instanceof Uri || Uri.isUri(a)) {
        const p = this.paths.toPath(a as Uri);
        return p !== null ? { $path: p } : { $uri: (a as Uri).toString() };
      }
      if (T.Range.isRange(a)) return { $range: C.range.from(a) };
      if (T.Position.isPosition(a)) return { $position: C.position.from(a) };
      if (Array.isArray(a)) return depth > 4 ? undefined : a.map((x) => conv(x, depth + 1));
      if (isObj(a)) {
        if (depth > 4) return undefined;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(a)) if (typeof v !== "function") out[k] = conv(v, depth + 1);
        return out;
      }
      return typeof a === "function" || typeof a === "symbol" || typeof a === "bigint" ? undefined : a;
    };
    return args.map((a) => conv(a, 0));
  }

  async #init(data: InitData) {
    this.data = data;
    const root = data.workspace?.root;
    if (root) {
      const abs = root.startsWith("/") || /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\");
      this.folder = abs ? Uri.file(root) : Uri.file(`/${data.workspace!.name}`);
    }
    this.config = new ConfigurationModel(this.#defaults(data.configuration.defaults, data.extensions), data.configuration.user);
    this.#languages = data.languages;
    this.fs = this.env.createFs(this);
    this.#loader = this.env.createLoader((id) => this.apiFor(id));
    for (const desc of data.extensions) {
      this.exts.set(desc.id, { desc, events: desc.activationEvents.length ? desc.activationEvents : activationEventsOf(desc.manifest), active: false, unsupported: new Set() });
    }
    for (const d of data.documents) this.#documentOpened(d, false);
    this.#editorsChanged(data.editors, data.activeEditor, false);
    this.log("info", `Extension host (${data.hostKind}) started with ${data.extensions.length} extension(s): ${data.extensions.map((e) => e.id).join(", ") || "none"}`);
    return { apiVersion: API_VERSION };
  }

  /** TMCode's own defaults, then every extension's contributes.configuration and configurationDefaults. */
  #defaults(builtin: Flat, extensions: ExtensionDescription[]): Flat {
    const out: Flat = { ...builtin };
    for (const e of extensions) {
      for (const p of configurationProperties(e.manifest.contributes, e.displayName)) if (!(p.key in out)) out[p.key] = p.default;
      for (const [k, v] of Object.entries(configurationDefaults(e.manifest.contributes))) {
        out[k] = k.startsWith("[") && isObj(out[k]) && isObj(v) ? { ...(out[k] as object), ...v } : v;
      }
    }
    return out;
  }

  /** `*`, then workspaceContains, then onLanguage for open documents, then onStartupFinished. */
  async #startup() {
    await this.activateByEvent(STARTUP_EVENTS[0]);
    for (const ext of this.exts.values()) {
      const globs = workspaceContainsPatterns(ext.events);
      if (!globs.length || ext.activation) continue;
      for (const g of globs) {
        const hit = await this.findFiles(g, undefined, 1).catch(() => []);
        if (hit.length) {
          void this.activate(ext.desc.id, `workspaceContains:${g}`);
          break;
        }
      }
    }
    const langs = new Set([...this.#docs.values()].map((d) => d.languageId));
    await Promise.all([...langs].map((l) => this.activateByEvent(`onLanguage:${l}`)));
    await this.activateByEvent(STARTUP_EVENTS[1]);
  }

  // ───────────── activation ─────────────

  #setState(ext: ExtState, dto: Omit<ExtensionStateDTO, "id">) {
    this.rpc.notify("$main.extensionState", [{ id: ext.desc.id, ...dto }]);
  }

  async activateByEvent(event: string) {
    const hits = [...this.exts.values()].filter((e) => !e.activation && matchesActivationEvent(e.events, event));
    await Promise.all(hits.map((e) => this.activate(e.desc.id, event)));
  }

  activate(id: string, reason: string): Promise<void> {
    const ext = this.exts.get(id.toLowerCase());
    if (!ext) return Promise.resolve();
    if (ext.activation) return ext.activation;
    ext.activation = (async () => {
      const started = Date.now();
      this.#setState(ext, { state: "activating", reason });
      try {
        // extensionDependencies first (when they are installed and have code).
        const deps = Array.isArray(ext.desc.manifest.extensionDependencies) ? (ext.desc.manifest.extensionDependencies as string[]) : [];
        for (const dep of deps) if (this.exts.has(dep.toLowerCase())) await this.activate(dep, `dependency of ${ext.desc.id}`);
        ext.module = await this.#loader.load(ext.desc.location, ext.desc.entry, ext.desc.id);
        const context = this.#createContext(ext);
        ext.context = context;
        if (typeof ext.module?.activate === "function") ext.exports = await ext.module.activate.call(ext.module, context);
        ext.active = true;
        const time = Date.now() - started;
        this.#setState(ext, { state: "activated", reason, activationTime: time });
        this.log("info", `Activated ${ext.desc.id} in ${time}ms (${reason})`, ext.desc.id);
        this.onDidChangeExtensions.fire();
      } catch (e) {
        const msg = errorText(e);
        this.#setState(ext, { state: "failed", reason, activationTime: Date.now() - started, error: String((e as Error)?.message ?? e) });
        this.log("error", `Activating extension '${ext.desc.id}' failed: ${msg}`, ext.desc.id);
        this.#extLog(ext, "error", `Activating ${ext.desc.displayName} failed: ${msg}`);
      }
    })();
    return ext.activation;
  }

  async deactivateAll() {
    await Promise.all(
      [...this.exts.values()].filter((e) => e.active).map(async (e) => {
        try {
          await Promise.race([e.module?.deactivate?.(), new Promise((r) => setTimeout(r, 3000))]);
        } catch (err) {
          this.log("warn", `${e.desc.id}: deactivate() threw: ${errorText(err)}`);
        }
        for (const d of e.context?.subscriptions ?? []) {
          try {
            d?.dispose?.();
          } catch {
            /* ignore */
          }
        }
        e.active = false;
      }),
    );
  }

  /** The extension's own Output channel (its first channel, or one named after it). */
  #extLog(ext: ExtState, level: "info" | "warn" | "error", text: string) {
    if (!ext.logChannel) ext.logChannel = new OutputChannelImpl(ext.desc.displayName, `${ext.desc.id}#log`, this.rpc, false);
    ext.logChannel.appendLine(`[${level}] ${text}`);
  }

  notSupported(ext: ExtState, what: string, mode: "throw" | "warn" = "throw"): never | void {
    if (!ext.unsupported.has(what)) {
      ext.unsupported.add(what);
      const msg = `'${what}' is not supported in TMCode yet${mode === "warn" ? " (ignored)" : ""}.`;
      this.#extLog(ext, "warn", msg);
      this.rpc.notify("$main.unsupported", [ext.desc.id, what]);
    }
    if (mode === "throw") throw new NotSupportedError(what);
  }

  // ───────────── documents & editors ─────────────

  #documentOpened(dto: DocumentDTO, fire = true) {
    if (this.#docs.has(dto.path)) return;
    const uri = this.paths.toUri(dto.path);
    const d = new DocumentData(uri, dto.text, dto.languageId, dto.version, (doc) => this.#saveDocument(doc), dto.eol);
    d.isDirty = dto.isDirty;
    this.#docs.set(dto.path, d);
    this.#looseDocs.delete(dto.path);
    if (fire) {
      this.onDidOpenTextDocument.fire(d.document);
      void this.activateByEvent(`onLanguage:${dto.languageId}`);
    }
  }

  #documentChanged(path: string, version: number, changes: ContentChangeDTO[], isDirty: boolean) {
    const d = this.#docs.get(path);
    if (!d) return;
    const contentChanges: { range: T.Range; rangeOffset: number; rangeLength: number; text: string }[] = [];
    for (const c of changes) {
      d.applyChange(c as ContentChange);
      contentChanges.push({ range: C.range.to(c.range), rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, text: c.text });
    }
    d.version = version;
    d.isDirty = isDirty;
    this.onDidChangeTextDocument.fire({ document: d.document, contentChanges, reason: undefined });
  }

  #documentClosed(path: string) {
    const d = this.#docs.get(path);
    if (!d) return;
    this.#docs.delete(path);
    d.isClosed = true;
    this.onDidCloseTextDocument.fire(d.document);
  }

  async #saveDocument(d: DocumentData): Promise<boolean> {
    const path = this.paths.toPath(d.uri);
    if (path === null || !this.#docs.has(path)) return false;
    return this.rpc.request<boolean>("$main.saveDocument", [path]);
  }

  #editorsChanged(list: EditorDTO[], active: string | null, fire = true) {
    const before = this.#activeEditor;
    const seen = new Set<string>();
    for (const dto of list) {
      seen.add(dto.id);
      const ed = this.#editors.get(dto.id);
      if (ed && ed.path === dto.path) ed.update(dto);
      else this.#editors.set(dto.id, new TextEditorImpl(dto.id, dto.path, this, dto));
    }
    for (const id of [...this.#editors.keys()]) if (!seen.has(id)) this.#editors.delete(id);
    this.#activeEditor = active && this.#editors.has(active) ? active : null;
    if (!fire) return;
    this.onDidChangeVisibleTextEditors.fire(this.visibleEditors());
    if (before !== this.#activeEditor || (active && !before)) this.onDidChangeActiveTextEditor.fire(this.activeEditor());
  }

  activeEditor(): TextEditorImpl | undefined {
    const ed = this.#activeEditor ? this.#editors.get(this.#activeEditor) : undefined;
    return ed && this.#docs.has(ed.path) ? ed : undefined;
  }

  visibleEditors(): TextEditorImpl[] {
    return [...this.#editors.values()].filter((e) => this.#docs.has(e.path));
  }

  async applyEditorEdits(path: string, edits: TextEditDTO[], options: { undoStopBefore?: boolean; undoStopAfter?: boolean }): Promise<boolean> {
    if (!edits.length) return true;
    const d = this.#docs.get(path);
    return this.rpc.request<boolean>("$main.editorEdit", [path, edits, { undoStopBefore: options.undoStopBefore !== false, undoStopAfter: options.undoStopAfter !== false }, d?.version ?? null]);
  }

  #fileEvents(events: { path: string; type: "create" | "change" | "delete" }[]) {
    for (const ev of events) {
      const uri = this.paths.toUri(ev.path);
      for (const w of this.#fileWatchers) if (matchGlob(w.glob, w.base ? ev.path.slice(w.base.length).replace(/^\//, "") : ev.path)) w.fire(ev.type, uri);
    }
  }

  // ───────────── commands ─────────────

  registerCommand(id: string, fn: (...args: unknown[]) => unknown, thisArg: unknown, ext?: ExtState): T.Disposable {
    if (this.#commands.has(id)) {
      // VS Code throws for duplicates; an extension re-registering on reload must not fail activation.
      this.log("warn", `command '${id}' already exists`, ext?.desc.id);
    }
    this.#commands.set(id, { fn, thisArg, ext });
    this.rpc.notify("$main.registerCommand", [id, ext?.desc.id ?? null]);
    return new T.Disposable(() => {
      if (this.#commands.get(id)?.fn !== fn) return;
      this.#commands.delete(id);
      this.rpc.notify("$main.unregisterCommand", [id]);
    });
  }

  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    if (!this.#commands.has(id)) await this.activateByEvent(`onCommand:${id}`);
    const local = this.#commands.get(id);
    if (local) {
      try {
        return await local.fn.apply(local.thisArg, args);
      } catch (e) {
        if (local.ext) this.#extLog(local.ext, "error", `Command '${id}' failed: ${errorText(e)}`);
        throw e;
      }
    }
    const builtin = await this.#builtinCommand(id, args);
    if (builtin.handled) return builtin.result;
    return this.rpc.request("$main.executeCommand", [id, this.#serializeArgs(args)]);
  }

  /** API commands the host answers itself (vscode.execute*Provider subset, setContext bookkeeping). */
  async #builtinCommand(id: string, args: unknown[]): Promise<{ handled: boolean; result?: unknown }> {
    if (id === "setContext") {
      this.#contextKeys.set(String(args[0]), args[1]);
      this.rpc.notify("$main.setContext", [String(args[0]), this.#serializeArgs([args[1]])[0]]);
      return { handled: true };
    }
    return { handled: false };
  }

  // ───────────── language providers ─────────────

  registerProvider(ext: ExtState, kind: ProviderKind, selector: unknown, provider: unknown, meta: Omit<ProviderMeta, "extensionId"> = {}): T.Disposable {
    if (!provider || typeof provider !== "object") throw new Error(`Invalid ${kind} provider`);
    const handle = ++this.#handleSeq;
    const sel = C.selector(selector);
    this.#providers.set(handle, { kind, provider: provider as Provider["provider"], ext, selector: sel });
    this.rpc.notify("$main.registerProvider", [handle, kind, sel, { ...meta, extensionId: ext.desc.id }]);
    return new T.Disposable(() => {
      if (!this.#providers.delete(handle)) return;
      this.rpc.notify("$main.unregisterProvider", [handle]);
    });
  }

  async #provide(handle: number, method: string, args: unknown[], token: CancellationToken): Promise<unknown> {
    const p = this.#providers.get(handle);
    if (!p) return null;
    const call = async (name: string, ...a: unknown[]) => {
      const fn = p.provider[name];
      if (typeof fn !== "function") return undefined;
      try {
        return await fn.apply(p.provider, [...a, token]);
      } catch (e) {
        if ((e as Error)?.name === "Canceled") return undefined;
        this.#extLog(p.ext, "error", `${name} failed: ${errorText(e)}`);
        throw e;
      }
    };
    const doc = (path: unknown) => {
      const d = this.#docs.get(String(path));
      if (!d) throw new Error(`Document ${path} is not open`);
      return d.document;
    };
    const pos = (v: unknown) => C.position.to(v as [number, number]);
    const rng = (v: unknown) => C.range.to(v as RangeDTO);
    const fmt = (o: unknown) => ({ tabSize: 4, insertSpaces: true, ...(o as object) });
    switch (method) {
      case "provideCompletionItems": {
        const ctx = (args[2] ?? {}) as { triggerKind?: number; triggerCharacter?: string };
        const res = (await call("provideCompletionItems", doc(args[0]), pos(args[1]), { triggerKind: ctx.triggerKind ?? 0, triggerCharacter: ctx.triggerCharacter })) as T.CompletionItem[] | T.CompletionList | undefined;
        if (!res) return null;
        const items = Array.isArray(res) ? res : Array.isArray(res.items) ? res.items : [];
        const cacheId = ++this.#cacheSeq;
        this.#completionCache.set(cacheId, items);
        if (this.#completionCache.size > 20) this.#completionCache.delete(this.#completionCache.keys().next().value!);
        const out: CompletionListDTO = { cacheId, incomplete: !Array.isArray(res) && !!res.isIncomplete, items: items.map((it, i) => C.completionItem(it, i, this.#commandCacheApi)).filter((x) => !!x) as CompletionListDTO["items"] };
        return out;
      }
      case "resolveCompletionItem": {
        const item = this.#completionCache.get(Number(args[0]))?.[Number(args[1])];
        if (!item || typeof p.provider.resolveCompletionItem !== "function") return null;
        const resolved = ((await call("resolveCompletionItem", item)) as T.CompletionItem | undefined) ?? item;
        return C.completionItem(resolved, Number(args[1]), this.#commandCacheApi) ?? null;
      }
      case "provideHover":
        return C.hover((await call("provideHover", doc(args[0]), pos(args[1]))) as T.Hover) ?? null;
      case "provideDefinition":
      case "provideDeclaration":
      case "provideTypeDefinition":
      case "provideImplementation":
        return C.locations(await call(method, doc(args[0]), pos(args[1])), this.paths);
      case "provideReferences":
        return C.locations(await call("provideReferences", doc(args[0]), pos(args[1]), { includeDeclaration: !!args[2] }), this.paths);
      case "provideDocumentSymbols":
        return C.documentSymbols(await call("provideDocumentSymbols", doc(args[0])), this.paths);
      case "provideCodeActions": {
        const ctxDto = (args[2] ?? {}) as { diagnostics?: { range: RangeDTO; message: string; severity: number; source?: string; code?: string | number }[]; only?: string; triggerKind?: number };
        const diagnostics = (ctxDto.diagnostics ?? []).map((d) => {
          const x = new T.Diagnostic(C.range.to(d.range), d.message || " ", d.severity as T.DiagnosticSeverity);
          if (d.source) x.source = d.source;
          if (d.code !== undefined) x.code = d.code;
          return x;
        });
        const res = (await call("provideCodeActions", doc(args[0]), rng(args[1]), { diagnostics, only: ctxDto.only ? new T.CodeActionKind(ctxDto.only) : undefined, triggerKind: ctxDto.triggerKind ?? T.CodeActionTriggerKind.Invoke })) as (T.CodeAction | T.Command)[] | undefined;
        return (res ?? []).map((a) => C.codeAction(a, this.paths, this.#commandCacheApi)).filter(Boolean);
      }
      case "provideDocumentFormattingEdits":
        return C.textEdits(await call("provideDocumentFormattingEdits", doc(args[0]), fmt(args[1])));
      case "provideDocumentRangeFormattingEdits":
        return C.textEdits(await call("provideDocumentRangeFormattingEdits", doc(args[0]), rng(args[1]), fmt(args[2])));
      case "provideOnTypeFormattingEdits":
        return C.textEdits(await call("provideOnTypeFormattingEdits", doc(args[0]), pos(args[1]), String(args[2]), fmt(args[3])));
      case "provideDocumentColors": {
        const res = (await call("provideDocumentColors", doc(args[0]))) as T.ColorInformation[] | undefined;
        return (res ?? []).filter((c) => c && c.color && T.Range.isRange(c.range)).map((c) => ({ range: C.range.from(c.range), color: [c.color.red, c.color.green, c.color.blue, c.color.alpha] }));
      }
      case "provideColorPresentations": {
        const [r, g, b, a] = args[1] as number[];
        const res = (await call("provideColorPresentations", new T.Color(r, g, b, a), { document: doc(args[0]), range: rng(args[2]) })) as T.ColorPresentation[] | undefined;
        return (res ?? []).map((c) => ({ label: c.label, textEdit: c.textEdit ? C.textEdit(c.textEdit) : undefined, additionalTextEdits: c.additionalTextEdits ? C.textEdits(c.additionalTextEdits) : undefined }));
      }
      case "provideDocumentHighlights": {
        const res = (await call("provideDocumentHighlights", doc(args[0]), pos(args[1]))) as T.DocumentHighlight[] | undefined;
        return (res ?? []).filter((h) => h && T.Range.isRange(h.range)).map((h) => ({ range: C.range.from(h.range), kind: h.kind ?? 0 }));
      }
      case "provideDocumentLinks": {
        const res = (await call("provideDocumentLinks", doc(args[0]))) as T.DocumentLink[] | undefined;
        return (res ?? []).filter((l) => l && T.Range.isRange(l.range)).map((l) => ({ range: C.range.from(l.range), target: l.target ? (this.paths.toPath(l.target) !== null ? { path: this.paths.toPath(l.target) } : { uri: l.target.toString() }) : undefined, tooltip: l.tooltip }));
      }
      case "provideFoldingRanges": {
        const res = (await call("provideFoldingRanges", doc(args[0]), {})) as T.FoldingRange[] | undefined;
        return (res ?? []).filter((f) => f && typeof f.start === "number").map((f) => ({ start: f.start, end: f.end, kind: f.kind }));
      }
      case "provideSignatureHelp": {
        const ctx = (args[2] ?? {}) as { triggerKind?: number; triggerCharacter?: string; isRetrigger?: boolean };
        return C.signatureHelp((await call("provideSignatureHelp", doc(args[0]), pos(args[1]), { triggerKind: ctx.triggerKind ?? 1, triggerCharacter: ctx.triggerCharacter, isRetrigger: !!ctx.isRetrigger, activeSignatureHelp: undefined })) as T.SignatureHelp) ?? null;
      }
      case "provideRenameEdits": {
        const res = (await call("provideRenameEdits", doc(args[0]), pos(args[1]), String(args[2]))) as T.WorkspaceEdit | undefined;
        return res ? C.workspaceEdit(res, this.paths) : null;
      }
      case "prepareRename": {
        const res = (await call("prepareRename", doc(args[0]), pos(args[1]))) as T.Range | { range: T.Range; placeholder: string } | undefined;
        if (!res) return null;
        if (T.Range.isRange(res)) return { range: C.range.from(res) };
        return { range: C.range.from(res.range), placeholder: res.placeholder };
      }
      case "provideInlayHints": {
        const res = (await call("provideInlayHints", doc(args[0]), rng(args[1]))) as T.InlayHint[] | undefined;
        return (res ?? []).filter((h) => h && T.Position.isPosition(h.position)).map((h) => ({
          position: C.position.from(h.position),
          label: typeof h.label === "string" ? h.label : Array.isArray(h.label) ? (h.label as { value: string }[]).map((p) => p.value).join("") : "",
          kind: h.kind,
          tooltip: h.tooltip ? C.documentation(h.tooltip) : undefined,
          paddingLeft: h.paddingLeft,
          paddingRight: h.paddingRight,
        }));
      }
      case "provideCodeLenses": {
        const res = (await call("provideCodeLenses", doc(args[0]))) as T.CodeLens[] | undefined;
        const lenses = (res ?? []).filter((l) => l && T.Range.isRange(l.range));
        const cacheId = ++this.#cacheSeq;
        this.#codeLensCache.set(cacheId, { lenses, handle });
        return { cacheId, lenses: lenses.map((l, i) => ({ i, range: C.range.from(l.range), command: C.command(l.command, this.#commandCacheApi) })) };
      }
      case "resolveCodeLens": {
        const entry = this.#codeLensCache.get(Number(args[0]));
        const lens = entry?.lenses[Number(args[1])];
        if (!lens) return null;
        const resolved = ((await call("resolveCodeLens", lens)) as T.CodeLens | undefined) ?? lens;
        return { i: Number(args[1]), range: C.range.from(resolved.range), command: C.command(resolved.command, this.#commandCacheApi) };
      }
      case "provideLinkedEditingRanges": {
        const res = (await call("provideLinkedEditingRanges", doc(args[0]), pos(args[1]))) as T.LinkedEditingRanges | undefined;
        if (!res) return null;
        return { ranges: res.ranges.map(C.range.from), wordPattern: res.wordPattern ? { source: res.wordPattern.source, flags: res.wordPattern.flags } : undefined };
      }
      case "provideSelectionRanges": {
        const res = (await call("provideSelectionRanges", doc(args[0]), (args[1] as [number, number][]).map((x) => C.position.to(x)))) as T.SelectionRange[] | undefined;
        return (res ?? []).map((s) => {
          const chain: RangeDTO[] = [];
          for (let cur: T.SelectionRange | undefined = s; cur; cur = cur.parent) chain.push(C.range.from(cur.range));
          return chain;
        });
      }
      default:
        throw new Error(`Unknown provider method ${method}`);
    }
  }

  // ───────────── diagnostics ─────────────

  createDiagnosticCollection(ext: ExtState, name?: string) {
    const owner = `${ext.desc.id}:${name ?? "default"}:${++this.#handleSeq}`;
    const map = new Map<string, { uri: Uri; diags: T.Diagnostic[] }>();
    this.#diagnostics.set(owner, new Map());
    let pending = new Set<string>();
    let scheduled = false;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;
    const flush = () => {
      scheduled = false;
      const entries: [string, unknown[] | null][] = [];
      const changedUris: Uri[] = [];
      for (const key of pending) {
        const e = map.get(key);
        const uri = e?.uri ?? Uri.parse(key);
        changedUris.push(uri);
        const path = host.paths.toPath(uri);
        if (path === null) continue;
        entries.push([path, e ? e.diags.map((d) => C.diagnostic(d, host.paths)) : null]);
      }
      pending = new Set();
      host.#diagnostics.set(owner, new Map([...map.entries()].map(([k, v]) => [k, v.diags])));
      if (entries.length) host.rpc.notify("$main.setDiagnostics", [owner, entries]);
      if (changedUris.length) host.onDidChangeDiagnostics.fire({ uris: changedUris });
    };
    const touch = (key: string) => {
      pending.add(key);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    };
    let disposed = false;
    const collection = {
      get name() {
        return name ?? owner;
      },
      set(a: Uri | readonly [Uri, readonly T.Diagnostic[] | undefined][], b?: readonly T.Diagnostic[] | undefined) {
        if (disposed) return;
        if (Uri.isUri(a)) {
          const key = a.toString();
          if (!b || !b.length) map.delete(key);
          else map.set(key, { uri: a, diags: b.filter((d) => d && T.Range.isRange(d.range)) });
          touch(key);
          return;
        }
        // An array of [uri, diagnostics]; entries of one uri merge, undefined clears.
        const grouped = new Map<string, { uri: Uri; diags: T.Diagnostic[] | null }>();
        for (const [uri, diags] of a as [Uri, T.Diagnostic[] | undefined][]) {
          const key = uri.toString();
          const cur = grouped.get(key);
          if (!diags) grouped.set(key, { uri, diags: null });
          else if (cur && cur.diags) cur.diags.push(...diags);
          else grouped.set(key, { uri, diags: [...diags] });
        }
        for (const [key, { uri, diags }] of grouped) {
          if (!diags || !diags.length) map.delete(key);
          else map.set(key, { uri, diags });
          touch(key);
        }
      },
      delete(uri: Uri) {
        const key = uri.toString();
        if (map.delete(key)) touch(key);
      },
      clear() {
        for (const key of map.keys()) touch(key);
        map.clear();
      },
      forEach(cb: (uri: Uri, diags: readonly T.Diagnostic[], c: unknown) => unknown, thisArg?: unknown) {
        for (const { uri, diags } of map.values()) cb.call(thisArg, uri, diags, collection);
      },
      get(uri: Uri) {
        return map.get(uri.toString())?.diags;
      },
      has(uri: Uri) {
        return map.has(uri.toString());
      },
      dispose() {
        if (disposed) return;
        collection.clear();
        flush();
        disposed = true;
        host.#diagnostics.delete(owner);
        host.rpc.notify("$main.clearDiagnostics", [owner]);
      },
      [Symbol.iterator]: function* () {
        for (const { uri, diags } of map.values()) yield [uri, diags] as const;
      },
    };
    return collection;
  }

  /** VS Code's save participants: listeners run in turn, each may waitUntil(edits); 1.5 s budget in all. */
  async #willSave(path: string, reason: number): Promise<TextEditDTO[]> {
    const d = this.#docs.get(path);
    if (!d) return [];
    const pending: PromiseLike<unknown>[] = [];
    let open = true;
    const event = {
      document: d.document,
      reason,
      waitUntil: (thenable: PromiseLike<unknown>) => {
        if (!open) throw new Error("waitUntil can only be called synchronously in the event listener");
        pending.push(thenable);
      },
    };
    this.onWillSaveTextDocument.fire(event);
    open = false;
    if (!pending.length) return [];
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1500));
    const settled = await Promise.race([Promise.allSettled(pending.map((p) => Promise.resolve(p))), timeout]);
    if (settled === "timeout") return [];
    const edits: TextEditDTO[] = [];
    for (const r of settled) if (r.status === "fulfilled" && Array.isArray(r.value)) edits.push(...C.textEdits(r.value));
    return edits;
  }

  #workbenchDiagnostics(entries: [string, DiagnosticDTO[]][]) {
    const owner = "workbench";
    const byUri = this.#diagnostics.get(owner) ?? new Map<string, T.Diagnostic[]>();
    const changed: Uri[] = [];
    for (const [path, list] of entries) {
      const uri = this.paths.toUri(path);
      changed.push(uri);
      if (!list.length) byUri.delete(uri.toString());
      else
        byUri.set(
          uri.toString(),
          list.map((d) => {
            const diag = new T.Diagnostic(C.range.to(d.range), d.message, d.severity);
            if (d.source) diag.source = d.source;
            if (d.code !== undefined) diag.code = d.code;
            if (d.tags?.length) diag.tags = d.tags;
            return diag;
          }),
        );
    }
    this.#diagnostics.set(owner, byUri);
    if (changed.length) this.onDidChangeDiagnostics.fire({ uris: changed });
  }

  getDiagnostics(uri?: Uri): unknown {
    if (uri) {
      const key = uri.toString();
      return [...this.#diagnostics.values()].flatMap((m) => m.get(key) ?? []);
    }
    const all = new Map<string, T.Diagnostic[]>();
    for (const m of this.#diagnostics.values()) for (const [k, v] of m) all.set(k, [...(all.get(k) ?? []), ...v]);
    return [...all.entries()].map(([k, v]) => [Uri.parse(k), v]);
  }

  // ───────────── workspace ─────────────

  async findFiles(include: string | T.RelativePattern, exclude?: string | T.RelativePattern | null, maxResults?: number, token?: CancellationToken): Promise<Uri[]> {
    if (!this.folder) return [];
    let base = "";
    let pattern: string;
    if (typeof include === "string") pattern = include;
    else {
      const rel = this.paths.toPath(include.baseUri);
      if (rel === null) return [];
      base = rel;
      pattern = include.pattern;
    }
    let excludes: string[];
    if (exclude === null) excludes = [];
    else if (exclude === undefined) excludes = [...enabledPatterns(this.config.getValue("files.exclude")), ...enabledPatterns(this.config.getValue("search.exclude"))];
    else excludes = [typeof exclude === "string" ? exclude : exclude.pattern];
    const out: Uri[] = [];
    const max = maxResults ?? 10_000;
    let visited = 0;
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= max || token?.isCancellationRequested || visited > 50_000) return;
      let entries: [string, number][];
      try {
        entries = await this.fs.readDirectory(this.paths.toUri(dir));
      } catch {
        return;
      }
      for (const [name, type] of entries) {
        if (out.length >= max) return;
        visited++;
        const path = dir ? `${dir}/${name}` : name;
        if (excludes.some((g) => matchGlob(g, path) || matchGlob(g, name))) continue;
        if (type & T.FileType.Directory) await walk(path);
        else {
          const rel = base ? path.slice(base.length).replace(/^\//, "") : path;
          if (matchGlob(pattern, rel)) out.push(this.paths.toUri(path));
        }
      }
    };
    await walk(base);
    return out;
  }

  async openTextDocument(arg?: Uri | string | { language?: string; content?: string; encoding?: string }) {
    if (arg === undefined || (isObj(arg) && !Uri.isUri(arg))) {
      const opts = (arg ?? {}) as { language?: string; content?: string };
      const uri = Uri.from({ scheme: "untitled", path: `Untitled-${++this.#untitledSeq}` });
      const d = new DocumentData(uri, opts.content ?? "", opts.language ?? "plaintext", 1, async () => false);
      this.#looseDocs.set(uri.toString(), d);
      this.onDidOpenTextDocument.fire(d.document);
      return d.document;
    }
    const uri = typeof arg === "string" ? Uri.file(arg) : Uri.revive(arg as Uri);
    const path = this.paths.toPath(uri);
    if (path !== null) {
      const open = this.#docs.get(path);
      if (open) return open.document;
      const dto = await this.rpc.request<DocumentDTO | null>("$main.openTextDocument", [path]);
      const now = this.#docs.get(path);
      if (now) return now.document;
      if (dto) {
        this.#documentOpened(dto);
        return this.#docs.get(path)!.document;
      }
      throw T.FileSystemError.FileNotFound(uri);
    }
    // Outside the workspace: a read-only snapshot the host reads itself.
    const key = uri.toString();
    const loose = this.#looseDocs.get(key);
    if (loose) return loose.document;
    const bytes = await this.fs.readFile(uri);
    const d = new DocumentData(uri, new TextDecoder().decode(bytes), languageFromName(uri.path), 1, async () => false);
    this.#looseDocs.set(key, d);
    return d.document;
  }

  // ───────────── API construction ─────────────

  apiFor(extensionId: string): unknown {
    const ext = this.exts.get(extensionId.toLowerCase());
    if (!ext) throw new Error(`Unknown extension ${extensionId}`);
    if (!ext.api) ext.api = createApi(this, ext);
    return ext.api;
  }

  #createContext(ext: ExtState) {
    const loc = ext.desc.location;
    const extensionUri = this.env.kind === "node" ? Uri.file(loc) : Uri.from({ scheme: "tmcode-extension", path: `/${ext.desc.id}` });
    const env = this.data.env;
    const storageBase = env.storagePath ? Uri.file(env.storagePath) : Uri.from({ scheme: "tmcode-storage", path: "/" });
    const globalStorageUri = Uri.joinPath(storageBase, "globalStorage", ext.desc.id);
    const storageUri = this.folder ? Uri.joinPath(storageBase, "workspaceStorage", env.workspaceKey ?? "default", ext.desc.id) : undefined;
    const logUri = Uri.joinPath(storageBase, "logs", ext.desc.id);
    const gs = (this.data.state.global[ext.desc.id] ??= {});
    const ws = (this.data.state.workspace[ext.desc.id] ??= {});
    const persist = (scope: "global" | "workspace") => (key: string, value: unknown) => this.rpc.notify("$main.state", [scope, ext.desc.id, key, value === undefined ? null : value]);
    const secretsChanged = new EventEmitter<{ key: string }>();
    const rpc = this.rpc;
    const envCollection = {
      persistent: true,
      description: undefined,
      replace() {},
      append() {},
      prepend() {},
      get() {
        return undefined;
      },
      forEach() {},
      delete() {},
      clear() {},
      getScoped() {
        return envCollection;
      },
      [Symbol.iterator]: function* () {},
    };
    return {
      subscriptions: [] as { dispose(): unknown }[],
      extensionPath: extensionUri.fsPath,
      extensionUri,
      asAbsolutePath: (rel: string) => (this.env.kind === "node" ? joinFs(loc, rel, this.env.isWindows) : Uri.joinPath(extensionUri, rel).path),
      globalState: new Memento(gs, persist("global")),
      workspaceState: new Memento(ws, persist("workspace")),
      secrets: {
        get: (key: string) => rpc.request<string | null>("$main.secrets", ["get", ext.desc.id, key]).then((v) => v ?? undefined),
        store: async (key: string, value: string) => {
          await rpc.request("$main.secrets", ["store", ext.desc.id, key, value]);
          secretsChanged.fire({ key });
        },
        delete: async (key: string) => {
          await rpc.request("$main.secrets", ["delete", ext.desc.id, key]);
          secretsChanged.fire({ key });
        },
        keys: () => rpc.request<string[]>("$main.secrets", ["keys", ext.desc.id]).then((v) => v ?? []),
        onDidChange: secretsChanged.event,
      },
      storageUri,
      storagePath: storageUri?.fsPath,
      globalStorageUri,
      globalStoragePath: globalStorageUri.fsPath,
      logUri,
      logPath: logUri.fsPath,
      extensionMode: T.ExtensionMode.Production,
      extension: this.extensionObject(ext),
      environmentVariableCollection: envCollection,
      extensionRuntime: this.env.kind === "node" ? 1 : 2,
      languageModelAccessInformation: { onDidChange: new EventEmitter<void>().event, canSendRequest: () => undefined },
    };
  }

  extensionObject(ext: ExtState) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;
    const uri = this.env.kind === "node" ? Uri.file(ext.desc.location) : Uri.from({ scheme: "tmcode-extension", path: `/${ext.desc.id}` });
    return {
      id: `${ext.desc.publisher}.${ext.desc.name}`,
      extensionUri: uri,
      extensionPath: uri.fsPath,
      get isActive() {
        return ext.active;
      },
      packageJSON: ext.desc.manifest,
      extensionKind: T.ExtensionKind.Workspace,
      get exports() {
        return ext.exports;
      },
      activate: async () => {
        await host.activate(ext.desc.id, "api");
        return ext.exports;
      },
    };
  }

  // ───────────── window helpers used by the API ─────────────

  async showMessage(severity: "info" | "warning" | "error", message: string, rest: unknown[]) {
    let options: { modal?: boolean; detail?: string } = {};
    let items = rest;
    if (rest.length && isObj(rest[0]) && !("title" in (rest[0] as object))) {
      options = rest[0] as typeof options;
      items = rest.slice(1);
    }
    items = items.filter((i) => i !== undefined && i !== null);
    const labels = items.map((i) => (typeof i === "string" ? i : String((i as { title?: string }).title ?? "")));
    const idx = await this.rpc.request<number | null>("$main.showMessage", [severity, String(message), { modal: !!options.modal, detail: options.detail }, labels]);
    return idx === null || idx === undefined ? undefined : items[idx];
  }

  async showQuickPick(itemsOrPromise: unknown, options: Record<string, unknown> = {}, token?: CancellationToken) {
    const items = (await itemsOrPromise) as (string | Record<string, unknown>)[];
    if (!Array.isArray(items) || token?.isCancellationRequested) return undefined;
    const dtos: QuickPickItemDTO[] = items.map((i) => {
      if (typeof i === "string") return { label: i };
      return {
        label: String(i.label ?? ""),
        description: typeof i.description === "string" ? i.description : undefined,
        detail: typeof i.detail === "string" ? i.detail : undefined,
        picked: !!i.picked,
        alwaysShow: !!i.alwaysShow,
        separator: i.kind === T.QuickPickItemKind.Separator,
        iconPath: i.iconPath instanceof T.ThemeIcon ? i.iconPath.id : undefined,
      };
    });
    const res = await this.rpc.request<number[] | null>("$main.showQuickPick", [
      dtos,
      { title: options.title, placeHolder: options.placeHolder, canPickMany: !!options.canPickMany, matchOnDescription: !!options.matchOnDescription, matchOnDetail: !!options.matchOnDetail },
    ]);
    if (!res) return undefined;
    const picked = res.map((i) => items[i]).filter((x) => x !== undefined);
    return options.canPickMany ? picked : picked[0];
  }

  async showInputBox(options: Record<string, unknown> = {}) {
    let validator: number | null = null;
    if (typeof options.validateInput === "function") {
      validator = ++this.#inputSeq;
      this.#inputValidators.set(validator, options.validateInput as (v: string) => unknown);
    }
    try {
      const res = await this.rpc.request<string | null>("$main.showInputBox", [{ title: options.title, prompt: options.prompt, placeHolder: options.placeHolder, value: options.value, password: !!options.password, validator }]);
      return res === null ? undefined : res;
    } finally {
      if (validator !== null) this.#inputValidators.delete(validator);
    }
  }

  createOutputChannel(ext: ExtState, name: string, options?: string | { log?: boolean }) {
    const log = isObj(options) && !!options.log;
    const ch = new OutputChannelImpl(String(name), `${ext.desc.id}#${++this.#outputSeq}`, this.rpc, log);
    // An extension's first channel is where TMCode reports its errors.
    if (!ext.logChannel) ext.logChannel = ch;
    return ch;
  }

  createStatusBarItem(ext: ExtState, idOrAlignment?: string | number, alignmentOrPriority?: number, maybePriority?: number, selector?: SelectorDTO[]) {
    let id: string;
    let alignment: number;
    let priority: number;
    if (typeof idOrAlignment === "string") {
      id = `${ext.desc.id}.${idOrAlignment}`;
      alignment = alignmentOrPriority ?? T.StatusBarAlignment.Left;
      priority = maybePriority ?? 0;
    } else {
      id = `${ext.desc.id}.${++this.#statusSeq}`;
      alignment = idOrAlignment ?? T.StatusBarAlignment.Left;
      priority = alignmentOrPriority ?? 0;
    }
    const rpc = this.rpc;
    const cmdCache = this.#commandCacheApi;
    const state: Record<string, unknown> = { text: "", tooltip: undefined, command: undefined, color: undefined, backgroundColor: undefined, name: undefined, accessibilityInformation: undefined, severity: undefined, detail: undefined, busy: false };
    let visible = false;
    let scheduled = false;
    let disposed = false;
    const push = () => {
      scheduled = false;
      if (disposed) return;
      const cmd = state.command;
      const dto: StatusBarEntryDTO = {
        id,
        extensionId: ext.desc.id,
        name: (state.name as string) ?? ext.desc.displayName,
        text: (state.busy ? "$(loading~spin) " : "") + String(state.text ?? ""),
        tooltip: typeof state.tooltip === "string" ? state.tooltip : T.MarkdownString.isMarkdownString(state.tooltip) ? state.tooltip.value : (state.detail as string) || undefined,
        command: typeof cmd === "string" ? C.command({ command: cmd, title: "" }, cmdCache) : isObj(cmd) ? C.command(cmd as unknown as T.Command, cmdCache) : undefined,
        color: state.color instanceof T.ThemeColor ? `var(--tm-theme-${state.color.id})` : (state.color as string),
        backgroundColor: state.backgroundColor instanceof T.ThemeColor ? state.backgroundColor.id : undefined,
        alignment: alignment === T.StatusBarAlignment.Right ? 2 : 1,
        priority,
        visible,
        selector,
      };
      rpc.notify("$main.statusBar", ["update", dto]);
    };
    const schedule = () => {
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(push);
      }
    };
    const item: Record<string, unknown> = {
      id,
      alignment,
      priority,
      show() {
        visible = true;
        schedule();
      },
      hide() {
        visible = false;
        schedule();
      },
      dispose() {
        disposed = true;
        rpc.notify("$main.statusBar", ["dispose", { id }]);
      },
    };
    for (const key of Object.keys(state)) {
      Object.defineProperty(item, key, {
        get: () => state[key],
        set: (v) => {
          state[key] = v;
          schedule();
        },
        enumerable: true,
      });
    }
    // Language status items are visible from the start.
    if (selector) {
      visible = true;
      schedule();
    }
    return item;
  }

  async withProgress(options: { location?: number | { viewId: string }; title?: string; cancellable?: boolean }, task: (progress: { report(v: { message?: string; increment?: number }): void }, token: CancellationToken) => unknown) {
    const handle = ++this.#progressSeq;
    const src = new CancellationTokenSource();
    this.#progress.set(handle, src);
    const location = typeof options.location === "number" ? options.location : T.ProgressLocation.Window;
    this.rpc.notify("$main.progress", ["start", handle, { location, title: options.title, cancellable: !!options.cancellable }]);
    try {
      return await task({ report: (v) => this.rpc.notify("$main.progress", ["report", handle, { message: v?.message, increment: v?.increment }]) }, src.token);
    } finally {
      this.#progress.delete(handle);
      this.rpc.notify("$main.progress", ["end", handle]);
    }
  }

  createDecorationType(options: DecorationOptionsDTO & Record<string, unknown>) {
    const key = `tmext-deco-${++this.#decorationSeq}`;
    const clean = JSON.parse(JSON.stringify(options, (k, v) => (v instanceof T.ThemeColor ? `var(--vscode-${v.id.replace(/\./g, "-")})` : k === "gutterIconPath" ? undefined : v)));
    this.rpc.notify("$main.decorationType", ["create", key, clean]);
    return {
      key,
      dispose: () => this.rpc.notify("$main.decorationType", ["dispose", key]),
    };
  }

  addFileWatcher(w: { glob: string; base?: string; fire: (type: "create" | "change" | "delete", uri: Uri) => void }) {
    this.#fileWatchers.add(w);
    return () => this.#fileWatchers.delete(w);
  }

  get languages() {
    return this.#languages;
  }

  contextKey(key: string) {
    return this.#contextKeys.get(key);
  }
}

function joinFs(base: string, rel: string, windows: boolean): string {
  const sep = windows ? "\\" : "/";
  const parts = rel.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

const EXT_LANG: Record<string, string> = { js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", jsx: "javascriptreact", tsx: "typescriptreact", json: "json", md: "markdown", py: "python", html: "html", css: "css", c: "c", cpp: "cpp", java: "java" };
function languageFromName(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "plaintext";
}

export type { ExtState, Event };
export { OutputChannelImpl, TextEditorImpl, NotSupportedError };
