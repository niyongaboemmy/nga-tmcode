import { create } from "zustand";
import { parseJsonc } from "../textmate/jsonc";
import { resolveRelative } from "../textmate/themeData";
import { iconLanguageId } from "./iconLanguages";

/**
 * File icon themes (VS Code's `iconThemes` contribution): the explorer, tabs,
 * breadcrumbs, search and quick open ask `iconFor` which icon definition a
 * path gets, then render it as an SVG/PNG image or a font glyph. Assets load
 * lazily, one icon at a time, and are cached as data: URLs (the CSP allows
 * images and fonts from data: only).
 *
 * Built in: VS Code's own Seti theme (the default; vendored in ./seti with its
 * MIT licences, see THIRD_PARTY_NOTICES.md) and Minimal, TMCode's older
 * colour badges ("TMCode Glyphs"), and None.
 */

export interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
  /** TMCode's built-in themes only: a codicon instead of an image or a glyph. */
  codicon?: string;
}

interface IconAssociations {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  rootFolder?: string;
  rootFolderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
}

export interface IconThemeDocument extends IconAssociations {
  iconDefinitions?: Record<string, IconDefinition>;
  fonts?: { id: string; src: { path: string; format?: string }[]; weight?: string; style?: string; size?: string }[];
  light?: IconAssociations;
  highContrast?: IconAssociations;
  hidesExplorerArrows?: boolean;
}

export interface IconThemeEntry {
  id: string;
  label: string;
  extensionId?: string;
  extensionName?: string;
  /** Path of the theme JSON inside the extension; assets are relative to it. */
  path?: string;
  /** Reads an extension file: text, or base64 for binary assets. */
  read?(path: string, as: "text" | "base64"): Promise<string>;
  /** A theme bundled with TMCode: its document, and the URL of a font it names. */
  builtin?: { load(): Promise<IconThemeDocument>; fontUrl?(fontPath: string): Promise<string | undefined> };
}

/** VS Code's default file icon theme, and TMCode's. */
export const DEFAULT_ICON_THEME = "vs-seti";

/** VS Code's "Minimal": one generic file icon, no folder icons. */
export const MINIMAL_ICON_THEME: IconThemeDocument = {
  iconDefinitions: { _file: { codicon: "file" } },
  file: "_file",
};

export const BUILTIN_ICON_THEMES: IconThemeEntry[] = [
  {
    id: "vs-seti",
    label: "Seti (Visual Studio Code)",
    builtin: {
      // Separate chunks, fetched once when the theme is first applied.
      load: async () => parseJsonc<IconThemeDocument>((await import("./seti/vs-seti-icon-theme.json?raw")).default),
      fontUrl: async (p) => (/seti\.woff$/.test(p) ? (await import("./seti/seti.woff?url")).default : undefined),
    },
  },
  { id: "vs-minimal", label: "Minimal (Visual Studio Code)", builtin: { load: async () => MINIMAL_ICON_THEME } },
  { id: "tmcode", label: "TMCode Glyphs" },
  { id: "none", label: "None" },
];
/** TMCode's colour badges: also what shows if a theme fails to load. */
const GLYPHS = BUILTIN_ICON_THEMES[2];

let extensionIconThemes: IconThemeEntry[] = [];

export function allIconThemes(): IconThemeEntry[] {
  return [...BUILTIN_ICON_THEMES, ...extensionIconThemes];
}

export interface ActiveIconTheme {
  entry: IconThemeEntry;
  doc: IconThemeDocument | null;
}

interface IconThemeState {
  version: number;
  active: ActiveIconTheme;
  /** Bumps when lazily loaded icon assets arrive, so icons re-render. */
  assets: number;
}

export const useIconTheme = create<IconThemeState>()(() => ({ version: 0, active: { entry: GLYPHS, doc: null }, assets: 0 }));

export function setExtensionIconThemes(list: IconThemeEntry[]) {
  extensionIconThemes = list;
  useIconTheme.setState({ version: useIconTheme.getState().version + 1 });
}

// ───────────── matching (pure) ─────────────

function lookup(maps: (Record<string, string> | undefined)[], key: string): string | undefined {
  for (const m of maps) {
    if (!m) continue;
    const hit = m[key] ?? m[key.toLowerCase()];
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The icon definition id VS Code would show for a file or folder: file names,
 * then the longest file extension ("spec.ts" before "ts"), then the language,
 * then the default. Light / high-contrast sections override the base ones.
 */
export function iconFor(
  doc: IconThemeDocument,
  path: string,
  kind: "file" | "folder",
  opts: { expanded?: boolean; variant?: "dark" | "light" | "hc"; languageId?: string; root?: boolean } = {},
): string | undefined {
  const sections: IconAssociations[] = [];
  if (opts.variant === "light" && doc.light) sections.push(doc.light);
  if (opts.variant === "hc" && doc.highContrast) sections.push(doc.highContrast);
  sections.push(doc);
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (kind === "folder") {
    const named = opts.expanded
      ? (lookup(sections.map((s) => s.folderNamesExpanded), name) ?? lookup(sections.map((s) => s.folderNames), name))
      : lookup(sections.map((s) => s.folderNames), name);
    if (named) return named;
    const pick = (k: keyof IconAssociations) => sections.map((s) => s[k] as string | undefined).find(Boolean);
    if (opts.root) return (opts.expanded ? (pick("rootFolderExpanded") ?? pick("folderExpanded")) : pick("rootFolder")) ?? pick("folder");
    return opts.expanded ? (pick("folderExpanded") ?? pick("folder")) : pick("folder");
  }
  const byName = lookup(
    sections.map((s) => s.fileNames),
    name,
  );
  if (byName) return byName;
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const hit = lookup(
      sections.map((s) => s.fileExtensions),
      ext,
    );
    if (hit) return hit;
  }
  if (opts.languageId) {
    const hit = lookup(
      sections.map((s) => s.languageIds),
      opts.languageId,
    );
    if (hit) return hit;
  }
  return sections.map((s) => s.file).find(Boolean);
}

/** "\\E001" or "\E001" or "" → the character. */
export function fontCharacter(raw: string): string {
  const m = /^\\+([0-9a-f]{1,6})$/i.exec(raw);
  return m ? String.fromCodePoint(parseInt(m[1], 16)) : raw;
}

// ───────────── cached resolution ─────────────

/** Per theme document: "variant|kind|expanded|root|name" → icon definition id (null: none). */
let resolved = new WeakMap<IconThemeDocument, Map<string, string | null>>();
let resolvedStamp = "";

/**
 * `iconFor` with the file's language filled in, cached per file name: the
 * explorer, tabs and search ask for the same few names thousands of times.
 */
export function resolveIcon(
  doc: IconThemeDocument,
  path: string,
  kind: "file" | "folder",
  opts: { expanded?: boolean; variant?: "dark" | "light" | "hc"; root?: boolean } = {},
): string | undefined {
  // Extensions can register languages later: start over when the set changes.
  const stamp = languageStamp();
  if (stamp !== resolvedStamp) {
    resolvedStamp = stamp;
    resolved = new WeakMap();
  }
  let cache = resolved.get(doc);
  if (!cache) resolved.set(doc, (cache = new Map()));
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const key = `${opts.variant ?? "dark"}|${kind}|${opts.expanded ? 1 : 0}|${opts.root ? 1 : 0}|${name}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit ?? undefined;
  const id = iconFor(doc, path, kind, { ...opts, languageId: kind === "file" ? languageForIcon(path) : undefined });
  cache.set(key, id ?? null);
  return id;
}

// ───────────── loading ─────────────

let languageOf: (path: string) => string | undefined = () => undefined;
let languageStamp: () => string = () => "";
/**
 * The documents module supplies Monaco's file → language mapping (for
 * `languageIds`), and a stamp that changes when languages are registered.
 */
export function setIconLanguageResolver(fn: (path: string) => string | undefined, stamp?: () => string) {
  languageOf = fn;
  languageStamp = stamp ?? (() => "");
  resolved = new WeakMap();
}
/** The VS Code language id of a file, as icon themes' `languageIds` expect ("dockerfile", "ignore", "javascriptreact"…). */
export function languageForIcon(path: string) {
  return iconLanguageId(path, languageOf(path));
}

const images = new Map<string, string | null>();
const pendingImages = new Set<string>();
let loadSeq = 0;
const fontFamilies = new Map<string, string>();

function mimeOf(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : "application/octet-stream";
}

/** Data URL of an icon definition's image, or undefined while it loads (then the store's `assets` bumps). */
export function iconImage(active: ActiveIconTheme, defId: string): string | null | undefined {
  const def = active.doc?.iconDefinitions?.[defId];
  if (!def?.iconPath || !active.entry.read || !active.entry.path) return null;
  const key = `${active.entry.id}|${defId}`;
  if (images.has(key)) return images.get(key);
  if (!pendingImages.has(key)) {
    pendingImages.add(key);
    const file = resolveRelative(active.entry.path, def.iconPath);
    void active.entry
      .read(file, "base64")
      .then((b64) => images.set(key, `data:${mimeOf(file)};base64,${b64}`))
      .catch(() => images.set(key, null))
      .finally(() => {
        pendingImages.delete(key);
        scheduleBump();
      });
  }
  return undefined;
}

let bumpTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleBump() {
  // Many icons arrive at once when a folder opens: one re-render for the batch.
  if (bumpTimer) return;
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    useIconTheme.setState({ assets: useIconTheme.getState().assets + 1 });
  }, 16);
}

/** CSS font-family for an icon definition's font (registered with the FontFace API). */
export function iconFont(active: ActiveIconTheme, def: IconDefinition): { family: string; size?: string } | null {
  const fonts = active.doc?.fonts ?? [];
  const font = (def.fontId ? fonts.find((f) => f.id === def.fontId) : fonts[0]) ?? null;
  if (!font) return null;
  const family = fontFamilies.get(`${active.entry.id}|${font.id}`);
  return family ? { family, size: def.fontSize ?? font.size } : null;
}

async function loadFonts(entry: IconThemeEntry, doc: IconThemeDocument) {
  if (typeof FontFace === "undefined") return;
  if (entry.builtin) {
    for (const font of doc.fonts ?? []) {
      const key = `${entry.id}|${font.id}`;
      // A bundled font loads once per session, however often the theme is switched.
      if (fontFamilies.has(key)) continue;
      const src = font.src?.[0];
      const url = src ? await entry.builtin.fontUrl?.(src.path) : undefined;
      if (!url) continue;
      try {
        const family = `tm-icons-${entry.id}`;
        const face = new FontFace(family, `url(${url})`, { weight: font.weight ?? "normal", style: font.style ?? "normal" });
        await face.load();
        document.fonts.add(face);
        fontFamilies.set(key, family);
      } catch (e) {
        console.warn(`icon font ${font.id} of ${entry.id} failed`, e);
      }
    }
    return;
  }
  if (!entry.read || !entry.path) return;
  for (const font of doc.fonts ?? []) {
    const src = font.src?.[0];
    if (!src) continue;
    try {
      const file = resolveRelative(entry.path, src.path);
      const b64 = await entry.read(file, "base64");
      const family = `tm-icons-${++loadSeq}`;
      const format = src.format ?? (file.endsWith(".woff2") ? "woff2" : file.endsWith(".woff") ? "woff" : "truetype");
      const mime = format === "woff2" ? "font/woff2" : format === "woff" ? "font/woff" : "font/ttf";
      const face = new FontFace(family, `url(data:${mime};base64,${b64})`, { weight: font.weight ?? "normal", style: font.style ?? "normal" });
      await face.load();
      document.fonts.add(face);
      fontFamilies.set(`${entry.id}|${font.id}`, family);
    } catch (e) {
      console.warn(`icon font ${font.id} of ${entry.id} failed`, e);
    }
  }
}

let applySeq = 0;
const builtinDocs = new Map<string, IconThemeDocument>();
/** Loads and activates an icon theme; unknown ids (an uninstalled extension's) fall back to the default, Seti. */
export async function applyIconTheme(id: string) {
  const seq = ++applySeq;
  const entry = allIconThemes().find((t) => t.id === id) ?? BUILTIN_ICON_THEMES[0];
  let doc: IconThemeDocument | null = null;
  if (entry.builtin || (entry.read && entry.path)) {
    try {
      if (entry.builtin) {
        doc = builtinDocs.get(entry.id) ?? (await entry.builtin.load());
        builtinDocs.set(entry.id, doc);
      } else doc = parseJsonc<IconThemeDocument>(await entry.read!(entry.path!, "text"));
      await loadFonts(entry, doc);
    } catch (e) {
      console.error(`icon theme ${entry.id} failed to load`, e);
      if (seq === applySeq) useIconTheme.setState({ active: { entry: GLYPHS, doc: null } });
      return false;
    }
  }
  if (seq === applySeq) useIconTheme.setState({ active: { entry, doc } });
  return true;
}
