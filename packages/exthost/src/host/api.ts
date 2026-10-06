/**
 * Builds the `vscode` module one extension sees (each extension gets its own
 * object, so logs and unsupported calls are attributed to it). Namespaces are
 * wrapped in a guard: a member TMCode does not implement yet logs to the
 * extension's Output channel; event subscriptions and registrations of
 * unsupported kinds return a no-op Disposable (so activation still succeeds),
 * any other call throws a clear "not supported in TMCode yet" error.
 */

import * as T from "../api/types";
import * as MT from "../api/moreTypes";
import { Uri } from "../api/uri";
import { CancellationTokenSource, EventEmitter, type CancellationToken } from "../api/events";
import * as C from "./convert";
import { matchGlob } from "./glob";
import { API_VERSION, type ExtHost, type ExtState } from "./extHost";
import type { SelectorDTO } from "../protocol";

type AnyFn = (...args: never[]) => unknown;

const noopDisposable = () => new T.Disposable(() => {});

/** A guarded namespace: unknown members are reported instead of being `undefined`. */
function guard<O extends object>(host: ExtHost, ext: ExtState, nsName: string, ns: O): O {
  return new Proxy(ns, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop in target) return Reflect.get(target, prop, receiver);
      // Thenable / serialisation probes must stay undefined.
      if (prop === "then" || prop === "toJSON" || prop === "constructor" || prop.startsWith("__")) return undefined;
      const name = nsName ? `${nsName}.${prop}` : prop;
      if (/^on(Did|Will)[A-Z]/.test(prop)) {
        return () => {
          host.notSupported(ext, name, "warn");
          return noopDisposable();
        };
      }
      if (/^register[A-Z]/.test(prop)) {
        return () => {
          host.notSupported(ext, name, "warn");
          return noopDisposable();
        };
      }
      // A function (callable and constructible) that explains itself.
      const stub = function () {
        host.notSupported(ext, name, "throw");
      };
      Object.defineProperty(stub, "name", { value: prop });
      return stub;
    },
  });
}

function isSelectorMatch(sel: SelectorDTO[], doc: { languageId: string; uri: Uri }, host: ExtHost): number {
  let best = 0;
  for (const f of sel) {
    let score = 0;
    if (f.language) {
      if (f.language === doc.languageId) score = 10;
      else if (f.language === "*") score = 5;
      else continue;
    }
    if (f.scheme) {
      if (f.scheme === doc.uri.scheme) score = Math.max(score, 10);
      else if (f.scheme === "*") score = Math.max(score, 5);
      else continue;
    }
    if (f.pattern) {
      const rel = host.paths.toPath(doc.uri) ?? doc.uri.path;
      if (matchGlob(f.pattern, rel) || matchGlob(f.pattern, doc.uri.path.replace(/^\//, ""))) score = Math.max(score, 10);
      else continue;
    }
    if (!f.language && !f.scheme && !f.pattern) continue;
    best = Math.max(best, score);
  }
  return best;
}

/** `vscode.l10n.t`: "{0}" / "{name}" placeholders (TMCode ships no translations yet). */
function l10nT(...args: unknown[]): string {
  let message: string;
  let values: unknown[] | Record<string, unknown> = [];
  if (typeof args[0] === "string") {
    message = args[0];
    values = args.length === 2 && args[1] && typeof args[1] === "object" && !Array.isArray(args[1]) ? (args[1] as Record<string, unknown>) : args.slice(1);
  } else {
    const o = (args[0] ?? {}) as { message?: string; args?: unknown[] | Record<string, unknown> };
    message = String(o.message ?? "");
    values = o.args ?? [];
  }
  return message.replace(/\{([^}]+)\}/g, (m, key: string) => {
    const v = Array.isArray(values) ? values[Number(key)] : (values as Record<string, unknown>)[key];
    return v === undefined ? m : String(v);
  });
}

const { enums: _enums, ...moreClasses } = MT;
void _enums;

export function createApi(host: ExtHost, ext: ExtState) {
  const g = <O extends object>(name: string, ns: O) => guard(host, ext, name, ns);
  const rpc = host.rpc;
  const reg = (kind: Parameters<ExtHost["registerProvider"]>[1], selector: unknown, provider: unknown, meta?: Parameters<ExtHost["registerProvider"]>[4]) => host.registerProvider(ext, kind, selector, provider, meta);

  // ───────────── commands ─────────────
  const commands = g("commands", {
    registerCommand: (id: string, fn: AnyFn, thisArg?: unknown) => host.registerCommand(id, fn as (...a: unknown[]) => unknown, thisArg, ext),
    registerTextEditorCommand: (id: string, fn: (editor: unknown, edit: unknown, ...args: unknown[]) => unknown, thisArg?: unknown) =>
      host.registerCommand(
        id,
        async (...args: unknown[]) => {
          const editor = host.activeEditor();
          if (!editor) {
            host.log("warn", `Cannot execute '${id}' because there is no active text editor.`, ext.desc.id);
            return;
          }
          // Edits made on the builder while the callback runs are applied as one undo step.
          await editor.edit((b) => void fn.call(thisArg, editor, b, ...args));
        },
        undefined,
        ext,
      ),
    executeCommand: (id: string, ...args: unknown[]) => host.executeCommand(id, ...args),
    getCommands: async (filterInternal?: boolean) => {
      const remote = await rpc.request<string[]>("$main.getCommands", []).catch(() => [] as string[]);
      return filterInternal ? remote.filter((c) => !c.startsWith("_")) : remote;
    },
    registerDiffInformationCommand: () => {
      host.notSupported(ext, "commands.registerDiffInformationCommand", "warn");
      return noopDisposable();
    },
  });

  // ───────────── window ─────────────
  const windowState = { get focused() { return host.windowFocused; }, get active() { return host.windowFocused; } };
  const colorThemeKind = 2;
  const tabGroups = {
    all: [] as unknown[],
    activeTabGroup: { tabs: [] as unknown[], isActive: true, viewColumn: 1, activeTab: undefined },
    onDidChangeTabGroups: new EventEmitter<unknown>().event,
    onDidChangeTabs: new EventEmitter<unknown>().event,
    close: async () => false,
  };
  const createInputLike = (kind: "pick" | "input") => {
    // createQuickPick / createInputBox: the object API over the same widget.
    const onDidAccept = new EventEmitter<void>();
    const onDidHide = new EventEmitter<void>();
    const onDidChangeValue = new EventEmitter<string>();
    const onDidChangeSelection = new EventEmitter<unknown[]>();
    const onDidChangeActive = new EventEmitter<unknown[]>();
    const onDidTriggerButton = new EventEmitter<unknown>();
    const onDidTriggerItemButton = new EventEmitter<unknown>();
    const self: Record<string, unknown> = {
      title: undefined,
      placeholder: undefined,
      prompt: undefined,
      value: "",
      items: [] as unknown[],
      selectedItems: [] as unknown[],
      activeItems: [] as unknown[],
      canSelectMany: false,
      matchOnDescription: false,
      matchOnDetail: false,
      busy: false,
      enabled: true,
      ignoreFocusOut: false,
      password: false,
      validationMessage: undefined,
      buttons: [],
      step: undefined,
      totalSteps: undefined,
      keepScrollPosition: false,
      onDidAccept: onDidAccept.event,
      onDidHide: onDidHide.event,
      onDidChangeValue: onDidChangeValue.event,
      onDidChangeSelection: onDidChangeSelection.event,
      onDidChangeActive: onDidChangeActive.event,
      onDidTriggerButton: onDidTriggerButton.event,
      onDidTriggerItemButton: onDidTriggerItemButton.event,
      show: async () => {
        if (kind === "pick") {
          const picked = await host.showQuickPick(self.items, { title: self.title, placeHolder: self.placeholder, canPickMany: self.canSelectMany, matchOnDescription: self.matchOnDescription, matchOnDetail: self.matchOnDetail });
          if (picked === undefined) return onDidHide.fire();
          const sel = Array.isArray(picked) ? picked : [picked];
          self.selectedItems = sel;
          self.activeItems = sel;
          onDidChangeActive.fire(sel);
          onDidChangeSelection.fire(sel);
          onDidAccept.fire();
        } else {
          const v = await host.showInputBox({ title: self.title, prompt: self.prompt, placeHolder: self.placeholder, value: self.value, password: self.password });
          if (v === undefined) return onDidHide.fire();
          self.value = v;
          onDidChangeValue.fire(v);
          onDidAccept.fire();
        }
      },
      hide: () => onDidHide.fire(),
      dispose: () => {},
    };
    return self;
  };

  const window = g("window", {
    get activeTextEditor() {
      return host.activeEditor();
    },
    get visibleTextEditors() {
      return host.visibleEditors();
    },
    onDidChangeActiveTextEditor: host.onDidChangeActiveTextEditor.event,
    onDidChangeVisibleTextEditors: host.onDidChangeVisibleTextEditors.event,
    onDidChangeTextEditorSelection: host.onDidChangeTextEditorSelection.event,
    onDidChangeTextEditorVisibleRanges: host.onDidChangeTextEditorVisibleRanges.event,
    onDidChangeTextEditorOptions: host.onDidChangeTextEditorOptions.event,
    onDidChangeTextEditorViewColumn: new EventEmitter<unknown>().event,
    onDidChangeWindowState: host.onDidChangeWindowState.event,
    get state() {
      return windowState;
    },
    get activeColorTheme() {
      return { kind: colorThemeKind };
    },
    onDidChangeActiveColorTheme: new EventEmitter<unknown>().event,
    get terminals() {
      return [];
    },
    activeTerminal: undefined,
    onDidOpenTerminal: new EventEmitter<unknown>().event,
    onDidCloseTerminal: new EventEmitter<unknown>().event,
    onDidChangeActiveTerminal: new EventEmitter<unknown>().event,
    onDidChangeTerminalState: new EventEmitter<unknown>().event,
    activeNotebookEditor: undefined,
    visibleNotebookEditors: [],
    onDidChangeActiveNotebookEditor: new EventEmitter<unknown>().event,
    onDidChangeVisibleNotebookEditors: new EventEmitter<unknown>().event,
    tabGroups,
    showInformationMessage: (message: string, ...rest: unknown[]) => host.showMessage("info", message, rest),
    showWarningMessage: (message: string, ...rest: unknown[]) => host.showMessage("warning", message, rest),
    showErrorMessage: (message: string, ...rest: unknown[]) => host.showMessage("error", message, rest),
    showQuickPick: (items: unknown, options?: Record<string, unknown>, token?: CancellationToken) => host.showQuickPick(items, options, token),
    showInputBox: (options?: Record<string, unknown>) => host.showInputBox(options),
    createQuickPick: () => createInputLike("pick"),
    createInputBox: () => createInputLike("input"),
    showWorkspaceFolderPick: async () => (host.folder ? workspace.workspaceFolders?.[0] : undefined),
    createOutputChannel: (name: string, options?: string | { log?: boolean }) => host.createOutputChannel(ext, name, options),
    createStatusBarItem: (a?: string | number, b?: number, c?: number) => host.createStatusBarItem(ext, a, b, c),
    setStatusBarMessage: (text: string, hideAfterOrThenable?: number | Promise<unknown>) => {
      const item = host.createStatusBarItem(ext, `message${Math.random().toString(36).slice(2)}`, T.StatusBarAlignment.Left, -1000) as { text: string; show(): void; dispose(): void };
      item.text = text;
      item.show();
      if (typeof hideAfterOrThenable === "number") setTimeout(() => item.dispose(), hideAfterOrThenable);
      else if (hideAfterOrThenable && typeof (hideAfterOrThenable as Promise<unknown>).then === "function") void (hideAfterOrThenable as Promise<unknown>).finally(() => item.dispose());
      return new T.Disposable(() => item.dispose());
    },
    withProgress: (options: Parameters<ExtHost["withProgress"]>[0], task: Parameters<ExtHost["withProgress"]>[1]) => host.withProgress(options, task),
    withScmProgress: (task: Parameters<ExtHost["withProgress"]>[1]) => host.withProgress({ location: T.ProgressLocation.SourceControl }, task),
    createTextEditorDecorationType: (options: Record<string, unknown>) => host.createDecorationType(options),
    showTextDocument: async (docOrUri: unknown, columnOrOptions?: unknown, preserveFocus?: boolean) => {
      const uri = Uri.isUri(docOrUri) ? docOrUri : (docOrUri as { uri: Uri })?.uri;
      if (!uri) throw new Error("showTextDocument: a document or Uri is required");
      const path = host.paths.toPath(uri);
      if (path === null) throw new Error(`TMCode can only show files of the open folder (${uri.toString(true)}).`);
      const opts = (typeof columnOrOptions === "object" && columnOrOptions ? columnOrOptions : {}) as { preserveFocus?: boolean; preview?: boolean; selection?: T.Range; viewColumn?: number };
      const id = await rpc.request<string | null>("$main.showTextDocument", [path, { preserveFocus: opts.preserveFocus ?? preserveFocus, preview: opts.preview, selection: opts.selection ? C.range.from(opts.selection) : undefined }]);
      const ed = host.visibleEditors().find((e) => e.id === id) ?? host.visibleEditors().find((e) => e.path === path);
      if (!ed) throw new Error(`Could not open ${path}`);
      return ed;
    },
    showNotebookDocument: () => host.notSupported(ext, "window.showNotebookDocument"),
    createTreeView: (viewId: string, options: Record<string, unknown>) => host.views.createTreeView(ext, viewId, options),
    registerTreeDataProvider: (viewId: string, provider: unknown) => host.views.registerTreeDataProvider(ext, viewId, provider),
    registerWebviewViewProvider: (viewId: string, provider: unknown, options?: { webviewOptions?: { retainContextWhenHidden?: boolean } }) => host.views.registerWebviewViewProvider(ext, viewId, provider, options),
    createWebviewPanel: (viewType: string, title: string, showOptions: unknown, options?: Record<string, unknown>) => host.views.createWebviewPanel(ext, viewType, title, showOptions, options),
    registerUriHandler: () => noopDisposable(),
    registerFileDecorationProvider: () => noopDisposable(),
    registerTerminalLinkProvider: () => noopDisposable(),
    registerTerminalProfileProvider: () => noopDisposable(),
    registerCustomEditorProvider: (viewType: string) => {
      host.notSupported(ext, `window.registerCustomEditorProvider (${viewType})`, "warn");
      return noopDisposable();
    },
    registerWebviewPanelSerializer: () => noopDisposable(),
  });

  // ───────────── workspace ─────────────
  const fs = {
    stat: (uri: Uri) => host.fs.stat(uri),
    readDirectory: (uri: Uri) => host.fs.readDirectory(uri),
    createDirectory: (uri: Uri) => host.fs.createDirectory(uri),
    readFile: (uri: Uri) => host.fs.readFile(uri),
    writeFile: (uri: Uri, content: Uint8Array) => host.fs.writeFile(uri, content),
    delete: (uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }) => host.fs.delete(uri, options),
    rename: (source: Uri, target: Uri, options?: { overwrite?: boolean }) => host.fs.rename(source, target, options),
    copy: (source: Uri, target: Uri, options?: { overwrite?: boolean }) => host.fs.copy(source, target, options),
    isWritableFileSystem: (scheme: string) => (scheme === "file" ? true : undefined),
  };
  const folderObj = () => (host.folder ? { uri: host.folder, name: host.data.workspace?.name ?? "", index: 0 } : undefined);
  const getConfiguration = (section?: string, scope?: unknown) => {
    let languageId: string | undefined;
    if (scope && typeof scope === "object") {
      const s = scope as { languageId?: string; uri?: Uri; scheme?: string; path?: string };
      if (typeof s.languageId === "string") languageId = s.languageId;
      else if (Uri.isUri(s)) {
        const p = host.paths.toPath(s);
        languageId = p !== null ? host.documentFor(p)?.languageId : undefined;
      } else if (s.uri && Uri.isUri(s.uri)) {
        const p = host.paths.toPath(s.uri);
        languageId = p !== null ? host.documentFor(p)?.languageId : undefined;
      }
    }
    const value = host.config.getValue(section || undefined, languageId);
    const base = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const lookup = (key: string) => {
      let node: unknown = base;
      for (const p of key.split(".")) {
        if (!node || typeof node !== "object") return undefined;
        node = (node as Record<string, unknown>)[p];
      }
      return node;
    };
    const full = (key: string) => (section ? `${section}.${key}` : key);
    const cfg: Record<string, unknown> = {
      ...base,
      get: (key: string, defaultValue?: unknown) => {
        const v = lookup(key);
        return v === undefined ? defaultValue : v;
      },
      has: (key: string) => lookup(key) !== undefined,
      inspect: (key: string) => host.config.inspect(full(key), languageId),
      update: async (key: string, value: unknown, _target?: unknown, overrideInLanguage?: boolean) => {
        await rpc.request("$main.updateConfiguration", [full(key), value === undefined ? null : value, overrideInLanguage && languageId ? languageId : null]);
      },
    };
    return Object.freeze(cfg);
  };

  const workspace = g("workspace", {
    get rootPath() {
      return host.folder?.fsPath;
    },
    get workspaceFolders() {
      const f = folderObj();
      return f ? [f] : undefined;
    },
    get name() {
      return host.data.workspace?.name;
    },
    workspaceFile: undefined,
    isTrusted: true,
    onDidGrantWorkspaceTrust: new EventEmitter<void>().event,
    getWorkspaceFolder: (uri: Uri) => (host.paths.toPath(uri) !== null ? folderObj() : undefined),
    asRelativePath: (pathOrUri: string | Uri, includeWorkspaceFolder?: boolean) => {
      const uri = typeof pathOrUri === "string" ? (pathOrUri.includes("://") ? Uri.parse(pathOrUri) : Uri.file(pathOrUri)) : pathOrUri;
      const rel = host.paths.toPath(uri);
      if (rel === null) return typeof pathOrUri === "string" ? pathOrUri : uri.fsPath;
      return includeWorkspaceFolder && host.data.workspace ? `${host.data.workspace.name}/${rel}` : rel;
    },
    get textDocuments() {
      return host.allDocuments();
    },
    openTextDocument: (arg?: Uri | string | { language?: string; content?: string }) => host.openTextDocument(arg),
    onDidOpenTextDocument: host.onDidOpenTextDocument.event,
    onDidCloseTextDocument: host.onDidCloseTextDocument.event,
    onDidChangeTextDocument: host.onDidChangeTextDocument.event,
    onDidSaveTextDocument: host.onDidSaveTextDocument.event,
    onWillSaveTextDocument: host.onWillSaveTextDocument.event,
    onDidChangeConfiguration: host.onDidChangeConfiguration.event,
    onDidChangeWorkspaceFolders: new EventEmitter<unknown>().event,
    onDidCreateFiles: host.onDidCreateFiles.event,
    onDidDeleteFiles: host.onDidDeleteFiles.event,
    onDidRenameFiles: host.onDidRenameFiles.event,
    onWillCreateFiles: new EventEmitter<unknown>().event,
    onWillDeleteFiles: new EventEmitter<unknown>().event,
    onWillRenameFiles: new EventEmitter<unknown>().event,
    notebookDocuments: [],
    onDidOpenNotebookDocument: new EventEmitter<unknown>().event,
    onDidCloseNotebookDocument: new EventEmitter<unknown>().event,
    onDidChangeNotebookDocument: new EventEmitter<unknown>().event,
    onDidSaveNotebookDocument: new EventEmitter<unknown>().event,
    getConfiguration,
    applyEdit: async (edit: T.WorkspaceEdit) => {
      const dto = C.workspaceEdit(edit, host.paths);
      const total = edit._allEntries?.().length ?? 0;
      if (dto.entries.length < total) host.log("warn", `applyEdit: ${total - dto.entries.length} change(s) outside the open folder were skipped`, ext.desc.id);
      return rpc.request<boolean>("$main.applyEdit", [dto]);
    },
    findFiles: (include: string | T.RelativePattern, exclude?: string | T.RelativePattern | null, maxResults?: number, token?: CancellationToken) => host.findFiles(include, exclude, maxResults, token),
    saveAll: (includeUntitled?: boolean) => rpc.request<boolean>("$main.executeCommand", ["workbench.action.files.saveAll", [includeUntitled]]).then(() => true),
    save: async (uri: Uri) => {
      const p = host.paths.toPath(uri);
      return p !== null && (await rpc.request<boolean>("$main.saveDocument", [p])) ? uri : undefined;
    },
    fs,
    createFileSystemWatcher: (globPattern: string | T.RelativePattern, ignoreCreate?: boolean, ignoreChange?: boolean, ignoreDelete?: boolean) => {
      const onCreate = new EventEmitter<Uri>();
      const onChange = new EventEmitter<Uri>();
      const onDelete = new EventEmitter<Uri>();
      let glob: string;
      let base: string | undefined;
      if (typeof globPattern === "string") glob = globPattern;
      else {
        glob = globPattern.pattern;
        base = host.paths.toPath(globPattern.baseUri) ?? undefined;
        if (base === undefined) glob = "\0never";
      }
      const un = host.addFileWatcher({
        glob,
        base,
        fire: (type, uri) => {
          if (type === "create" && !ignoreCreate) onCreate.fire(uri);
          else if (type === "change" && !ignoreChange) onChange.fire(uri);
          else if (type === "delete" && !ignoreDelete) onDelete.fire(uri);
        },
      });
      return {
        ignoreCreateEvents: !!ignoreCreate,
        ignoreChangeEvents: !!ignoreChange,
        ignoreDeleteEvents: !!ignoreDelete,
        onDidCreate: onCreate.event,
        onDidChange: onChange.event,
        onDidDelete: onDelete.event,
        dispose: () => un(),
      };
    },
    registerTextDocumentContentProvider: (scheme: string) => {
      host.notSupported(ext, `workspace.registerTextDocumentContentProvider (${scheme})`, "warn");
      return noopDisposable();
    },
    registerFileSystemProvider: (scheme: string) => {
      host.notSupported(ext, `workspace.registerFileSystemProvider (${scheme})`, "warn");
      return noopDisposable();
    },
    registerTaskProvider: () => noopDisposable(),
    updateWorkspaceFolders: () => false,
  });

  // ───────────── languages ─────────────
  const languages = g("languages", {
    getLanguages: async () => host.languages,
    setTextDocumentLanguage: async (document: { uri: Uri }, languageId: string) => {
      const p = host.paths.toPath(document.uri);
      if (p === null) throw new Error("setTextDocumentLanguage: the document is not in the open folder");
      await rpc.request("$main.setTextDocumentLanguage", [p, languageId]);
      return host.documentFor(p)?.document ?? document;
    },
    match: (selector: unknown, document: { languageId: string; uri: Uri }) => isSelectorMatch(C.selector(selector), document, host),
    createDiagnosticCollection: (name?: string) => host.createDiagnosticCollection(ext, name),
    getDiagnostics: (uri?: Uri) => host.getDiagnostics(uri),
    onDidChangeDiagnostics: host.onDidChangeDiagnostics.event,
    registerCompletionItemProvider: (selector: unknown, provider: unknown, ...triggerCharacters: string[]) => reg("completion", selector, provider, { triggerCharacters: triggerCharacters.filter((c) => typeof c === "string") }),
    registerHoverProvider: (selector: unknown, provider: unknown) => reg("hover", selector, provider),
    registerDefinitionProvider: (selector: unknown, provider: unknown) => reg("definition", selector, provider),
    registerDeclarationProvider: (selector: unknown, provider: unknown) => reg("declaration", selector, provider),
    registerTypeDefinitionProvider: (selector: unknown, provider: unknown) => reg("typeDefinition", selector, provider),
    registerImplementationProvider: (selector: unknown, provider: unknown) => reg("implementation", selector, provider),
    registerReferenceProvider: (selector: unknown, provider: unknown) => reg("references", selector, provider),
    registerDocumentSymbolProvider: (selector: unknown, provider: unknown, metadata?: { label?: string }) => reg("documentSymbol", selector, provider, { displayName: metadata?.label }),
    registerCodeActionsProvider: (selector: unknown, provider: unknown, metadata?: { providedCodeActionKinds?: T.CodeActionKind[] }) =>
      reg("codeAction", selector, provider, { providedCodeActionKinds: metadata?.providedCodeActionKinds?.map((k) => k.value) }),
    registerDocumentFormattingEditProvider: (selector: unknown, provider: unknown) => reg("formatting", selector, provider, { displayName: ext.desc.displayName }),
    registerDocumentRangeFormattingEditProvider: (selector: unknown, provider: unknown) => reg("rangeFormatting", selector, provider, { displayName: ext.desc.displayName }),
    registerOnTypeFormattingEditProvider: (selector: unknown, provider: unknown, first: string, ...more: string[]) => reg("onTypeFormatting", selector, provider, { moreTriggerCharacters: [first, ...more] }),
    registerColorProvider: (selector: unknown, provider: unknown) => reg("color", selector, provider),
    registerDocumentHighlightProvider: (selector: unknown, provider: unknown) => reg("documentHighlight", selector, provider),
    registerDocumentLinkProvider: (selector: unknown, provider: unknown) => reg("documentLink", selector, provider),
    registerFoldingRangeProvider: (selector: unknown, provider: unknown) => reg("foldingRange", selector, provider),
    registerSignatureHelpProvider: (selector: unknown, provider: unknown, first?: string | { triggerCharacters?: string[]; retriggerCharacters?: string[] }, ...rest: string[]) => {
      const meta = typeof first === "object" && first ? { triggerCharacters: first.triggerCharacters ?? [], retriggerCharacters: first.retriggerCharacters ?? [] } : { triggerCharacters: [first, ...rest].filter((x): x is string => typeof x === "string") };
      return reg("signatureHelp", selector, provider, meta);
    },
    registerRenameProvider: (selector: unknown, provider: unknown) => reg("rename", selector, provider),
    registerInlayHintsProvider: (selector: unknown, provider: unknown) => reg("inlayHints", selector, provider),
    registerCodeLensProvider: (selector: unknown, provider: unknown) => reg("codeLens", selector, provider, { resolve: typeof (provider as { resolveCodeLens?: unknown })?.resolveCodeLens === "function" }),
    registerLinkedEditingRangeProvider: (selector: unknown, provider: unknown) => reg("linkedEditing", selector, provider),
    registerSelectionRangeProvider: (selector: unknown, provider: unknown) => reg("selectionRange", selector, provider),
    setLanguageConfiguration: (language: string, configuration: Record<string, unknown>) => {
      const re = (r: unknown) => (r instanceof RegExp ? { source: r.source, flags: r.flags } : undefined);
      const cfg = configuration ?? {};
      const ir = cfg.indentationRules as Record<string, unknown> | undefined;
      const dto = {
        comments: cfg.comments,
        brackets: cfg.brackets,
        wordPattern: re(cfg.wordPattern),
        indentationRules: ir ? { increaseIndentPattern: re(ir.increaseIndentPattern), decreaseIndentPattern: re(ir.decreaseIndentPattern), indentNextLinePattern: re(ir.indentNextLinePattern), unIndentedLinePattern: re(ir.unIndentedLinePattern) } : undefined,
        onEnterRules: Array.isArray(cfg.onEnterRules)
          ? (cfg.onEnterRules as Record<string, unknown>[]).map((r) => ({ beforeText: re(r.beforeText), afterText: re(r.afterText), previousLineText: re(r.previousLineText), action: r.action }))
          : undefined,
        autoClosingPairs: cfg.autoClosingPairs,
        surroundingPairs: cfg.surroundingPairs,
      };
      const id = Math.random().toString(36).slice(2);
      rpc.notify("$main.languageConfiguration", ["set", id, language, dto]);
      return new T.Disposable(() => rpc.notify("$main.languageConfiguration", ["dispose", id]));
    },
    createLanguageStatusItem: (id: string, selector: unknown) => {
      const item = host.createStatusBarItem(ext, `lang.${id}`, T.StatusBarAlignment.Right, 100, C.selector(selector)) as Record<string, unknown>;
      item.selector = selector;
      return item;
    },
    registerDocumentSemanticTokensProvider: () => noopDisposable(),
    registerDocumentRangeSemanticTokensProvider: () => noopDisposable(),
    registerEvaluatableExpressionProvider: () => noopDisposable(),
    registerInlineValuesProvider: () => noopDisposable(),
    registerCallHierarchyProvider: () => noopDisposable(),
    registerTypeHierarchyProvider: () => noopDisposable(),
    registerWorkspaceSymbolProvider: () => noopDisposable(),
    registerDocumentDropEditProvider: () => noopDisposable(),
    registerDocumentPasteEditProvider: () => noopDisposable(),
    registerInlineCompletionItemProvider: () => noopDisposable(),
  });

  // ───────────── env ─────────────
  const e = host.data.env;
  const env = g("env", {
    appName: e.appName,
    appRoot: e.appRoot,
    appHost: e.appHost,
    language: e.language,
    machineId: e.machineId,
    sessionId: e.sessionId,
    uriScheme: "tmcode",
    uiKind: e.uiKind,
    shell: e.shell,
    remoteName: undefined,
    remoteAuthority: undefined,
    isNewAppInstall: false,
    isTelemetryEnabled: false,
    onDidChangeTelemetryEnabled: new EventEmitter<boolean>().event,
    onDidChangeShell: new EventEmitter<string>().event,
    logLevel: T.LogLevel.Info,
    onDidChangeLogLevel: new EventEmitter<number>().event,
    clipboard: {
      readText: () => rpc.request<string>("$main.clipboard", ["read"]).then((t) => t ?? ""),
      writeText: (text: string) => rpc.request("$main.clipboard", ["write", String(text)]).then(() => undefined),
    },
    openExternal: (uri: Uri) => rpc.request<boolean>("$main.openExternal", [Uri.isUri(uri) ? uri.toString(true) : String(uri)]),
    asExternalUri: async (uri: Uri) => uri,
    createTelemetryLogger: () => ({ logUsage() {}, logError() {}, dispose() {}, onDidChangeEnableStates: new EventEmitter<unknown>().event, isUsageEnabled: false, isErrorsEnabled: false }),
  });

  // ───────────── extensions ─────────────
  const extensions = g("extensions", {
    getExtension: (id: string) => {
      const x = host.exts.get(String(id).toLowerCase());
      return x ? host.extensionObject(x) : undefined;
    },
    get all() {
      return [...host.exts.values()].map((x) => host.extensionObject(x));
    },
    get allAcrossExtensionHosts() {
      return [...host.exts.values()].map((x) => host.extensionObject(x));
    },
    onDidChange: host.onDidChangeExtensions.event,
  });

  const l10n = {
    t: l10nT,
    bundle: undefined,
    uri: undefined,
  };

  // Namespaces TMCode does not provide yet: every member reports itself.
  const empty = (name: string) => g(name, {});
  const debug = g("debug", {
    activeDebugSession: undefined,
    activeDebugConsole: { append() {}, appendLine() {} },
    breakpoints: [],
    onDidStartDebugSession: new EventEmitter<unknown>().event,
    onDidTerminateDebugSession: new EventEmitter<unknown>().event,
    onDidChangeActiveDebugSession: new EventEmitter<unknown>().event,
    onDidChangeBreakpoints: new EventEmitter<unknown>().event,
    onDidReceiveDebugSessionCustomEvent: new EventEmitter<unknown>().event,
  });
  const tasks = g("tasks", { taskExecutions: [], onDidStartTask: new EventEmitter<unknown>().event, onDidEndTask: new EventEmitter<unknown>().event, onDidStartTaskProcess: new EventEmitter<unknown>().event, onDidEndTaskProcess: new EventEmitter<unknown>().event });

  const api: Record<string, unknown> = {
    version: API_VERSION,
    commands,
    window,
    workspace,
    languages,
    env,
    extensions,
    l10n,
    debug,
    tasks,
    scm: empty("scm"),
    tests: empty("tests"),
    notebooks: empty("notebooks"),
    authentication: g("authentication", { onDidChangeSessions: new EventEmitter<unknown>().event }),
    comments: empty("comments"),
    chat: empty("chat"),
    lm: empty("lm"),
    // classes & enums
    Uri,
    Position: T.Position,
    Range: T.Range,
    Selection: T.Selection,
    Location: T.Location,
    Disposable: T.Disposable,
    EventEmitter,
    CancellationTokenSource,
    CancellationError: T.CancellationError,
    TextEdit: T.TextEdit,
    SnippetTextEdit: T.SnippetTextEdit,
    WorkspaceEdit: T.WorkspaceEdit,
    SnippetString: T.SnippetString,
    MarkdownString: T.MarkdownString,
    Diagnostic: T.Diagnostic,
    DiagnosticSeverity: T.DiagnosticSeverity,
    DiagnosticTag: T.DiagnosticTag,
    DiagnosticRelatedInformation: T.DiagnosticRelatedInformation,
    Hover: T.Hover,
    CompletionItem: T.CompletionItem,
    CompletionItemKind: T.CompletionItemKind,
    CompletionItemTag: T.CompletionItemTag,
    CompletionList: T.CompletionList,
    CompletionTriggerKind: T.CompletionTriggerKind,
    CodeAction: T.CodeAction,
    CodeActionKind: T.CodeActionKind,
    CodeActionTriggerKind: T.CodeActionTriggerKind,
    CodeLens: T.CodeLens,
    SymbolKind: T.SymbolKind,
    SymbolTag: T.SymbolTag,
    SymbolInformation: T.SymbolInformation,
    DocumentSymbol: T.DocumentSymbol,
    Color: T.Color,
    ColorInformation: T.ColorInformation,
    ColorPresentation: T.ColorPresentation,
    DocumentLink: T.DocumentLink,
    DocumentHighlight: T.DocumentHighlight,
    DocumentHighlightKind: T.DocumentHighlightKind,
    FoldingRange: T.FoldingRange,
    FoldingRangeKind: T.FoldingRangeKind,
    ParameterInformation: T.ParameterInformation,
    SignatureInformation: T.SignatureInformation,
    SignatureHelp: T.SignatureHelp,
    SignatureHelpTriggerKind: T.SignatureHelpTriggerKind,
    SelectionRange: T.SelectionRange,
    InlayHint: T.InlayHint,
    InlayHintKind: T.InlayHintKind,
    LinkedEditingRanges: T.LinkedEditingRanges,
    InlineCompletionItem: T.InlineCompletionItem,
    SemanticTokens: T.SemanticTokens,
    SemanticTokensLegend: T.SemanticTokensLegend,
    SemanticTokensBuilder: T.SemanticTokensBuilder,
    ThemeColor: T.ThemeColor,
    ThemeIcon: T.ThemeIcon,
    StatusBarAlignment: T.StatusBarAlignment,
    ProgressLocation: T.ProgressLocation,
    EndOfLine: T.EndOfLine,
    ViewColumn: T.ViewColumn,
    TextEditorRevealType: T.TextEditorRevealType,
    TextEditorSelectionChangeKind: T.TextEditorSelectionChangeKind,
    TextEditorLineNumbersStyle: T.TextEditorLineNumbersStyle,
    TextEditorCursorStyle: T.TextEditorCursorStyle,
    OverviewRulerLane: T.OverviewRulerLane,
    DecorationRangeBehavior: T.DecorationRangeBehavior,
    ConfigurationTarget: T.ConfigurationTarget,
    TextDocumentSaveReason: T.TextDocumentSaveReason,
    TextDocumentChangeReason: T.TextDocumentChangeReason,
    FileType: T.FileType,
    FilePermission: T.FilePermission,
    FileSystemError: T.FileSystemError,
    ExtensionMode: T.ExtensionMode,
    ExtensionKind: T.ExtensionKind,
    UIKind: T.UIKind,
    LogLevel: T.LogLevel,
    QuickPickItemKind: T.QuickPickItemKind,
    IndentAction: T.IndentAction,
    LanguageStatusSeverity: T.LanguageStatusSeverity,
    TreeItem: T.TreeItem,
    TreeItemCollapsibleState: T.TreeItemCollapsibleState,
    RelativePattern: T.RelativePattern,
    TabInputText: T.TabInputText,
    EnvironmentVariableMutatorType: T.EnvironmentVariableMutatorType,
    // Classes and enums libraries need to exist (vscode-languageclient subclasses several).
    ...moreClasses,
    ...MT.enums,
  };
  return guard(host, ext, "", api);
}

export type { SelectorDTO };
