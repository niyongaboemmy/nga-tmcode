import { EventEmitter } from "../api/events";
import * as T from "../api/types";
import * as MT from "../api/moreTypes";
import type { Uri } from "../api/uri";
import type { RpcConnection } from "../rpc";
import type { PathMapper } from "./convert";

/**
 * `window.tabGroups` over the workbench's editor groups. The workbench sends a
 * snapshot whenever tabs change (`$tabsChanged`); groups and tabs keep their
 * object identity across snapshots (extensions compare them, as Claude Code
 * does after moving a tab), and the events say what opened, closed or changed.
 */

export interface TabDTO {
  id: string;
  label: string;
  /** text: a file; diff: two documents; webview: an extension's panel; other: TMCode's own editors. */
  kind: "text" | "diff" | "webview" | "other";
  path?: string;
  original?: string;
  modified?: string;
  viewType?: string;
  isActive: boolean;
  isDirty: boolean;
  isPinned: boolean;
  isPreview: boolean;
}

export interface TabGroupDTO {
  id: number;
  viewColumn: number;
  isActive: boolean;
  tabs: TabDTO[];
}

class Tab {
  input: unknown;
  label = "";
  isActive = false;
  isDirty = false;
  isPinned = false;
  isPreview = false;
  constructor(
    readonly id: string,
    readonly group: TabGroup,
  ) {}
}

class TabGroup {
  isActive = false;
  viewColumn = 1;
  tabs: Tab[] = [];
  constructor(readonly id: number) {}
  get activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.isActive);
  }
}

export class TabsService {
  readonly onDidChangeTabGroups = new EventEmitter<{ opened: TabGroup[]; closed: TabGroup[]; changed: TabGroup[] }>();
  readonly onDidChangeTabs = new EventEmitter<{ opened: Tab[]; closed: Tab[]; changed: Tab[] }>();
  #groups = new Map<number, TabGroup>();
  #order: TabGroup[] = [];

  constructor(
    private readonly rpc: RpcConnection,
    private readonly paths: PathMapper,
  ) {}

  get all(): readonly TabGroup[] {
    return this.#order;
  }

  get activeTabGroup(): TabGroup {
    return this.#order.find((g) => g.isActive) ?? this.#order[0] ?? this.#empty;
  }
  readonly #empty = new TabGroup(-1);

  #input(t: TabDTO): unknown {
    const uri = (p?: string): Uri | undefined => (p === undefined ? undefined : this.paths.toUri(p));
    if (t.kind === "text" && t.path !== undefined) return new T.TabInputText(uri(t.path)!);
    if (t.kind === "diff" && t.original !== undefined && t.modified !== undefined) return new MT.TabInputTextDiff(uri(t.original)!, uri(t.modified)!);
    if (t.kind === "webview") return new MT.TabInputWebview(t.viewType ?? "");
    return undefined;
  }

  /** A new snapshot from the workbench. */
  update(groups: TabGroupDTO[]) {
    const opened: Tab[] = [];
    const closed: Tab[] = [];
    const changed: Tab[] = [];
    const gOpened: TabGroup[] = [];
    const gClosed: TabGroup[] = [];
    const gChanged: TabGroup[] = [];
    const seen = new Set<number>();
    const order: TabGroup[] = [];
    for (const dto of groups) {
      seen.add(dto.id);
      let g = this.#groups.get(dto.id);
      if (!g) {
        g = new TabGroup(dto.id);
        this.#groups.set(dto.id, g);
        gOpened.push(g);
      }
      if (g.isActive !== dto.isActive || g.viewColumn !== dto.viewColumn) gChanged.push(g);
      g.isActive = dto.isActive;
      g.viewColumn = dto.viewColumn;
      const before = new Map(g.tabs.map((t) => [t.id, t]));
      const tabs: Tab[] = [];
      for (const td of dto.tabs) {
        let tab = before.get(td.id);
        const input = this.#input(td);
        if (!tab) {
          tab = new Tab(td.id, g);
          opened.push(tab);
        } else {
          before.delete(td.id);
          if (tab.label !== td.label || tab.isActive !== td.isActive || tab.isDirty !== td.isDirty || tab.isPinned !== td.isPinned || tab.isPreview !== td.isPreview) changed.push(tab);
        }
        tab.label = td.label;
        tab.isActive = td.isActive;
        tab.isDirty = td.isDirty;
        tab.isPinned = td.isPinned;
        tab.isPreview = td.isPreview;
        // Same document, same input object (identity checks); a new one when it changed.
        if (!sameInput(tab.input, input)) tab.input = input;
        tabs.push(tab);
      }
      closed.push(...before.values());
      g.tabs = tabs;
      order.push(g);
    }
    for (const [id, g] of this.#groups) {
      if (seen.has(id)) continue;
      this.#groups.delete(id);
      gClosed.push(g);
      closed.push(...g.tabs);
    }
    this.#order = order;
    if (gOpened.length || gClosed.length || gChanged.length) this.onDidChangeTabGroups.fire({ opened: gOpened, closed: gClosed, changed: gChanged });
    if (opened.length || closed.length || changed.length) this.onDidChangeTabs.fire({ opened, closed, changed });
  }

  /** `tabGroups.close(tab | tab[] | group | group[], preserveFocus)`. */
  async close(what: unknown, preserveFocus?: boolean): Promise<boolean> {
    const list = Array.isArray(what) ? what : [what];
    const ids: [number, string | null][] = [];
    for (const x of list) {
      if (x instanceof Tab) ids.push([x.group.id, x.id]);
      else if (x instanceof TabGroup) ids.push([x.id, null]);
    }
    if (!ids.length) return false;
    return !!(await this.rpc.request<boolean>("$main.closeTabs", [ids, !!preserveFocus]));
  }

  /** The `window.tabGroups` object extensions see. */
  api() {
    const svc = this;
    return {
      get all() {
        return svc.all;
      },
      get activeTabGroup() {
        return svc.activeTabGroup;
      },
      onDidChangeTabGroups: svc.onDidChangeTabGroups.event,
      onDidChangeTabs: svc.onDidChangeTabs.event,
      close: (what: unknown, preserveFocus?: boolean) => svc.close(what, preserveFocus),
    };
  }
}

function sameInput(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of ["uri", "original", "modified"]) {
    if (x[k] !== undefined || y[k] !== undefined) {
      if (String(x[k]) !== String(y[k])) return false;
    }
  }
  return x.viewType === y.viewType;
}
