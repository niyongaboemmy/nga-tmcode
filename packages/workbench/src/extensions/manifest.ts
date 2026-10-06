import { parseJsonc } from "../textmate/jsonc";

/**
 * A VS Code extension's package.json, reduced to what TMCode can use: the
 * declarative contributions (colour and file icon themes, TextMate grammars,
 * languages, snippets), and for extensions with code (`main` / `browser`,
 * run by the extension host, exthost/*) their commands, menus, keybindings
 * and configuration.
 */

export interface ThemeContribution {
  id?: string;
  label: string;
  uiTheme: string;
  path: string;
}

export interface IconThemeContribution {
  id: string;
  label: string;
  path: string;
}

export interface GrammarContribution {
  language?: string;
  scopeName: string;
  path: string;
  embeddedLanguages?: Record<string, string>;
  tokenTypes?: Record<string, string>;
  injectTo?: string[];
}

export interface LanguageContribution {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
  firstLine?: string;
  mimetypes?: string[];
  configuration?: string;
}

export interface SnippetContribution {
  language: string;
  path: string;
}

export interface CommandContribution {
  command: string;
  title: string;
  category?: string;
  /** A codicon id ("$(sync)" → "sync"), or image paths inside the extension. */
  icon?: string | { light?: string; dark?: string };
  enablement?: string;
}

export interface MenuItemContribution {
  command: string;
  when?: string;
  group?: string;
  alt?: string;
}

export interface KeybindingContribution {
  command: string;
  key?: string;
  mac?: string;
  linux?: string;
  win?: string;
  when?: string;
  args?: unknown;
}

export interface ExtensionManifest {
  /** "publisher.name", lower-cased (VS Code ids are case-insensitive). */
  id: string;
  name: string;
  publisher: string;
  version: string;
  displayName: string;
  description: string;
  icon?: string;
  categories: string[];
  /** The extension ships code (`main` for Node.js, `browser` for a Web Worker). */
  hasCode: boolean;
  main?: string;
  browser?: string;
  /** package.json as parsed (the extension host's `packageJSON`). */
  raw: Record<string, unknown>;
  /** package.nls.json, for "%key%" strings in raw contributions (configuration titles…). */
  nls?: Nls;
  commands: CommandContribution[];
  /** Menu id ("editor/context", "editor/title", "commandPalette"…) → items. */
  menus: Record<string, MenuItemContribution[]>;
  keybindings: KeybindingContribution[];
  themes: ThemeContribution[];
  iconThemes: IconThemeContribution[];
  grammars: GrammarContribution[];
  languages: LanguageContribution[];
  snippets: SnippetContribution[];
  /** Contribution points TMCode ignores (commands, debuggers, …), for the details page. */
  unsupported: string[];
}

export const SUPPORTED_CONTRIBUTIONS = ["themes", "iconThemes", "grammars", "languages", "snippets"] as const;
/** Applied for extensions whose code runs (exthost). */
export const CODE_CONTRIBUTIONS = ["commands", "menus", "keybindings", "configuration", "configurationDefaults"] as const;

export type Nls = Record<string, string | { message?: string }>;

/** Replaces "%key%" placeholders with package.nls.json strings, as VS Code does. */
export function localize(value: unknown, nls?: Nls): string {
  if (typeof value !== "string") return "";
  const m = /^%(.+)%$/.exec(value);
  if (!m || !nls) return value;
  const hit = nls[m[1]];
  if (typeof hit === "string") return hit;
  if (hit && typeof hit.message === "string") return hit.message;
  return value;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
const record = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/** Paths inside the extension are relative to its root: "./themes/a.json" → "themes/a.json". */
export function normalizeExtensionPath(p: string): string | undefined {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return undefined; // never outside the extension
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : undefined;
}

/** Parses package.json (JSONC tolerated). Throws when it is not an extension manifest. */
export function parseManifest(text: string, nls?: Nls): ExtensionManifest {
  const raw = parseJsonc<Record<string, unknown>>(text);
  if (!raw || typeof raw !== "object") throw new Error("package.json is not an object");
  const name = str(raw.name);
  const publisher = str(raw.publisher);
  if (!name || !publisher) throw new Error("package.json has no name or publisher");
  const c = (raw.contributes && typeof raw.contributes === "object" ? raw.contributes : {}) as Record<string, unknown>;
  const path = (v: unknown) => (typeof v === "string" ? normalizeExtensionPath(v) : undefined);

  const themes: ThemeContribution[] = [];
  for (const t of list(c.themes)) {
    const p = path(t.path);
    if (!p) continue;
    const label = localize(t.label, nls) || localize(t.id, nls) || p;
    themes.push({ id: str(t.id), label, uiTheme: str(t.uiTheme) ?? "vs-dark", path: p });
  }
  const iconThemes: IconThemeContribution[] = [];
  for (const t of list(c.iconThemes)) {
    const p = path(t.path);
    const id = str(t.id);
    if (!p || !id) continue;
    iconThemes.push({ id, label: localize(t.label, nls) || id, path: p });
  }
  const grammars: GrammarContribution[] = [];
  for (const g of list(c.grammars)) {
    const p = path(g.path);
    const scopeName = str(g.scopeName);
    if (!p || !scopeName) continue;
    grammars.push({ language: str(g.language), scopeName, path: p, embeddedLanguages: record(g.embeddedLanguages), tokenTypes: record(g.tokenTypes), injectTo: strs(g.injectTo) });
  }
  const languages: LanguageContribution[] = [];
  for (const l of list(c.languages)) {
    const id = str(l.id);
    if (!id) continue;
    languages.push({
      id,
      aliases: strs(l.aliases)?.map((a) => localize(a, nls)),
      extensions: strs(l.extensions),
      filenames: strs(l.filenames),
      filenamePatterns: strs(l.filenamePatterns),
      firstLine: str(l.firstLine),
      mimetypes: strs(l.mimetypes),
      configuration: path(l.configuration),
    });
  }
  const snippets: SnippetContribution[] = [];
  for (const s of list(c.snippets)) {
    const p = path(s.path);
    const language = str(s.language);
    if (p && language) snippets.push({ language, path: p });
  }

  const commands: CommandContribution[] = [];
  for (const cmd of list(c.commands)) {
    const command = str(cmd.command);
    if (!command) continue;
    const rawIcon = cmd.icon;
    let icon: CommandContribution["icon"];
    if (typeof rawIcon === "string") icon = /^\$\((.+)\)$/.exec(rawIcon)?.[1] ?? path(rawIcon);
    else if (rawIcon && typeof rawIcon === "object") icon = { light: path((rawIcon as Record<string, unknown>).light), dark: path((rawIcon as Record<string, unknown>).dark) };
    commands.push({ command, title: localize(cmd.title, nls) || command, category: localize(cmd.category, nls) || undefined, icon, enablement: str(cmd.enablement) });
  }
  const menus: Record<string, MenuItemContribution[]> = {};
  if (c.menus && typeof c.menus === "object") {
    for (const [menu, items] of Object.entries(c.menus as Record<string, unknown>)) {
      const parsed = list(items).flatMap((m) => (str(m.command) ? [{ command: str(m.command)!, when: str(m.when), group: str(m.group), alt: str(m.alt) }] : []));
      if (parsed.length) menus[menu] = parsed;
    }
  }
  const keybindings: KeybindingContribution[] = [];
  for (const k of Array.isArray(c.keybindings) ? list(c.keybindings) : c.keybindings && typeof c.keybindings === "object" ? [c.keybindings as Record<string, unknown>] : []) {
    const command = str(k.command);
    if (command) keybindings.push({ command, key: str(k.key), mac: str(k.mac), linux: str(k.linux), win: str(k.win), when: str(k.when), args: k.args });
  }

  return {
    id: `${publisher}.${name}`.toLowerCase(),
    name,
    publisher,
    version: str(raw.version) ?? "0.0.0",
    displayName: localize(raw.displayName, nls) || name,
    description: localize(raw.description, nls),
    icon: path(raw.icon),
    categories: strs(raw.categories) ?? [],
    hasCode: !!(str(raw.main) || str(raw.browser)),
    main: str(raw.main),
    browser: str(raw.browser),
    raw,
    nls,
    commands,
    menus,
    keybindings,
    themes,
    iconThemes,
    grammars,
    languages,
    snippets,
    unsupported: Object.keys(c).filter((k) => !(SUPPORTED_CONTRIBUTIONS as readonly string[]).includes(k) && !((raw.main || raw.browser) && (CODE_CONTRIBUTIONS as readonly string[]).includes(k))),
  };
}

/** One-line summary of what TMCode applies from an extension ("2 color themes, 1 language"). */
export function contributionSummary(m: ExtensionManifest): string[] {
  const n = (count: number, one: string, many: string) => (count ? [`${count} ${count === 1 ? one : many}`] : []);
  return [
    ...n(m.themes.length, "color theme", "color themes"),
    ...n(m.iconThemes.length, "file icon theme", "file icon themes"),
    ...n(m.languages.length, "language", "languages"),
    ...n(m.grammars.length, "grammar", "grammars"),
    ...n(m.snippets.length, "snippet file", "snippet files"),
  ];
}

/** True when nothing in the extension can take effect in TMCode. */
export function hasNoUsableParts(m: ExtensionManifest): boolean {
  return !m.themes.length && !m.iconThemes.length && !m.grammars.length && !m.languages.length && !m.snippets.length;
}

// ───────────── language-configuration.json ─────────────

type RegexLike = string | { pattern?: string; flags?: string } | undefined;

function toRegExp(v: unknown): RegExp | undefined {
  const r = v as RegexLike;
  try {
    if (typeof r === "string") return new RegExp(r);
    if (r && typeof r === "object" && typeof r.pattern === "string") return new RegExp(r.pattern, r.flags);
  } catch {
    /* invalid pattern: ignored, as VS Code does */
  }
  return undefined;
}

type Pair = { open: string; close: string; notIn?: string[] };

function pairs(v: unknown): Pair[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Pair[] = [];
  for (const p of v) {
    if (Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string") out.push({ open: p[0], close: p[1] });
    else if (p && typeof p === "object" && typeof p.open === "string" && typeof p.close === "string") {
      const notIn = typeof p.notIn === "string" ? [p.notIn] : strs(p.notIn);
      out.push({ open: p.open, close: p.close, ...(notIn ? { notIn } : {}) });
    }
  }
  return out;
}

/** Monaco's LanguageConfiguration, structurally (no Monaco import, so it is unit-testable). */
export interface LanguageConfig {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  autoClosingPairs?: Pair[];
  surroundingPairs?: Pair[];
  wordPattern?: RegExp;
  folding?: { offSide?: boolean; markers?: { start: RegExp; end: RegExp } };
  indentationRules?: { increaseIndentPattern: RegExp; decreaseIndentPattern: RegExp; indentNextLinePattern?: RegExp; unIndentedLinePattern?: RegExp };
  onEnterRules?: { beforeText: RegExp; afterText?: RegExp; previousLineText?: RegExp; action: { indentAction: number; appendText?: string; removeText?: number } }[];
}

const INDENT_ACTIONS: Record<string, number> = { none: 0, indent: 1, indentoutdent: 2, outdent: 3 };

/** VS Code's language-configuration.json (JSONC, regexes as strings) → Monaco's shape. */
export function parseLanguageConfiguration(text: string): LanguageConfig {
  const raw = parseJsonc<Record<string, unknown>>(text) ?? {};
  const out: LanguageConfig = {};
  const comments = raw.comments as Record<string, unknown> | undefined;
  if (comments && typeof comments === "object") {
    const block = comments.blockComment;
    out.comments = {
      ...(typeof comments.lineComment === "string" ? { lineComment: comments.lineComment } : {}),
      ...(Array.isArray(block) && typeof block[0] === "string" && typeof block[1] === "string" ? { blockComment: [block[0], block[1]] as [string, string] } : {}),
    };
  }
  if (Array.isArray(raw.brackets)) out.brackets = raw.brackets.filter((b): b is [string, string] => Array.isArray(b) && typeof b[0] === "string" && typeof b[1] === "string").map((b) => [b[0], b[1]]);
  const ac = pairs(raw.autoClosingPairs);
  if (ac) out.autoClosingPairs = ac;
  const sp = pairs(raw.surroundingPairs);
  if (sp) out.surroundingPairs = sp;
  const wp = toRegExp(raw.wordPattern);
  if (wp) out.wordPattern = wp;
  const folding = raw.folding as Record<string, unknown> | undefined;
  if (folding && typeof folding === "object") {
    const markers = folding.markers as Record<string, unknown> | undefined;
    const start = toRegExp(markers?.start);
    const end = toRegExp(markers?.end);
    out.folding = { ...(typeof folding.offSide === "boolean" ? { offSide: folding.offSide } : {}), ...(start && end ? { markers: { start, end } } : {}) };
  }
  const ir = raw.indentationRules as Record<string, unknown> | undefined;
  if (ir && typeof ir === "object") {
    const inc = toRegExp(ir.increaseIndentPattern);
    const dec = toRegExp(ir.decreaseIndentPattern);
    if (inc && dec) {
      const next = toRegExp(ir.indentNextLinePattern);
      const un = toRegExp(ir.unIndentedLinePattern);
      out.indentationRules = { increaseIndentPattern: inc, decreaseIndentPattern: dec, ...(next ? { indentNextLinePattern: next } : {}), ...(un ? { unIndentedLinePattern: un } : {}) };
    }
  }
  if (Array.isArray(raw.onEnterRules)) {
    const rules: NonNullable<LanguageConfig["onEnterRules"]> = [];
    for (const r of list(raw.onEnterRules)) {
      const beforeText = toRegExp(r.beforeText);
      const action = r.action as Record<string, unknown> | undefined;
      const indent = typeof action?.indent === "string" ? INDENT_ACTIONS[action.indent.toLowerCase()] : undefined;
      if (!beforeText || indent === undefined) continue;
      const afterText = toRegExp(r.afterText);
      const previousLineText = toRegExp(r.previousLineText);
      rules.push({
        beforeText,
        ...(afterText ? { afterText } : {}),
        ...(previousLineText ? { previousLineText } : {}),
        action: { indentAction: indent, ...(typeof action?.appendText === "string" ? { appendText: action.appendText } : {}), ...(typeof action?.removeText === "number" ? { removeText: action.removeText } : {}) },
      });
    }
    if (rules.length) out.onEnterRules = rules;
  }
  return out;
}

// ───────────── snippets ─────────────

export interface Snippet {
  name: string;
  prefixes: string[];
  body: string;
  description?: string;
  /** Set for global .code-snippets files that name their languages. */
  scope?: string[];
}

/** A VS Code snippets file (JSONC: name → {prefix, body, description, scope}). */
export function parseSnippets(text: string): Snippet[] {
  const raw = parseJsonc<Record<string, unknown>>(text);
  if (!raw || typeof raw !== "object") return [];
  const out: Snippet[] = [];
  for (const [name, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>;
    const prefixes = typeof s.prefix === "string" ? [s.prefix] : (strs(s.prefix) ?? []);
    const body = typeof s.body === "string" ? s.body : Array.isArray(s.body) ? s.body.filter((x) => typeof x === "string").join("\n") : null;
    if (!prefixes.length || body === null) continue;
    const description = typeof s.description === "string" ? s.description : Array.isArray(s.description) ? s.description.join("\n") : undefined;
    const scope = typeof s.scope === "string" ? s.scope.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
    out.push({ name, prefixes, body, ...(description ? { description } : {}), ...(scope?.length ? { scope } : {}) });
  }
  return out;
}
