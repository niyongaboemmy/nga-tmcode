import { create } from "zustand";
import type { ResourceRefDTO, ViewMetaDTO } from "@tmcode/exthost";
import { registerCommand } from "../../commands/registry";
import { getPlatform, revealView, showPanel, useWorkbench, type PanelId, type ViewId } from "../../state/store";
import { localize, normalizeExtensionPath, type MenuItemContribution } from "../../extensions/manifest";
import type { InstalledExtension } from "../../extensions/service";
import { contributedCommand, groupOf, type ContributedCommand } from "../contributions";
import { contextKey } from "../context";
import { evaluateWhen } from "../when";
import { useContextVersion } from "../state";

/**
 * Extension UI contributions as data: `contributes.viewsContainers`
 * (activity bar and panel), `contributes.views` (into TMCode's Explorer,
 * Source Control, Run and Debug and Testing, or an extension's container),
 * `contributes.viewsWelcome`, `contributes.icons` (icon fonts behind
 * `$(name)`), and the `view/title` / `view/item/context` menus. Rebuilt
 * whenever the running extensions change (applyViewContributions).
 */

/** An image inside an extension, or a codicon. */
export type IconSpec = { codicon: string } | { ext: string; path: string };

export interface ViewContainer {
  /** "ext:<container id>": the side bar view id / panel id TMCode uses. */
  key: `ext:${string}`;
  id: string;
  title: string;
  icon: IconSpec;
  location: "activitybar" | "panel";
  extensionId: string;
}

export type BuiltinContainer = "explorer" | "scm" | "debug" | "testing";

export interface ContributedView {
  id: string;
  name: string;
  /** A built-in container, or the key of an extension container. */
  container: BuiltinContainer | `ext:${string}`;
  type: "tree" | "webview";
  when?: string;
  extensionId: string;
  icon?: IconSpec;
  /** VS Code's `visibility`: "collapsed" views start closed. */
  collapsed: boolean;
  hidden: boolean;
  initialSize?: number;
}

export interface ViewWelcome {
  view: string;
  contents: string;
  when?: string;
}

export interface ViewMenuItem {
  cmd: ContributedCommand;
  item: MenuItemContribution;
  group: string;
  order: number;
}

interface ViewsState {
  containers: ViewContainer[];
  views: ContributedView[];
  welcome: ViewWelcome[];
  /** Bumps whenever contributions change. */
  version: number;
  /** Pane open/closed, per view id (the user's choice; defaults from `visibility`). */
  open: Record<string, boolean>;
  /** TreeView / WebviewView title, description, message and badge set by the extension. */
  meta: Record<string, ViewMetaDTO>;
}

export const useViews = create<ViewsState>()(() => ({ containers: [], views: [], welcome: [], version: 0, open: {}, meta: {} }));

let titleMenus: ViewMenuItem[] = [];
let itemMenus: ViewMenuItem[] = [];
let commandDisposers: (() => void)[] = [];
let iconStyle: HTMLStyleElement | null = null;

const BUILTIN: Record<string, BuiltinContainer> = { explorer: "explorer", scm: "scm", debug: "debug", test: "testing" };

const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function iconSpec(raw: unknown, extensionId: string): IconSpec | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const codicon = /^\$\(([\w-]+)(?:~spin)?\)$/.exec(raw)?.[1];
  if (codicon) return { codicon };
  const path = normalizeExtensionPath(raw);
  return path ? { ext: extensionId, path } : undefined;
}

/** Applies the view contributions of the running extensions ([] while extensions are blocked). */
export function applyViewContributions(exts: InstalledExtension[]) {
  const containers: ViewContainer[] = [];
  const views: ContributedView[] = [];
  const welcome: ViewWelcome[] = [];
  titleMenus = [];
  itemMenus = [];
  const fonts: string[] = [];
  for (const ext of exts) {
    const m = ext.manifest;
    const c = (m.raw.contributes ?? {}) as Record<string, unknown>;
    const vc = (c.viewsContainers ?? {}) as Record<string, unknown>;
    for (const location of ["activitybar", "panel"] as const) {
      for (const x of list(vc[location])) {
        const id = str(x.id);
        if (!id || !/^[\w.-]+$/.test(id)) continue;
        containers.push({ key: `ext:${id}`, id, title: localize(x.title, m.nls) || id, icon: iconSpec(x.icon, ext.id) ?? { codicon: "extensions" }, location, extensionId: ext.id });
      }
    }
    for (const [where, items] of Object.entries((c.views ?? {}) as Record<string, unknown>)) {
      const container = BUILTIN[where] ?? (`ext:${where}` as const);
      for (const v of list(items)) {
        const id = str(v.id);
        if (!id) continue;
        views.push({
          id,
          name: localize(v.name, m.nls) || id,
          container,
          type: v.type === "webview" ? "webview" : "tree",
          when: str(v.when),
          extensionId: ext.id,
          icon: iconSpec(v.icon, ext.id),
          collapsed: v.visibility === "collapsed",
          hidden: v.visibility === "hidden",
          initialSize: typeof v.initialSize === "number" ? v.initialSize : undefined,
        });
      }
    }
    for (const w of list(c.viewsWelcome)) {
      const view = str(w.view);
      const contents = localize(w.contents, m.nls);
      if (view && contents) welcome.push({ view, contents, when: str(w.when) });
    }
    const menuItems = (menu: string) =>
      (m.menus[menu] ?? []).flatMap((item) => {
        const cmd = contributedCommand(item.command) ?? { command: item.command, title: item.command, extensionId: ext.id };
        const { group, order } = groupOf(item);
        return [{ cmd, item, group: item.group ? group : "", order }];
      });
    titleMenus.push(...menuItems("view/title"));
    itemMenus.push(...menuItems("view/item/context"));
    // contributes.icons: "$(gitlens-graph)" glyphs from the extension's icon font.
    if (c.icons && typeof c.icons === "object") {
      const byFont = new Map<string, [string, string][]>();
      for (const [name, def] of Object.entries(c.icons as Record<string, unknown>)) {
        const d = (def as { default?: unknown })?.default;
        if (!d || typeof d !== "object") continue;
        const fontPath = normalizeExtensionPath(String((d as { fontPath?: unknown }).fontPath ?? ""));
        const ch = String((d as { fontCharacter?: unknown }).fontCharacter ?? "");
        if (!fontPath || !/^[\w-]+$/.test(name)) continue;
        byFont.set(fontPath, [...(byFont.get(fontPath) ?? []), [name, ch]]);
      }
      for (const [fontPath, glyphs] of byFont) fonts.push(...iconFontRules(ext.id, fontPath, glyphs));
    }
  }
  const sortKey = (x: ViewMenuItem) => `${x.group === "navigation" ? "0" : x.group === "inline" ? "1" : "2"}${x.group}\u0000${String(x.order).padStart(6, "0")}`;
  titleMenus.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  itemMenus.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  // Containers without views (or with only views of a missing container) are left out, as in VS Code.
  const used = containers.filter((c) => views.some((v) => v.container === c.key));
  const s = useViews.getState();
  useViews.setState({ containers: used, views, welcome, version: s.version + 1 });
  registerViewCommands(used, views);
  void loadIconFonts(fonts);
  // A side bar / panel showing a container that went away falls back to the Explorer / Problems.
  const wb = useWorkbench.getState();
  if (wb.activeView.startsWith("ext:") && !used.some((c) => c.key === wb.activeView)) useWorkbench.setState({ activeView: "explorer" });
  if (wb.activePanel.startsWith("ext:") && !used.some((c) => c.key === wb.activePanel)) useWorkbench.setState({ activePanel: "problems" });
}

function iconFontRules(extensionId: string, fontPath: string, glyphs: [string, string][]): string[] {
  const family = `tmext-${extensionId.replace(/[^\w-]/g, "-")}-${fontPath.replace(/[^\w-]/g, "-")}`;
  const out = [`@font-face{font-family:"${family}";src:url("{{${extensionId}|${fontPath}}}");font-display:block}`];
  for (const [name, ch] of glyphs) {
    const code = /^\\+([0-9a-f]{1,6})$/i.exec(ch)?.[1];
    const content = code ? `"\\${code}"` : JSON.stringify(ch);
    out.push(`.codicon.codicon-${name}::before{font-family:"${family}"!important;content:${content}}`);
  }
  return out;
}

let fontSeq = 0;
async function loadIconFonts(rules: string[]) {
  const seq = ++fontSeq;
  const host = getPlatform().extensions;
  const out: string[] = [];
  for (const rule of rules) {
    const m = /\{\{([^|]+)\|([^}]+)\}\}/.exec(rule);
    if (!m) {
      out.push(rule);
      continue;
    }
    const b64 = await host?.readFile(m[1], m[2], "base64").catch(() => null);
    if (b64) out.push(rule.replace(m[0], `data:${mimeOf(m[2])};base64,${b64}`));
  }
  if (seq !== fontSeq) return;
  iconStyle ??= document.head.appendChild(document.createElement("style"));
  iconStyle.dataset.tmcode = "extension-icons";
  iconStyle.textContent = out.join("\n");
}

function registerViewCommands(containers: ViewContainer[], views: ContributedView[]) {
  commandDisposers.forEach((d) => d());
  commandDisposers = [];
  for (const c of containers) {
    commandDisposers.push(
      registerCommand({
        id: `workbench.view.extension.${c.id}`,
        title: `Show ${c.title}`,
        category: "View",
        run: () => showContainer(c.key),
      }) as () => void,
    );
  }
  for (const v of views) {
    commandDisposers.push(
      registerCommand({ id: `${v.id}.focus`, title: `Focus on ${v.name} View`, category: v.name, hidden: true, run: () => focusView(v.id) }) as () => void,
      registerCommand({ id: `${v.id}.open`, title: `Open ${v.name} View`, hidden: true, run: () => focusView(v.id) }) as () => void,
    );
  }
}

export function showContainer(key: `ext:${string}`) {
  const c = useViews.getState().containers.find((x) => x.key === key);
  if (!c) return;
  if (c.location === "panel") showPanel(key as PanelId);
  else revealView(key as ViewId);
}

/** Shows a view (its container, open), and focuses it unless `focus` is false. */
export function focusView(id: string, focus = true) {
  const v = useViews.getState().views.find((x) => x.id === id);
  if (!v) return;
  setViewOpen(id, true);
  if (v.container.startsWith("ext:")) showContainer(v.container as `ext:${string}`);
  else revealView(v.container as ViewId);
  requestAnimationFrame(() => {
    // The pane scrolls into view (ViewPanes listens), and takes the focus.
    window.dispatchEvent(new CustomEvent("tmcode:show-view", { detail: id }));
    if (focus) document.querySelector<HTMLElement>(`[data-view-id="${CSS.escape(id)}"] .tm-pane-header`)?.focus();
  });
}

export function setViewOpen(id: string, open: boolean) {
  useViews.setState((s) => ({ open: { ...s.open, [id]: open } }));
}

export function viewOpen(v: ContributedView, open: Record<string, boolean>) {
  return open[v.id] ?? !v.collapsed;
}

export function setViewMeta(id: string, patch: ViewMetaDTO) {
  useViews.setState((s) => ({ meta: { ...s.meta, [id]: { ...s.meta[id], ...patch } } }));
}

/** A `when` clause with view keys (`view`, `viewItem`) on top of the workbench's context. */
export function whenFor(clause: string | undefined, keys: Record<string, unknown> = {}): boolean {
  return evaluateWhen(clause, (k) => (k in keys ? keys[k] : contextKey(k)));
}

/** Views of a container whose `when` holds now. */
export function useVisibleViews(container: string): ContributedView[] {
  const views = useViews((s) => s.views);
  useContextVersion((s) => s.v);
  useWorkbench((s) => s.settings);
  return views.filter((v) => v.container === container && !v.hidden && whenFor(v.when));
}

export function titleActions(viewId: string): ViewMenuItem[] {
  return titleMenus.filter((m) => whenFor(m.item.when, { view: viewId }));
}

export function itemActions(viewId: string, contextValue: string | undefined, extra: Record<string, unknown> = {}): ViewMenuItem[] {
  const keys = { view: viewId, viewItem: contextValue ?? "", ...extra };
  return itemMenus.filter((m) => {
    // Cheap pre-filter: most items name their view.
    const w = m.item.when;
    if (w && w.includes("view ==") && !w.includes(viewId) && !w.includes("view =~")) return false;
    return whenFor(w, keys);
  });
}

// ───────────── images (extension files, workspace files) ─────────────

export function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    { css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", html: "text/html", map: "application/json", wasm: "application/wasm", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf" }[ext] ??
    "application/octet-stream"
  );
}

const images = new Map<string, Promise<string | null>>();

/** A data: URL for an extension's image or a workspace image (cached), or null. */
export function loadImage(ref: ResourceRefDTO | IconSpec): Promise<string | null> {
  if ("codicon" in ref) return Promise.resolve(null);
  if ("url" in ref) return Promise.resolve(ref.url.startsWith("data:") ? ref.url : null);
  const key = "ws" in ref ? `ws:${ref.ws}` : `ext:${ref.ext}:${ref.path}`;
  let p = images.get(key);
  if (!p) {
    const platform = getPlatform();
    const path = "ws" in ref ? ref.ws : ref.path;
    const read = "ws" in ref ? (platform.fs.readBase64 ? platform.fs.readBase64(ref.ws) : platform.fs.readFile(ref.ws).then((t) => btoa(unescape(encodeURIComponent(t))))) : platform.extensions?.readFile(ref.ext, ref.path, "base64");
    p = Promise.resolve(read)
      .then((b64) => (b64 ? `data:${mimeOf(path)};base64,${b64}` : null))
      .catch(() => null);
    images.set(key, p);
  }
  return p;
}
