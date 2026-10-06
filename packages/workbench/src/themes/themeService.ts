import { create } from "zustand";
import type { ITheme } from "@xterm/xterm";
import { loadThemeFile, type ResolvedTheme, type ThemeReader, type UiTheme } from "../textmate/themeData";
import { cssVarsForTheme, terminalThemeFor } from "./workbenchColors";

/**
 * Colour themes: VS Code's own defaults (bundled from microsoft/vscode,
 * theme-defaults, MIT) plus themes contributed by installed extensions.
 * Applying a theme recolours the editor tokens (via the textmate tokenizer),
 * the Monaco widgets, the workbench CSS variables and the terminal.
 */

export interface ThemeEntry {
  id: string;
  label: string;
  uiTheme: UiTheme;
  /** "publisher.name" of the contributing extension; undefined for built-ins. */
  extensionId?: string;
  extensionName?: string;
  load(): Promise<ResolvedTheme>;
}

const files = import.meta.glob<string>("./vscode/*.json", { query: "?raw", import: "default" });
const builtinReader: ThemeReader = {
  async read(path) {
    const load = files[`./vscode/${path}`];
    if (!load) throw new Error(`Unknown built-in theme file ${path}`);
    return load();
  },
};

const builtin = (id: string, label: string, uiTheme: UiTheme, file: string): ThemeEntry => ({
  id,
  label,
  uiTheme,
  load: () => loadThemeFile(file, builtinReader, uiTheme),
});

/** Ids of the original three keep working in saved settings and e2e (dark-modern / light-modern / dark-hc). */
export const BUILTIN_THEMES: ThemeEntry[] = [
  builtin("light-modern", "Light Modern", "vs", "light_modern.json"),
  builtin("light-plus", "Light+", "vs", "light_plus.json"),
  builtin("light-vs", "Light (Visual Studio)", "vs", "light_vs.json"),
  builtin("dark-modern", "Dark Modern", "vs-dark", "dark_modern.json"),
  builtin("dark-plus", "Dark+", "vs-dark", "dark_plus.json"),
  builtin("dark-vs", "Dark (Visual Studio)", "vs-dark", "dark_vs.json"),
  builtin("dark-hc", "Dark High Contrast", "hc-black", "hc_black.json"),
  builtin("light-hc", "Light High Contrast", "hc-light", "hc_light.json"),
];

/** Themes styled by hand in theme.css; every other theme sets CSS variables over the closest one. */
const CSS_BASES = new Set(["dark-modern", "light-modern", "dark-hc"]);

export type CssBase = "dark-modern" | "light-modern" | "dark-hc";

export function cssBaseOf(entry: Pick<ThemeEntry, "id" | "uiTheme">): CssBase {
  if (CSS_BASES.has(entry.id)) return entry.id as CssBase;
  return entry.uiTheme === "hc-black" ? "dark-hc" : entry.uiTheme === "vs-dark" ? "dark-modern" : "light-modern";
}

export interface ActiveTheme {
  id: string;
  label: string;
  uiTheme: UiTheme;
  cssBase: CssBase;
  /** Inline CSS variables (empty for the hand-styled bases). */
  cssVars: Record<string, string>;
  terminal: ITheme;
  resolved: ResolvedTheme;
}

interface ThemeState {
  /** Bumps when the list of themes changes (extensions installed/removed). */
  version: number;
  active: ActiveTheme | null;
}

export const useThemes = create<ThemeState>()(() => ({ version: 0, active: null }));

let extensionThemes: ThemeEntry[] = [];

export function setExtensionThemes(list: ThemeEntry[]) {
  extensionThemes = list;
  for (const key of [...cache.keys()]) if (!BUILTIN_THEMES.some((t) => t.id === key)) cache.delete(key);
  useThemes.setState({ version: useThemes.getState().version + 1 });
}

export function allThemes(): ThemeEntry[] {
  return [...BUILTIN_THEMES, ...extensionThemes];
}

export function findTheme(id: string): ThemeEntry | undefined {
  return allThemes().find((t) => t.id === id);
}

/** A theme that disappeared (extension removed, exam mode) falls back to the default of the same kind. */
export function fallbackTheme(uiTheme?: UiTheme): ThemeEntry {
  const id = uiTheme === "vs" || uiTheme === "hc-light" ? "light-modern" : uiTheme === "hc-black" ? "dark-hc" : "dark-modern";
  return findTheme(id)!;
}

export function isDarkThemeId(id: string) {
  const t = findTheme(id) ?? (id === useThemes.getState().active?.id ? useThemes.getState().active : null);
  return t ? t.uiTheme === "vs-dark" || t.uiTheme === "hc-black" : !id.startsWith("light");
}

const cache = new Map<string, Promise<ResolvedTheme>>();
function load(entry: ThemeEntry) {
  let p = cache.get(entry.id);
  if (!p) {
    p = entry.load();
    cache.set(entry.id, p);
    p.catch(() => cache.delete(entry.id));
  }
  return p;
}

/** Receives every applied theme (the Monaco/textmate side registers itself; kept separate so this module stays testable). */
let editorSink: ((theme: ResolvedTheme, id: string) => void) | null = null;
export function setEditorThemeSink(sink: (theme: ResolvedTheme, id: string) => void) {
  editorSink = sink;
  const a = useThemes.getState().active;
  if (a) sink(a.resolved, a.id);
}

let applySeq = 0;
const failed = new Set<string>();

/** Loads and applies a theme. Unknown or broken themes fall back to Dark/Light Modern. */
export async function applyTheme(id: string): Promise<ActiveTheme> {
  const seq = ++applySeq;
  let entry = findTheme(id) ?? fallbackTheme();
  let resolved: ResolvedTheme;
  try {
    resolved = await load(entry);
  } catch (e) {
    if (!failed.has(entry.id)) console.error(`theme ${entry.id} failed to load`, e);
    failed.add(entry.id);
    entry = fallbackTheme(entry.uiTheme);
    resolved = await load(entry);
  }
  const current = useThemes.getState().active;
  if (seq !== applySeq) return current ?? toActive(entry, resolved);
  const active = toActive(entry, resolved);
  editorSink?.(active.resolved, entry.id);
  useThemes.setState({ active });
  return active;
}

function toActive(entry: ThemeEntry, resolved: ResolvedTheme): ActiveTheme {
  const cssBase = cssBaseOf(entry);
  const cssVars = CSS_BASES.has(entry.id) ? {} : cssVarsForTheme({ ...resolved, uiTheme: entry.uiTheme });
  return {
    id: entry.id,
    label: entry.label,
    uiTheme: entry.uiTheme,
    cssBase,
    cssVars,
    terminal: terminalThemeFor({ ...resolved, uiTheme: entry.uiTheme }, cssVars["--panel-bg"]),
    resolved: { ...resolved, uiTheme: entry.uiTheme },
  };
}
