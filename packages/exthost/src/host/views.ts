/**
 * The host side of extension UI contributions ("ExtHostTreeViews" and
 * "ExtHostWebviews" in VS Code):
 * - tree views: `window.registerTreeDataProvider` / `createTreeView`. The
 *   host keeps the extension's elements and gives the workbench handles; the
 *   workbench asks for children lazily ($treeChildren) and reports
 *   visibility, selection, expansion and checkboxes back. Handles of a
 *   parent's old children are released whenever that parent is fetched again.
 * - webviews: `window.createWebviewPanel` (an editor tab) and
 *   `registerWebviewViewProvider` (a side bar view). The host keeps the html
 *   and options, the workbench renders them in a sandboxed iframe and relays
 *   postMessage both ways.
 */

import * as T from "../api/types";
import { Uri } from "../api/uri";
import { CancellationTokenSource, EventEmitter } from "../api/events";
import * as C from "./convert";
import type { ExtHost, ExtState } from "./extHost";
import type { IconDTO, ResourceRefDTO, TreeItemDTO, TreeViewOptionsDTO, ViewMetaDTO, WebviewCreateDTO, WebviewOptionsDTO } from "../protocol";

type Provider = {
  getChildren(element?: unknown): unknown;
  getTreeItem(element: unknown): unknown;
  getParent?(element: unknown): unknown;
  resolveTreeItem?(item: unknown, element: unknown, token: unknown): unknown;
  onDidChangeTreeData?: (listener: (e: unknown) => void) => { dispose(): unknown };
};

interface Node {
  handle: string;
  element: unknown;
  parent: Node | null;
  item: T.TreeItem;
  children: Node[] | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

// ───────────── webview messages: binary data over JSON ─────────────
// postMessage carries ArrayBuffers and typed arrays (GitLens sends its RPC as
// Uint8Array). The RPC is JSON, so they travel as {$$tmbuf: base64, t: type};
// the webview prelude converts them back (and the page's own the same way).

const TYPED: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Uint8Array, Int8Array, Uint8ClampedArray, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView,
} as unknown as Record<string, new (b: ArrayBuffer) => ArrayBufferView>;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

export function encodeWebviewMessage(v: unknown, depth = 0): unknown {
  if (v instanceof ArrayBuffer) return { $$tmbuf: toBase64(new Uint8Array(v)), t: "ArrayBuffer" };
  if (ArrayBuffer.isView(v)) return { $$tmbuf: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), t: v.constructor.name };
  if (depth > 64 || !v || typeof v !== "object" || typeof (v as { toJSON?: unknown }).toJSON === "function") return v;
  if (Array.isArray(v)) return v.map((x) => encodeWebviewMessage(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = encodeWebviewMessage(x, depth + 1);
  return out;
}

export function decodeWebviewMessage(v: unknown, depth = 0): unknown {
  if (depth > 64 || !v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => decodeWebviewMessage(x, depth + 1));
  const o = v as Record<string, unknown>;
  if (typeof o.$$tmbuf === "string" && typeof o.t === "string") {
    const buf = fromBase64(o.$$tmbuf);
    if (o.t === "ArrayBuffer") return buf;
    const Ctor = TYPED[o.t] ?? Uint8Array;
    return new Ctor(buf);
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = decodeWebviewMessage(x, depth + 1);
  return out;
}

function errorText(e: unknown): string {
  return String((e as Error)?.stack || (e as Error)?.message || e);
}

// ───────────────────────── tree views ─────────────────────────

class TreeViewImpl {
  readonly #nodes = new Map<string, Node>();
  readonly #byElement = new Map<unknown, Node>();
  #roots: Node[] | null = null;
  #visible = false;
  #selection: unknown[] = [];
  readonly #meta: ViewMetaDTO = {};
  readonly #changeSub?: { dispose(): unknown };
  #pending: Set<unknown> | "all" | null = null;
  #disposed = false;
  readonly onDidExpandElement = new EventEmitter<{ element: unknown }>();
  readonly onDidCollapseElement = new EventEmitter<{ element: unknown }>();
  readonly onDidChangeSelection = new EventEmitter<{ selection: readonly unknown[] }>();
  readonly onDidChangeVisibility = new EventEmitter<{ visible: boolean }>();
  readonly onDidChangeCheckboxState = new EventEmitter<{ items: readonly [unknown, number][] }>();
  readonly api: Record<string, unknown>;

  constructor(
    readonly id: string,
    readonly ext: ExtState,
    readonly provider: Provider,
    readonly options: TreeViewOptionsDTO,
    private readonly views: ViewsHost,
  ) {
    if (typeof provider.onDidChangeTreeData === "function") {
      this.#changeSub = provider.onDidChangeTreeData((e) => this.#onChange(e));
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const meta = (key: keyof ViewMetaDTO) => ({
      get: () => self.#meta[key] ?? undefined,
      set: (v: unknown) => {
        if (key === "badge") self.#meta.badge = isObj(v) && typeof v.value === "number" ? { value: v.value, tooltip: typeof v.tooltip === "string" ? v.tooltip : undefined } : null;
        else if (key === "message") self.#meta.message = T.MarkdownString.isMarkdownString(v) ? v.value : typeof v === "string" ? v : "";
        else (self.#meta as Record<string, unknown>)[key] = typeof v === "string" ? v : undefined;
        self.views.notifyTree("update", self.id, { [key]: (self.#meta as Record<string, unknown>)[key] ?? (key === "badge" ? null : "") });
      },
      enumerable: true,
    });
    this.api = Object.defineProperties(
      {
        onDidExpandElement: this.onDidExpandElement.event,
        onDidCollapseElement: this.onDidCollapseElement.event,
        onDidChangeSelection: this.onDidChangeSelection.event,
        onDidChangeVisibility: this.onDidChangeVisibility.event,
        onDidChangeCheckboxState: this.onDidChangeCheckboxState.event,
        reveal: (element: unknown, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }) => this.reveal(element, options),
        dispose: () => this.dispose(),
      },
      {
        visible: { get: () => this.#visible, enumerable: true },
        selection: { get: () => [...this.#selection], enumerable: true },
        activeItem: { get: () => this.#selection[0], enumerable: true },
        title: meta("title"),
        description: meta("description"),
        message: meta("message"),
        badge: meta("badge"),
      },
    );
  }

  // ── changes ──

  #onChange(e: unknown) {
    if (this.#disposed) return;
    if (e === undefined || e === null) this.#pending = "all";
    else if (this.#pending !== "all") {
      this.#pending ??= new Set();
      for (const el of Array.isArray(e) ? e : [e]) this.#pending.add(el);
    }
    this.views.schedule(this);
  }

  /** Sends the batched onDidChangeTreeData events. */
  async flush() {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending || this.#disposed) return;
    if (pending === "all") {
      this.views.notifyTree("refresh", this.id, null);
      return;
    }
    const items: TreeItemDTO[] = [];
    for (const el of pending) {
      const node = this.#byElement.get(el);
      if (!node) continue;
      try {
        node.item = await this.#treeItem(el);
        items.push(this.#dto(node));
      } catch (err) {
        this.views.host.log("warn", `${this.id}: getTreeItem failed: ${errorText(err)}`, this.ext.desc.id);
      }
    }
    if (items.length) this.views.notifyTree("refresh", this.id, { items });
  }

  // ── children ──

  async #treeItem(element: unknown): Promise<T.TreeItem> {
    const item = (await this.provider.getTreeItem(element)) as T.TreeItem;
    if (!item || typeof item !== "object") throw new Error("getTreeItem returned no TreeItem");
    return item;
  }

  #release(node: Node) {
    for (const c of node.children ?? []) this.#release(c);
    node.children = null;
    if (this.#nodes.get(node.handle) === node) this.#nodes.delete(node.handle);
    if (this.#byElement.get(node.element) === node) this.#byElement.delete(node.element);
  }

  async children(parentHandle: string | null): Promise<TreeItemDTO[]> {
    const parent = parentHandle === null ? null : (this.#nodes.get(parentHandle) ?? undefined);
    if (parent === undefined) return [];
    if (typeof this.provider.getChildren !== "function") return [];
    const elements = ((await this.provider.getChildren(parent?.element)) ?? []) as unknown[];
    const list = Array.isArray(elements) ? elements : [];
    const items = await Promise.all(list.map((el) => this.#treeItem(el).catch((e) => (this.views.host.log("warn", `${this.id}: getTreeItem failed: ${errorText(e)}`, this.ext.desc.id), null))));
    // The parent's previous children (and their subtrees) are released.
    for (const old of (parent ? parent.children : this.#roots) ?? []) this.#release(old);
    const nodes: Node[] = [];
    const seen = new Set<string>();
    list.forEach((element, i) => {
      const item = items[i];
      if (!item) return;
      let handle = this.#handleFor(item, parent, i);
      while (seen.has(handle)) handle += "'";
      seen.add(handle);
      const node: Node = { handle, element, parent, item, children: null };
      nodes.push(node);
      this.#nodes.set(handle, node);
      this.#byElement.set(element, node);
    });
    if (parent) parent.children = nodes;
    else this.#roots = nodes;
    return nodes.map((n) => this.#dto(n));
  }

  #handleFor(item: T.TreeItem, parent: Node | null, index: number): string {
    if (typeof item.id === "string" && item.id) return `1/${item.id}`;
    const label = labelOf(item) || item.resourceUri?.path || "";
    return `0/${parent?.handle ?? ""}/${index}:${label}`;
  }

  #dto(node: Node): TreeItemDTO {
    const item = node.item as T.TreeItem & { checkboxState?: unknown; accessibilityInformation?: unknown };
    const v = this.views;
    const label = item.label;
    const dto: TreeItemDTO = { handle: node.handle, label: labelOf(item), collapsible: (item.collapsibleState ?? 0) as 0 | 1 | 2 };
    if (isObj(label) && Array.isArray((label as { highlights?: unknown }).highlights)) {
      dto.highlights = ((label as unknown as { highlights: unknown[] }).highlights.filter((h) => Array.isArray(h) && h.length === 2) as [number, number][]).map(([a, b]) => [a, b]);
    }
    if (item.resourceUri && Uri.isUri(item.resourceUri)) {
      const path = v.host.paths.toPath(item.resourceUri);
      const name = item.resourceUri.path.split("/").filter(Boolean).pop() ?? "";
      dto.resource = { path, name, folder: item.iconPath === T.ThemeIcon.Folder || (item.iconPath instanceof T.ThemeIcon && item.iconPath.id === "folder") || (item.collapsibleState ?? 0) > 0 };
      if (!dto.label) dto.label = name;
      if (item.description === true) dto.description = path !== null ? path.split("/").slice(0, -1).join("/") : item.resourceUri.fsPath;
    }
    if (typeof item.description === "string") dto.description = item.description;
    if (typeof item.tooltip === "string") dto.tooltip = item.tooltip;
    else if (item.tooltip) dto.tooltip = C.markdown(item.tooltip);
    else if (typeof this.provider.resolveTreeItem === "function") dto.resolvable = true;
    const icon = v.icon(item.iconPath, this.ext);
    // ThemeIcon.File / Folder with a resourceUri: the file icon theme decides.
    if (icon && !(dto.resource && "codicon" in icon && (icon.codicon === "file" || icon.codicon === "folder"))) dto.icon = icon;
    if (item.command && typeof item.command.command === "string") dto.command = { title: item.command.title ?? "", tooltip: item.command.tooltip };
    if (typeof item.contextValue === "string") dto.contextValue = item.contextValue;
    const cb = item.checkboxState;
    if (cb !== undefined && cb !== null) {
      const state = typeof cb === "number" ? cb : isObj(cb) ? Number(cb.state) : 0;
      dto.checkbox = { checked: state === 1, tooltip: isObj(cb) && typeof cb.tooltip === "string" ? cb.tooltip : undefined };
    }
    return dto;
  }

  // ── workbench events ──

  async resolve(handle: string): Promise<{ tooltip?: string | ReturnType<typeof C.markdown> } | null> {
    const node = this.#nodes.get(handle);
    if (!node || typeof this.provider.resolveTreeItem !== "function") return null;
    const src = new CancellationTokenSource();
    const item = ((await this.provider.resolveTreeItem(node.item, node.element, src.token)) as T.TreeItem | undefined) ?? node.item;
    node.item = item;
    const tooltip = item.tooltip;
    return { tooltip: typeof tooltip === "string" ? tooltip : tooltip ? C.markdown(tooltip) : undefined };
  }

  setVisible(visible: boolean) {
    if (this.#visible === visible) return;
    this.#visible = visible;
    this.onDidChangeVisibility.fire({ visible });
  }

  setSelection(handles: string[]) {
    this.#selection = handles.map((h) => this.#nodes.get(h)?.element).filter((e) => e !== undefined);
    this.onDidChangeSelection.fire({ selection: [...this.#selection] });
  }

  setExpanded(handle: string, expanded: boolean) {
    const node = this.#nodes.get(handle);
    if (!node) return;
    node.item.collapsibleState = expanded ? T.TreeItemCollapsibleState.Expanded : T.TreeItemCollapsibleState.Collapsed;
    (expanded ? this.onDidExpandElement : this.onDidCollapseElement).fire({ element: node.element });
  }

  setCheckboxes(changes: [string, boolean][]) {
    const items: [unknown, number][] = [];
    for (const [h, checked] of changes) {
      const node = this.#nodes.get(h);
      if (!node) continue;
      const state = checked ? 1 : 0;
      if (!this.options.manageCheckboxStateManually) {
        const cur = (node.item as { checkboxState?: unknown }).checkboxState;
        (node.item as { checkboxState?: unknown }).checkboxState = isObj(cur) ? { ...cur, state } : state;
      }
      items.push([node.element, state]);
    }
    if (items.length) this.onDidChangeCheckboxState.fire({ items });
  }

  /** The item's own command (clicked in the tree). */
  command(handle: string): Promise<unknown> | undefined {
    const cmd = this.#nodes.get(handle)?.item.command;
    if (!cmd || typeof cmd.command !== "string") return;
    return this.views.host.executeCommand(cmd.command, ...(cmd.arguments ?? []));
  }

  /** A `view/item/context` menu command: VS Code passes the element, then the selection (multi-select). */
  menuCommand(command: string, handle: string, selected: string[]): Promise<unknown> {
    const node = this.#nodes.get(handle);
    const sel = selected.map((h) => this.#nodes.get(h)?.element).filter((e) => e !== undefined);
    const args: unknown[] = node ? [node.element] : [];
    if (node && this.options.canSelectMany && sel.length > 1) args.push(sel);
    return this.views.host.executeCommand(command, ...args);
  }

  async reveal(element: unknown, options: { select?: boolean; focus?: boolean; expand?: boolean | number } = {}) {
    if (typeof this.provider.getParent !== "function") throw new Error("Required registered TreeDataProvider to implement 'getParent' method to access 'reveal' method");
    const chain: unknown[] = [element];
    for (let p = await this.provider.getParent(element), depth = 0; p !== undefined && p !== null && depth < 64; p = await this.provider.getParent(p), depth++) chain.unshift(p);
    const items: Record<string, TreeItemDTO[]> = {};
    const path: string[] = [];
    let parent: string | null = null;
    for (const el of chain) {
      let node = this.#byElement.get(el);
      if (!node || (node.parent?.handle ?? null) !== parent) {
        items[parent ?? ""] = await this.children(parent);
        node = this.#byElement.get(el);
        if (!node) {
          // Elements re-created by the provider: match by TreeItem.id.
          const id = (await this.#treeItem(el)).id;
          const siblings: Node[] | null = parent === null ? this.#roots : (this.#nodes.get(parent)?.children ?? null);
          node = id ? siblings?.find((n: Node) => n.item.id === id) : undefined;
        }
      }
      if (!node) throw new Error(`Cannot reveal the element: it is not in the tree of '${this.id}'.`);
      path.push(node.handle);
      parent = node.handle;
    }
    const levels = options.expand === true ? 1 : typeof options.expand === "number" ? Math.min(3, options.expand) : 0;
    const expandLevel = async (handles: string[], left: number) => {
      if (left <= 0) return;
      for (const h of handles) {
        const node = this.#nodes.get(h);
        if (!node || !node.item.collapsibleState) continue;
        items[h] = await this.children(h);
        await expandLevel(items[h].map((i) => i.handle), left - 1);
      }
    };
    await expandLevel([path[path.length - 1]], levels);
    this.views.notifyTree("reveal", this.id, { path, items, select: options.select !== false, focus: !!options.focus, expand: levels });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#changeSub?.dispose();
    this.views.removeTree(this);
  }
}

function labelOf(item: T.TreeItem): string {
  const l = item.label;
  if (typeof l === "string") return l;
  if (isObj(l) && typeof l.label === "string") return l.label;
  return "";
}

// ───────────────────────── webviews ─────────────────────────

class WebviewImpl {
  #html = "";
  #options: Record<string, unknown>;
  readonly onDidReceiveMessage = new EventEmitter<unknown>();
  readonly api: Record<string, unknown>;
  disposed = false;
  /** retainContextWhenHidden (panel options / webview view registration). */
  retain = false;

  constructor(
    readonly handle: string,
    readonly ext: ExtState,
    options: Record<string, unknown> | undefined,
    private readonly views: ViewsHost,
  ) {
    this.#options = { ...(options ?? {}) };
    this.api = Object.defineProperties(
      {
        onDidReceiveMessage: this.onDidReceiveMessage.event,
        postMessage: (message: unknown) => this.postMessage(message),
        asWebviewUri: (uri: Uri) => this.views.asWebviewUri(this.handle, uri),
      },
      {
        html: {
          get: () => this.#html,
          set: (v: unknown) => {
            this.#html = String(v ?? "");
            if (!this.disposed) this.views.rpc.notify("$main.webview", ["html", this.handle, this.#html]);
          },
          enumerable: true,
        },
        options: {
          get: () => ({ ...this.#options }),
          set: (v: unknown) => {
            this.#options = { ...(isObj(v) ? v : {}) };
            if (!this.disposed) this.views.rpc.notify("$main.webview", ["options", this.handle, this.optionsDTO()]);
          },
          enumerable: true,
        },
        cspSource: { get: () => this.views.cspSource, enumerable: true },
      },
    );
  }

  optionsDTO(): WebviewOptionsDTO {
    const o = this.#options;
    const roots = Array.isArray(o.localResourceRoots) ? (o.localResourceRoots as unknown[]).filter((u): u is Uri => Uri.isUri(u)) : this.views.defaultRoots(this.ext);
    return {
      enableScripts: !!o.enableScripts,
      enableForms: o.enableForms === undefined ? !!o.enableScripts : !!o.enableForms,
      enableCommandUris: Array.isArray(o.enableCommandUris) ? (o.enableCommandUris as string[]) : !!o.enableCommandUris,
      localResourceRoots: roots.map((u) => (u.scheme === "file" && this.views.host.env.kind === "node" ? u.fsPath : u.toString())),
      retainContextWhenHidden: this.retain,
    };
  }

  async postMessage(message: unknown): Promise<boolean> {
    if (this.disposed) return false;
    return !!(await this.views.rpc.request<boolean>("$main.webviewPost", [this.handle, encodeWebviewMessage(message)]).catch(() => false));
  }
}

interface PanelState {
  webview: WebviewImpl;
  api: Record<string, unknown>;
  onDidDispose: EventEmitter<void>;
  onDidChangeViewState: EventEmitter<{ webviewPanel: unknown }>;
  state: { active: boolean; visible: boolean; viewColumn: number };
  disposed: boolean;
}

interface ViewState {
  webview: WebviewImpl;
  viewId: string;
  onDidDispose: EventEmitter<void>;
  onDidChangeVisibility: EventEmitter<void>;
  visible: boolean;
}

// ───────────────────────── the service ─────────────────────────

export class ViewsHost {
  readonly #trees = new Map<string, TreeViewImpl>();
  readonly #webviews = new Map<string, WebviewImpl>();
  readonly #panels = new Map<string, PanelState>();
  readonly #webviewViews = new Map<string, ViewState>();
  readonly #viewProviders = new Map<string, { ext: ExtState; provider: { resolveWebviewView(view: unknown, ctx: unknown, token: unknown): unknown }; retain: boolean }>();
  #seq = 0;
  readonly #dirty = new Set<TreeViewImpl>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly host: ExtHost) {
    const r = host.rpc;
    const tree = (id: unknown) => {
      const t = this.#trees.get(String(id));
      if (!t) throw new Error(`No tree view '${id}' is registered.`);
      return t;
    };
    r.register("$treeChildren", ([id, handle]) => tree(id).children((handle as string | null) ?? null));
    r.register("$treeResolve", ([id, handle]) => tree(id).resolve(String(handle)));
    r.register("$treeVisible", ([id, visible]) => this.#trees.get(String(id))?.setVisible(!!visible));
    r.register("$treeSelection", ([id, handles]) => this.#trees.get(String(id))?.setSelection((handles as string[]) ?? []));
    r.register("$treeExpanded", ([id, handle, expanded]) => this.#trees.get(String(id))?.setExpanded(String(handle), !!expanded));
    r.register("$treeCheckbox", ([id, changes]) => this.#trees.get(String(id))?.setCheckboxes((changes as [string, boolean][]) ?? []));
    r.register("$treeCommand", ([id, handle]) => tree(id).command(String(handle)));
    r.register("$treeMenuCommand", ([id, command, handle, selected]) => tree(id).menuCommand(String(command), String(handle), (selected as string[]) ?? []));
    r.register("$webviewMessage", ([handle, message]) => this.#webviews.get(String(handle))?.onDidReceiveMessage.fire(decodeWebviewMessage(message)));
    r.register("$resolveWebviewView", ([viewId]) => this.#resolveView(String(viewId)));
    r.register("$webviewViewVisible", ([handle, visible]) => {
      const v = this.#webviewViews.get(String(handle));
      if (!v || v.visible === !!visible) return;
      v.visible = !!visible;
      v.onDidChangeVisibility.fire();
    });
    r.register("$webviewViewDisposed", ([handle]) => this.#disposeView(String(handle)));
    r.register("$webviewPanelState", ([handle, state]) => {
      const p = this.#panels.get(String(handle));
      if (!p || p.disposed) return;
      const s = state as PanelState["state"];
      if (s.active === p.state.active && s.visible === p.state.visible && s.viewColumn === p.state.viewColumn) return;
      p.state = { ...s };
      p.onDidChangeViewState.fire({ webviewPanel: p.api });
    });
    r.register("$webviewPanelDisposed", ([handle]) => this.#disposePanel(String(handle), false));
  }

  get rpc() {
    return this.host.rpc;
  }

  get cspSource() {
    const env = this.host.data?.env;
    return env?.webviewCspSource ?? env?.webviewBase ?? "tmwebview:";
  }

  notifyTree(op: string, viewId: string, data: unknown) {
    this.rpc.notify("$main.treeView", [op, viewId, data]);
  }

  schedule(tree: TreeViewImpl) {
    this.#dirty.add(tree);
    this.#flushTimer ??= setTimeout(() => {
      this.#flushTimer = null;
      const list = [...this.#dirty];
      this.#dirty.clear();
      for (const t of list) void t.flush();
    }, 0);
  }

  // ── tree views ──

  createTreeView(ext: ExtState, viewId: string, options: Record<string, unknown>) {
    const provider = options?.treeDataProvider as Provider | undefined;
    if (!provider || typeof provider !== "object") throw new Error("Options with treeDataProvider is mandatory");
    const id = String(viewId);
    this.#trees.get(id)?.dispose();
    const opts: TreeViewOptionsDTO = { extensionId: ext.desc.id, canSelectMany: !!options.canSelectMany, showCollapseAll: !!options.showCollapseAll, manageCheckboxStateManually: !!options.manageCheckboxStateManually };
    const t = new TreeViewImpl(id, ext, provider, opts, this);
    this.#trees.set(id, t);
    this.notifyTree("register", id, opts);
    return t.api;
  }

  registerTreeDataProvider(ext: ExtState, viewId: string, provider: unknown) {
    const view = this.createTreeView(ext, viewId, { treeDataProvider: provider });
    return new T.Disposable(() => (view.dispose as () => void)());
  }

  removeTree(t: TreeViewImpl) {
    if (this.#trees.get(t.id) !== t) return;
    this.#trees.delete(t.id);
    this.notifyTree("dispose", t.id, null);
  }

  // ── icons & resources ──

  /** A resource the workbench can load: an extension's file, a workspace file, or a data:/https: URL. */
  resourceRef(uri: unknown, ext: ExtState): ResourceRefDTO | undefined {
    if (typeof uri === "string") {
      // A path relative to the extension (or absolute).
      if (/^(data|https):/.test(uri)) return { url: uri };
      const abs = uri.startsWith("/") || /^[A-Za-z]:[\\/]/.test(uri) ? Uri.file(uri) : null;
      return abs ? this.resourceRef(abs, ext) : { ext: ext.desc.id, path: uri.replace(/^\.\//, "") };
    }
    if (!Uri.isUri(uri)) return undefined;
    if (uri.scheme === "data" || uri.scheme === "https") return { url: uri.toString(true) };
    if (uri.scheme === "tmcode-extension") {
      const [, id, ...rest] = uri.path.split("/");
      return id ? { ext: id, path: rest.join("/") } : undefined;
    }
    if (uri.scheme !== "file") return undefined;
    const ws = this.host.paths.toPath(uri);
    if (ws !== null) return { ws };
    const p = uri.fsPath;
    for (const e of [ext, ...this.host.exts.values()]) {
      for (const loc of new Set([e.desc.location, this.host.env.realPath?.(e.desc.location) ?? e.desc.location])) {
        const base = loc.replace(/[\\/]+$/, "");
        if (p.startsWith(base + "/") || p.startsWith(base + "\\")) return { ext: e.desc.id, path: p.slice(base.length + 1).replace(/\\/g, "/") };
      }
    }
    return undefined;
  }

  icon(iconPath: unknown, ext: ExtState): IconDTO | undefined {
    if (!iconPath) return undefined;
    if (iconPath instanceof T.ThemeIcon || (isObj(iconPath) && typeof iconPath.id === "string" && !Uri.isUri(iconPath) && !("light" in iconPath))) {
      const ti = iconPath as { id: string; color?: { id: string } };
      return { codicon: ti.id, color: ti.color && typeof ti.color.id === "string" ? ti.color.id : undefined };
    }
    if (isObj(iconPath) && "light" in iconPath && "dark" in iconPath) {
      const light = this.resourceRef(iconPath.light, ext);
      const dark = this.resourceRef(iconPath.dark, ext);
      return light && dark ? { light, dark } : light ? { light, dark: light } : dark ? { light: dark, dark } : undefined;
    }
    const ref = this.resourceRef(iconPath, ext);
    return ref ? { light: ref, dark: ref } : undefined;
  }

  // ── webviews ──

  defaultRoots(ext: ExtState): Uri[] {
    const roots = [this.host.env.kind === "node" ? Uri.file(ext.desc.location) : Uri.from({ scheme: "tmcode-extension", path: `/${ext.desc.id}` })];
    if (this.host.folder) roots.push(this.host.folder);
    return roots;
  }

  /** `webview.asWebviewUri`: `<base>/<handle>/file/<absolute path>` (served by the app from localResourceRoots). */
  asWebviewUri(handle: string, uri: Uri): Uri {
    if (!Uri.isUri(uri)) return uri;
    const base = Uri.parse(this.host.data?.env.webviewBase ?? "tmwebview://localhost");
    let path: string;
    if (uri.scheme === "file") path = `/${handle}/file/${uri.path.replace(/^\/+/, "")}`;
    else if (uri.scheme === "tmcode-extension") path = `/${handle}/ext${uri.path}`;
    else return uri;
    return Uri.from({ scheme: base.scheme, authority: base.authority, path, query: uri.query, fragment: uri.fragment });
  }

  #newWebview(ext: ExtState, options: Record<string, unknown> | undefined): WebviewImpl {
    const handle = `wv${++this.#seq}`;
    const w = new WebviewImpl(handle, ext, options, this);
    this.#webviews.set(handle, w);
    return w;
  }

  createWebviewPanel(ext: ExtState, viewType: string, title: string, showOptions: unknown, options?: Record<string, unknown>) {
    const w = this.#newWebview(ext, options);
    w.retain = !!options?.retainContextWhenHidden;
    const handle = w.handle;
    const column = typeof showOptions === "number" ? showOptions : isObj(showOptions) && typeof showOptions.viewColumn === "number" ? showOptions.viewColumn : T.ViewColumn.Active;
    const preserveFocus = isObj(showOptions) ? !!showOptions.preserveFocus : false;
    const onDidDispose = new EventEmitter<void>();
    const onDidChangeViewState = new EventEmitter<{ webviewPanel: unknown }>();
    let panelTitle = String(title ?? "");
    let iconPath: unknown;
    const panel: PanelState = { webview: w, api: {}, onDidDispose, onDidChangeViewState, state: { active: !preserveFocus, visible: true, viewColumn: column > 0 ? column : 1 }, disposed: false };
    panel.api = Object.defineProperties(
      {
        viewType: String(viewType),
        webview: w.api,
        options: Object.freeze({ enableFindWidget: !!options?.enableFindWidget, retainContextWhenHidden: !!options?.retainContextWhenHidden }),
        onDidDispose: onDidDispose.event,
        onDidChangeViewState: onDidChangeViewState.event,
        reveal: (viewColumn?: number, preserve?: boolean) => {
          if (panel.disposed) throw new Error("Webview is disposed");
          this.rpc.notify("$main.webview", ["reveal", handle, { viewColumn, preserveFocus: !!preserve }]);
        },
        dispose: () => this.#disposePanel(handle, true),
      },
      {
        title: {
          get: () => panelTitle,
          set: (v: unknown) => {
            panelTitle = String(v ?? "");
            if (!panel.disposed) this.rpc.notify("$main.webview", ["title", handle, panelTitle]);
          },
          enumerable: true,
        },
        iconPath: {
          get: () => iconPath,
          set: (v: unknown) => {
            iconPath = v;
            if (!panel.disposed) this.rpc.notify("$main.webview", ["icon", handle, this.icon(v, ext) ?? null]);
          },
          enumerable: true,
        },
        active: { get: () => panel.state.active, enumerable: true },
        visible: { get: () => panel.state.visible, enumerable: true },
        viewColumn: { get: () => panel.state.viewColumn, enumerable: true },
      },
    );
    this.#panels.set(handle, panel);
    const dto: WebviewCreateDTO = { kind: "panel", extensionId: ext.desc.id, viewType: String(viewType), title: panelTitle, options: w.optionsDTO(), viewColumn: column, preserveFocus };
    this.rpc.notify("$main.webview", ["create", handle, dto]);
    return panel.api;
  }

  #disposePanel(handle: string, fromExtension: boolean) {
    const p = this.#panels.get(handle);
    if (!p || p.disposed) return;
    p.disposed = true;
    p.webview.disposed = true;
    this.#panels.delete(handle);
    this.#webviews.delete(handle);
    if (fromExtension) this.rpc.notify("$main.webview", ["dispose", handle, null]);
    p.onDidDispose.fire();
  }

  registerWebviewViewProvider(ext: ExtState, viewId: string, provider: unknown, options?: { webviewOptions?: { retainContextWhenHidden?: boolean } }) {
    const id = String(viewId);
    if (!provider || typeof (provider as { resolveWebviewView?: unknown }).resolveWebviewView !== "function") throw new Error("A WebviewViewProvider must implement resolveWebviewView");
    if (this.#viewProviders.has(id)) throw new Error(`View provider for '${id}' already registered`);
    const retain = !!options?.webviewOptions?.retainContextWhenHidden;
    this.#viewProviders.set(id, { ext, provider: provider as { resolveWebviewView(view: unknown, ctx: unknown, token: unknown): unknown }, retain });
    this.rpc.notify("$main.webviewView", ["register", id, { extensionId: ext.desc.id, retainContextWhenHidden: retain }]);
    return new T.Disposable(() => {
      this.#viewProviders.delete(id);
      for (const [h, v] of this.#webviewViews) if (v.viewId === id) this.#disposeView(h);
      this.rpc.notify("$main.webviewView", ["dispose", id, null]);
    });
  }

  async #resolveView(viewId: string): Promise<string | null> {
    const reg = this.#viewProviders.get(viewId);
    if (!reg) return null;
    const w = this.#newWebview(reg.ext, {});
    w.retain = reg.retain;
    const handle = w.handle;
    const onDidDispose = new EventEmitter<void>();
    const onDidChangeVisibility = new EventEmitter<void>();
    const state: ViewState = { webview: w, viewId, onDidDispose, onDidChangeVisibility, visible: true };
    this.#webviewViews.set(handle, state);
    const meta: ViewMetaDTO = {};
    const metaProp = (key: "title" | "description" | "badge") => ({
      get: () => meta[key],
      set: (v: unknown) => {
        if (key === "badge") meta.badge = isObj(v) && typeof v.value === "number" ? { value: v.value, tooltip: typeof v.tooltip === "string" ? v.tooltip : undefined } : null;
        else meta[key] = typeof v === "string" ? v : undefined;
        this.rpc.notify("$main.webview", ["viewMeta", handle, { [key]: meta[key] ?? (key === "badge" ? null : "") }]);
      },
      enumerable: true,
    });
    const view = Object.defineProperties(
      {
        viewType: viewId,
        webview: w.api,
        onDidDispose: onDidDispose.event,
        onDidChangeVisibility: onDidChangeVisibility.event,
        show: (preserveFocus?: boolean) => this.rpc.notify("$main.webview", ["show", handle, { preserveFocus: !!preserveFocus }]),
      },
      { title: metaProp("title"), description: metaProp("description"), badge: metaProp("badge"), visible: { get: () => state.visible, enumerable: true } },
    );
    const dto: WebviewCreateDTO = { kind: "view", extensionId: reg.ext.desc.id, viewType: viewId, options: w.optionsDTO() };
    this.rpc.notify("$main.webview", ["create", handle, dto]);
    const src = new CancellationTokenSource();
    try {
      await reg.provider.resolveWebviewView(view, { state: undefined }, src.token);
    } catch (e) {
      this.host.log("error", `Resolving the webview view '${viewId}' failed: ${errorText(e)}`, reg.ext.desc.id);
      throw e;
    }
    return handle;
  }

  #disposeView(handle: string) {
    const v = this.#webviewViews.get(handle);
    if (!v) return;
    this.#webviewViews.delete(handle);
    this.#webviews.delete(handle);
    v.webview.disposed = true;
    v.onDidDispose.fire();
  }
}
