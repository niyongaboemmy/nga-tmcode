import { create } from "zustand";
import { parseJsonc } from "../textmate/jsonc";
import { resolveRelative } from "../textmate/themeData";

/**
 * File icon themes (VS Code's `iconThemes` contribution): the explorer, tabs,
 * breadcrumbs, search and quick open ask `iconFor` which icon definition a
 * path gets, then render it as an SVG/PNG image or a font glyph. Assets load
 * lazily, one icon at a time, and are cached as data: URLs (the CSP allows
 * images and fonts from data: only).
 */

export interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
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
}

export const BUILTIN_ICON_THEMES: IconThemeEntry[] = [
  { id: "tmcode", label: "TMCode Glyphs" },
  { id: "none", label: "None" },
];

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

export const useIconTheme = create<IconThemeState>()(() => ({ version: 0, active: { entry: BUILTIN_ICON_THEMES[0], doc: null }, assets: 0 }));

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

// ───────────── loading ─────────────

let languageOf: (path: string) => string | undefined = () => undefined;
/** The documents module supplies Monaco's file → language mapping (for `languageIds`). */
export function setIconLanguageResolver(fn: (path: string) => string | undefined) {
  languageOf = fn;
}
export function languageForIcon(path: string) {
  return languageOf(path);
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
  if (!entry.read || !entry.path || typeof FontFace === "undefined") return;
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
/** Loads and activates an icon theme; unknown ids fall back to the built-in glyphs. */
export async function applyIconTheme(id: string) {
  const seq = ++applySeq;
  const entry = allIconThemes().find((t) => t.id === id) ?? BUILTIN_ICON_THEMES[0];
  let doc: IconThemeDocument | null = null;
  if (entry.read && entry.path) {
    try {
      doc = parseJsonc<IconThemeDocument>(await entry.read(entry.path, "text"));
      await loadFonts(entry, doc);
    } catch (e) {
      console.error(`icon theme ${entry.id} failed to load`, e);
      if (seq === applySeq) useIconTheme.setState({ active: { entry: BUILTIN_ICON_THEMES[0], doc: null } });
      return false;
    }
  }
  if (seq === applySeq) useIconTheme.setState({ active: { entry, doc } });
  return true;
}
