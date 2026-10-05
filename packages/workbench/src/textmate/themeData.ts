import { parseJsonc } from "./jsonc";

/**
 * VS Code colour themes as data: loading a theme file (with its `include`
 * chain, JSONC, tokenColors from a separate file), and converting a resolved
 * theme into what vscode-textmate and Monaco need. No Monaco or wasm imports
 * here, so it is cheap to load and easy to unit test.
 */

export type UiTheme = "vs" | "vs-dark" | "hc-black" | "hc-light";

export interface TokenColorRule {
  name?: string;
  scope?: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

export interface ResolvedTheme {
  name: string;
  uiTheme: UiTheme;
  /** Workbench + editor colours by VS Code key ("editor.background", "sideBar.background", …). */
  colors: Record<string, string>;
  tokenColors: TokenColorRule[];
}

interface ThemeFile {
  name?: string;
  type?: string;
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: TokenColorRule[] | string;
  /** Old TextMate .tmTheme (plist) shape. */
  settings?: TokenColorRule[];
}

/** Reads a theme-relative file as text; `parsePlist` turns .tmTheme XML into an object. */
export interface ThemeReader {
  read(path: string): Promise<string>;
  parsePlist?(text: string, path: string): unknown;
}

export function uiThemeOf(type: string | undefined, fallback: UiTheme = "vs-dark"): UiTheme {
  switch ((type ?? "").toLowerCase()) {
    case "light":
    case "vs":
      return "vs";
    case "dark":
    case "vs-dark":
      return "vs-dark";
    case "hc":
    case "hc-black":
    case "hcdark":
      return "hc-black";
    case "hc-light":
    case "hclight":
      return "hc-light";
    default:
      return fallback;
  }
}

export function isDarkUi(ui: UiTheme) {
  return ui === "vs-dark" || ui === "hc-black";
}

/** Joins a relative path onto the folder of `from` ("themes/a.json" + "./b.json" → "themes/b.json"). */
export function resolveRelative(from: string, rel: string): string {
  if (rel.startsWith("/")) rel = rel.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function parseThemeText(text: string, path: string, reader: ThemeReader): ThemeFile {
  if (/\.(tmTheme|plist|xml)$/i.test(path) || /^\s*</.test(text)) {
    if (!reader.parsePlist) throw new Error(`Cannot read ${path}: TextMate plist themes need the plist parser`);
    return reader.parsePlist(text, path) as ThemeFile;
  }
  return parseJsonc<ThemeFile>(text);
}

/**
 * Loads a theme file the way VS Code does: included themes first (recursively),
 * then this file's colours and token rules on top. Guards against include cycles.
 */
export async function loadThemeFile(path: string, reader: ThemeReader, uiFallback: UiTheme = "vs-dark", seen = new Set<string>()): Promise<ResolvedTheme> {
  if (seen.has(path) || seen.size > 16) throw new Error(`Theme include cycle at ${path}`);
  seen.add(path);
  const file = parseThemeText(await reader.read(path), path, reader);
  let base: ResolvedTheme = { name: "", uiTheme: uiThemeOf(file.type, uiFallback), colors: {}, tokenColors: [] };
  if (file.include) base = await loadThemeFile(resolveRelative(path, file.include), reader, uiFallback, seen);
  let rules: TokenColorRule[] = [];
  if (typeof file.tokenColors === "string") {
    const tcPath = resolveRelative(path, file.tokenColors);
    const tc = parseThemeText(await reader.read(tcPath), tcPath, reader);
    rules = Array.isArray(tc) ? (tc as TokenColorRule[]) : (tc.settings ?? (Array.isArray(tc.tokenColors) ? tc.tokenColors : []));
  } else if (Array.isArray(file.tokenColors)) rules = file.tokenColors;
  else if (Array.isArray(file.settings)) rules = file.settings;
  return {
    name: file.name ?? base.name,
    uiTheme: file.type ? uiThemeOf(file.type, uiFallback) : base.uiTheme,
    colors: { ...base.colors, ...(file.colors ?? {}) },
    tokenColors: [...base.tokenColors, ...rules.filter((r) => r && typeof r === "object" && r.settings)],
  };
}

// ───────────── colours ─────────────

/** "#abc" / "#ABCD" / "#aabbcc" / "#aabbccdd" → upper-case "#RRGGBB[AA]", else null. */
export function normalizeHex(c: unknown): string | null {
  if (typeof c !== "string") return null;
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map((x) => x + x).join("");
  return `#${h.toUpperCase()}`;
}

/** Monaco token colours are opaque "RRGGBB"; alpha is dropped (Monaco does the same). */
function opaque(c: string | null | undefined): string | null {
  const n = normalizeHex(c);
  return n ? n.slice(1, 7) : null;
}

const DEFAULT_FG: Record<UiTheme, string> = { "vs-dark": "#D4D4D4", vs: "#000000", "hc-black": "#FFFFFF", "hc-light": "#292929" };
const DEFAULT_BG: Record<UiTheme, string> = { "vs-dark": "#1E1E1E", vs: "#FFFFFF", "hc-black": "#000000", "hc-light": "#FFFFFF" };

/** The theme as vscode-textmate's IRawTheme: a default rule from the editor colours, then the token rules. */
export function rawThemeOf(theme: ResolvedTheme) {
  const fg = normalizeHex(theme.colors["editor.foreground"]) ?? DEFAULT_FG[theme.uiTheme];
  const bg = normalizeHex(theme.colors["editor.background"]) ?? DEFAULT_BG[theme.uiTheme];
  const settings = theme.tokenColors.map((r) => {
    const s: TokenColorRule["settings"] = {};
    const f = normalizeHex(r.settings.foreground);
    const b = normalizeHex(r.settings.background);
    if (f) s.foreground = f;
    if (b) s.background = b;
    if (typeof r.settings.fontStyle === "string") s.fontStyle = r.settings.fontStyle;
    return { scope: r.scope, settings: s };
  });
  return { name: theme.name, settings: [{ settings: { foreground: fg, background: bg } }, ...settings] };
}

// ───────────── tokens: vscode-textmate metadata → Monaco token types ─────────────

/** Bit layout of vscode-textmate's encoded token attributes (same as VS Code's MetadataConsts). */
const TOKEN_TYPE_MASK = 0b11_0000_0000;
const TOKEN_TYPE_OFFSET = 8;
const FONT_STYLE_MASK = 0b111_1000_0000_0000;
const FONT_STYLE_OFFSET = 11;
const FOREGROUND_MASK = 0b1111_1111_1000_0000_0000_0000;
const FOREGROUND_OFFSET = 15;

const STANDARD = ["", "comment", "string", "regex"];

/**
 * Monaco token type for one token: "tm<colorId>.<fontStyle>[.comment|.string|.regex]".
 * The colour id indexes the textmate colour map of the active theme; the
 * suffix keeps Monaco's bracket matching and auto-closing aware of comments and strings.
 */
export function tokenTypeOf(metadata: number): string {
  const fg = (metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
  const fs = (metadata & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;
  const std = STANDARD[(metadata & TOKEN_TYPE_MASK) >>> TOKEN_TYPE_OFFSET];
  return `tm${fg}.${fs}${std ? `.${std}` : ""}`;
}

/** tokenizeLine2's [start, metadata, start, metadata, …] → Monaco IToken[] (adjacent equal types merged). */
export function decodeTokens(tokens: Uint32Array): { startIndex: number; scopes: string }[] {
  const out: { startIndex: number; scopes: string }[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const scopes = tokenTypeOf(tokens[i + 1]);
    if (out.length && out[out.length - 1].scopes === scopes) continue;
    out.push({ startIndex: tokens[i], scopes });
  }
  return out;
}

export function fontStyleName(fs: number): string {
  const parts: string[] = [];
  if (fs & 1) parts.push("italic");
  if (fs & 2) parts.push("bold");
  if (fs & 4) parts.push("underline");
  if (fs & 8) parts.push("strikethrough");
  return parts.join(" ");
}

export interface MonacoTokenRule {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

/**
 * One rule per colour id ("tm5" → colour 5) plus one per colour × font style
 * ("tm5.1" → colour 5, italic). Monaco matches token types by dot-separated
 * prefix, so "tm5.0.comment" falls back to "tm5".
 */
export function monacoTokenRules(colorMap: readonly string[]): MonacoTokenRule[] {
  const rules: MonacoTokenRule[] = [];
  for (let id = 1; id < colorMap.length; id++) {
    const fg = opaque(colorMap[id]);
    if (!fg) continue;
    rules.push({ token: `tm${id}`, foreground: fg });
    for (let fs = 1; fs < 16; fs++) rules.push({ token: `tm${id}.${fs}`, foreground: fg, fontStyle: fontStyleName(fs) });
  }
  return rules;
}

// ───────────── Monarch fallback colours ─────────────

/** Scope that best describes a Monarch token, to colour Monarch-tokenized languages with the same theme. */
const MONARCH_SCOPES: Record<string, string> = {
  comment: "comment",
  "comment.doc": "comment.block.documentation",
  string: "string",
  "string.escape": "constant.character.escape",
  "string.key.json": "support.type.property-name.json",
  "string.value.json": "string.quoted.double.json",
  keyword: "keyword",
  "keyword.flow": "keyword.control",
  "keyword.control": "keyword.control",
  number: "constant.numeric",
  "number.hex": "constant.numeric",
  "number.float": "constant.numeric",
  regexp: "string.regexp",
  type: "entity.name.type",
  "type.identifier": "entity.name.type",
  tag: "entity.name.tag",
  "attribute.name": "entity.other.attribute-name",
  "attribute.value": "string",
  delimiter: "punctuation",
  operator: "keyword.operator",
  variable: "variable",
  "variable.predefined": "variable.language",
  "variable.parameter": "variable.parameter",
  constant: "constant.language",
  predefined: "support.function",
  annotation: "meta.decorator",
  metatag: "punctuation.definition.tag",
  emphasis: "markup.italic",
  strong: "markup.bold",
  identifier: "variable",
};

/** How well a theme rule's selector list matches one scope (0 = no match); deeper selectors win. */
function selectorScore(scope: string, selectors: string | string[] | undefined): number {
  if (selectors === undefined) return 0;
  const list = (Array.isArray(selectors) ? selectors : selectors.split(",")).map((s) => s.trim()).filter(Boolean);
  let best = 0;
  for (const sel of list) {
    if (sel.includes(" ")) continue; // descendant selectors need a scope path
    if (scope === sel || scope.startsWith(`${sel}.`)) best = Math.max(best, sel.split(".").length);
  }
  return best;
}

/** Foreground and font style a theme gives a single scope (simplified TextMate matching, later rules win ties). */
export function matchScope(theme: ResolvedTheme, scope: string): { foreground?: string; fontStyle?: string } {
  let fg: { score: number; value: string } | null = null;
  let fs: { score: number; value: string } | null = null;
  for (const r of theme.tokenColors) {
    const score = selectorScore(scope, r.scope);
    if (!score) continue;
    const f = normalizeHex(r.settings.foreground);
    if (f && (!fg || score >= fg.score)) fg = { score, value: f };
    if (typeof r.settings.fontStyle === "string" && (!fs || score >= fs.score)) fs = { score, value: r.settings.fontStyle };
  }
  return { foreground: fg?.value, fontStyle: fs?.value };
}

export function monarchRules(theme: ResolvedTheme): MonacoTokenRule[] {
  const rules: MonacoTokenRule[] = [];
  for (const [token, scope] of Object.entries(MONARCH_SCOPES)) {
    const m = matchScope(theme, scope);
    const fg = opaque(m.foreground);
    if (!fg && m.fontStyle === undefined) continue;
    rules.push({ token, ...(fg ? { foreground: fg } : {}), ...(m.fontStyle !== undefined ? { fontStyle: m.fontStyle.trim() } : {}) });
  }
  return rules;
}

/** Workbench colours Monaco understands: only valid hex values (Monaco rejects anything else). */
export function monacoColors(theme: ResolvedTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.colors)) {
    const n = normalizeHex(v);
    if (n) out[k] = n;
  }
  return out;
}

export function monacoBase(ui: UiTheme): "vs" | "vs-dark" | "hc-black" | "hc-light" {
  return ui;
}

/** Full Monaco theme data for a resolved theme and textmate colour map (null before textmate is ready). */
export function monacoThemeData(theme: ResolvedTheme, colorMap: readonly string[] | null) {
  const fg = opaque(theme.colors["editor.foreground"]) ?? opaque(DEFAULT_FG[theme.uiTheme])!;
  const bg = opaque(theme.colors["editor.background"]) ?? opaque(DEFAULT_BG[theme.uiTheme])!;
  return {
    base: monacoBase(theme.uiTheme),
    inherit: true,
    rules: [{ token: "", foreground: fg, background: bg }, ...monarchRules(theme), ...(colorMap ? monacoTokenRules(colorMap) : [])],
    colors: monacoColors(theme),
  };
}
