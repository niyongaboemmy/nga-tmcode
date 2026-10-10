/**
 * settings.json, as VS Code reads it: JSON with comments, known keys checked
 * against the setting definitions, and language scopes such as
 * `"[python]": { "editor.tabSize": 4 }`. Also the read-only workspace overlay
 * from a folder's `.vscode/settings.json` (teachers' starter code). Pure
 * functions; the store applies the result.
 */
import { stripJsonc } from "../debug/launchJson";
import { DEFAULT_SETTINGS, SETTING_SECTIONS, type SettingDef, type SettingKey, type Settings } from "./settings";

export type LanguageOverrides = Record<string, Partial<Settings>>;

export interface SettingsIssue {
  severity: "error" | "warning";
  message: string;
  /** The JSON key the issue is about ("editor.tabSize", "[python]"…); none for syntax errors. */
  key?: string;
  /** Character offset in the text, when known. */
  offset?: number;
}

export interface ParsedSettings {
  /** Valid values of known settings. */
  values: Partial<Settings>;
  /** Valid language-scoped values, by Monaco language id. */
  languages: LanguageOverrides;
  /** Keys TMCode doesn't know (kept, so they survive a round trip, but unused). */
  other: Record<string, unknown>;
  issues: SettingsIssue[];
  /** The text could not be read as JSON at all: nothing should change. */
  syntaxError: boolean;
}

const DEFS = new Map<string, SettingDef>(SETTING_SECTIONS.flatMap((s) => s.settings.map((d) => [d.key, d] as const)));

export function settingDef(key: string): SettingDef | undefined {
  return DEFS.get(key);
}

export function isKnownSetting(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key);
}

/** Settings a `[language]` scope may change: the editor's, as in VS Code. */
export function isLanguageOverridable(key: string) {
  return isKnownSetting(key) && key.startsWith("editor.");
}

/** `[python]` or `[javascript][typescript]` → the language ids; null for any other key. */
export function languageScope(key: string): string[] | null {
  if (!/^(\[[^[\]]+\])+$/.test(key)) return null;
  return [...key.matchAll(/\[([^[\]]+)\]/g)].map((m) => m[1].trim()).filter(Boolean);
}

/** Why a value is not valid for a setting, or null when it is. */
export function validateValue(key: SettingKey, value: unknown): string | null {
  const def = DEFS.get(key);
  const expected = typeof DEFAULT_SETTINGS[key];
  if (!def) return typeof value === expected ? null : `Expected a ${expected}.`;
  switch (def.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "Expected true or false.";
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "Expected a number.";
      return value < def.min || value > def.max ? `Expected a number from ${def.min} to ${def.max}.` : null;
    case "string":
      return typeof value === "string" ? null : "Expected a string.";
    case "enum":
      if (typeof value !== "string") return "Expected a string.";
      // Theme lists depend on installed extensions: any id is accepted (an unknown one falls back to the default).
      if (def.dynamicOptions) return null;
      return def.options.some((o) => o.value === value) ? null : `Value is not accepted. Valid values: ${def.options.map((o) => JSON.stringify(o.value)).join(", ")}.`;
  }
}

/** Where `"key"` first appears as a property name (for markers). */
function offsetOfKey(text: string, key: string): number | undefined {
  const i = text.indexOf(`${JSON.stringify(key)}`);
  return i >= 0 ? i : undefined;
}

/** Reads settings.json text. Empty text = no settings. */
export function parseSettingsJson(text: string): ParsedSettings {
  const out: ParsedSettings = { values: {}, languages: {}, other: {}, issues: [], syntaxError: false };
  if (!text.trim()) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonc(text));
  } catch (e) {
    out.syntaxError = true;
    const m = /position (\d+)/.exec(String((e as Error)?.message));
    out.issues.push({ severity: "error", message: `This is not valid JSON: ${String((e as Error)?.message ?? e).replace(/^JSON\.parse: /, "")}`, offset: m ? Number(m[1]) : 0 });
    return out;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    out.syntaxError = true;
    out.issues.push({ severity: "error", message: "Settings must be an object: { \"editor.fontSize\": 14 }.", offset: 0 });
    return out;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const langs = languageScope(key);
    if (langs) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        out.issues.push({ severity: "error", key, message: `${key} must be an object of editor settings.`, offset: offsetOfKey(text, key) });
        continue;
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!isKnownSetting(k)) {
          out.issues.push({ severity: "warning", key: k, message: `Unknown setting "${k}". TMCode ignores it.`, offset: offsetOfKey(text, k) });
          continue;
        }
        if (!isLanguageOverridable(k)) {
          out.issues.push({ severity: "warning", key: k, message: `"${k}" can't be set per language. Put it outside ${key}.`, offset: offsetOfKey(text, k) });
          continue;
        }
        const problem = validateValue(k, v);
        if (problem) {
          out.issues.push({ severity: "error", key: k, message: `${k}: ${problem}`, offset: offsetOfKey(text, k) });
          continue;
        }
        for (const lang of langs) out.languages[lang] = { ...out.languages[lang], [k]: v };
      }
      continue;
    }
    if (!isKnownSetting(key)) {
      out.other[key] = value;
      out.issues.push({ severity: "warning", key, message: `Unknown setting "${key}". TMCode keeps it but doesn't use it.`, offset: offsetOfKey(text, key) });
      continue;
    }
    const problem = validateValue(key, value);
    if (problem) {
      out.issues.push({ severity: "error", key, message: `${key}: ${problem}`, offset: offsetOfKey(text, key) });
      continue;
    }
    (out.values as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** The settings that differ from the defaults, as settings.json text. */
export function stringifySettings(values: Partial<Settings>, languages: LanguageOverrides = {}, other: Record<string, unknown> = {}): string {
  const obj: Record<string, unknown> = {};
  for (const key of Object.keys(values).sort() as SettingKey[]) {
    if (values[key] !== undefined && values[key] !== DEFAULT_SETTINGS[key]) obj[key] = values[key];
  }
  for (const [k, v] of Object.entries(other)) obj[k] = v;
  for (const lang of Object.keys(languages).sort()) if (Object.keys(languages[lang]).length) obj[`[${lang}]`] = languages[lang];
  return `${JSON.stringify(obj, null, 4)}\n`;
}

/** Only the values that differ from the defaults (what the user really set). */
export function userDiff(settings: Settings): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const key of Object.keys(settings) as SettingKey[]) if (settings[key] !== DEFAULT_SETTINGS[key]) (out as Record<string, unknown>)[key] = settings[key];
  return out;
}

// ───────────── workspace overlay (.vscode/settings.json) ─────────────

export const WORKSPACE_SETTINGS_FILE = ".vscode/settings.json";

/** What a folder may set: how code looks and is saved, never the app, themes, updates or accounts. */
export const WORKSPACE_KEYS: SettingKey[] = [
  "editor.tabSize",
  "editor.insertSpaces",
  "editor.wordWrap",
  "editor.lineNumbers",
  "editor.renderWhitespace",
  "editor.minimap.enabled",
  "editor.bracketPairColorization.enabled",
  "editor.stickyScroll.enabled",
  "editor.formatOnSave",
  "files.autoSave",
  "files.autoSaveDelay",
  "livePreview.updateOn",
  "livePreview.followActiveFile",
  "run.openBrowserOnStart",
];

/**
 * During an exam a folder may only change layout (indentation, wrapping…):
 * never formatting help or saving, which the exam policy decides.
 */
export const EXAM_WORKSPACE_KEYS: SettingKey[] = ["editor.tabSize", "editor.insertSpaces", "editor.wordWrap", "editor.lineNumbers", "editor.renderWhitespace"];

export interface WorkspaceOverlay {
  values: Partial<Settings>;
  languages: LanguageOverrides;
  /** Keys in the file TMCode doesn't take from a folder, with why. */
  ignored: { key: string; reason: string }[];
  issues: SettingsIssue[];
}

export function workspaceOverlay(text: string, opts: { exam: boolean; locked: string[] }): WorkspaceOverlay {
  const parsed = parseSettingsJson(text);
  const allowed = opts.exam ? EXAM_WORKSPACE_KEYS : WORKSPACE_KEYS;
  const ignored: WorkspaceOverlay["ignored"] = [];
  const keep = (key: SettingKey) => {
    if (opts.locked.includes(key)) return "Locked by your teacher for this session.";
    if (!allowed.includes(key)) return opts.exam ? "Not taken from a folder during an exam." : "Only your own settings can change this.";
    return null;
  };
  const values: Partial<Settings> = {};
  for (const [k, v] of Object.entries(parsed.values) as [SettingKey, unknown][]) {
    const why = keep(k);
    if (why) ignored.push({ key: k, reason: why });
    else (values as Record<string, unknown>)[k] = v;
  }
  const languages: LanguageOverrides = {};
  for (const [lang, scoped] of Object.entries(parsed.languages)) {
    for (const [k, v] of Object.entries(scoped) as [SettingKey, unknown][]) {
      const why = keep(k);
      if (why) ignored.push({ key: `[${lang}] ${k}`, reason: why });
      else languages[lang] = { ...languages[lang], [k]: v };
    }
  }
  for (const k of Object.keys(parsed.other)) ignored.push({ key: k, reason: "TMCode doesn't have this setting." });
  return { values, languages, ignored, issues: parsed.issues };
}

/**
 * The settings an editor of `language` uses. Most specific wins, as in VS
 * Code: defaults < user < workspace < user [language] < workspace [language].
 * Locked keys keep the user value (the policy decides them).
 */
export function resolveSettings(
  user: Settings,
  userLanguages: LanguageOverrides,
  workspace: WorkspaceOverlay | null,
  language: string | null,
  locked: string[] = [],
): Settings {
  const out: Settings = { ...user, ...(workspace?.values ?? {}) };
  if (language) Object.assign(out, userLanguages[language] ?? {}, workspace?.languages[language] ?? {});
  for (const k of locked) if (isKnownSetting(k)) (out as unknown as Record<string, unknown>)[k] = user[k];
  return out;
}
