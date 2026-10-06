import * as monaco from "monaco-editor";
import type * as vsctm from "vscode-textmate";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import { log } from "../state/store";
import { setEditorThemeSink } from "../themes/themeService";
import { TextmateEngine, loadTextmateLibs, type TextmateLibs } from "./engine";
import { EXTRA_LANGUAGES, grammarsVersion, scopeForLanguage, tmLanguages } from "./grammars";
import { monacoThemeData, rawThemeOf, type ResolvedTheme } from "./themeData";

/**
 * Colours Monaco like VS Code: TextMate grammars tokenized by vscode-textmate
 * (Oniguruma in wasm, bundled), coloured by the active VS Code theme. Every
 * token's type is "tm<colourId>.<fontStyle>", and the Monaco theme gets one
 * rule per colour id of the textmate colour map (themeData.monacoTokenRules).
 * Monaco's language workers (TypeScript, HTML, CSS, JSON) are untouched.
 *
 * Grammars and the wasm load lazily, the first time a language is tokenized.
 * If the wasm or a grammar fails, that language falls back to Monaco's Monarch
 * tokenizer (and the reason goes to the Output view).
 */

class TmState implements monaco.languages.IState {
  constructor(readonly stack: vsctm.StateStack) {}
  clone() {
    return this; // StateStack is immutable
  }
  equals(other: monaco.languages.IState) {
    return other instanceof TmState && (other.stack === this.stack || other.stack.equals(this.stack));
  }
}

/** Very long lines (minified files) are not tokenized, as in VS Code (editor.maxTokenizationLineLength). */
const MAX_LINE = 20_000;

let libs: Promise<TextmateLibs> | null = null;
let engine: TextmateEngine | null = null;
let engineVersion = -1;
let activeTheme: ResolvedTheme | null = null;
let activeThemeId = "";
let monacoThemeName = "vs-dark";
let themeSeq = 0;
let failure: string | null = null;
const resolved = new Set<string>();
const factories = new Set<string>();

/** Name of the Monaco theme currently applied (editors created later use it). */
export function currentMonacoTheme() {
  return monacoThemeName;
}

/** For the self-test and the Output view. */
export function textmateStatus() {
  return { ready: !!engine, failure, languages: [...resolved], grammarErrors: engine?.errors ?? [] };
}

function defineAndApplyTheme() {
  if (!activeTheme) return;
  const colorMap = engine ? engine.setTheme(rawThemeOf(activeTheme) as vsctm.IRawTheme) : null;
  const name = `tm-${activeThemeId.replace(/[^a-z0-9-]/gi, "-")}-${++themeSeq}`;
  monaco.editor.defineTheme(name, monacoThemeData(activeTheme, colorMap) as monaco.editor.IStandaloneThemeData);
  monaco.editor.setTheme(name);
  monacoThemeName = name;
}

async function getEngine(): Promise<TextmateEngine> {
  if (failure) throw new Error(failure);
  libs ??= loadTextmateLibs(() => fetch(onigWasmUrl)).catch((e) => {
    failure = `could not load the Oniguruma wasm: ${String((e as Error)?.message ?? e)}`;
    log("Editor", `TextMate tokenization is unavailable (${failure}); using Monaco's built-in colouring.`, "warn");
    throw e;
  });
  const l = await libs;
  if (!engine || engineVersion !== grammarsVersion()) {
    const old = engine;
    engine = new TextmateEngine(l);
    engineVersion = grammarsVersion();
    defineAndApplyTheme();
    if (old) setTimeout(() => old.dispose(), 0);
  }
  return engine;
}

function makeProvider(eng: TextmateEngine, grammar: vsctm.IGrammar): monaco.languages.TokensProvider {
  return {
    getInitialState: () => new TmState(eng.initialState),
    tokenize(line, state) {
      const st = state as TmState;
      if (line.length > MAX_LINE) return { tokens: [{ startIndex: 0, scopes: "" }], endState: st };
      const r = eng.tokenizeLine(grammar, line, st.stack);
      return { tokens: r.tokens, endState: r.endState === st.stack ? st : new TmState(r.endState) };
    },
  };
}

async function createProvider(languageId: string): Promise<monaco.languages.TokensProvider | monaco.languages.IMonarchLanguage | null> {
  const scope = scopeForLanguage(languageId);
  try {
    if (!scope) throw new Error("no grammar");
    const eng = await getEngine();
    const grammar = await eng.grammar(scope);
    if (!grammar) throw new Error(`grammar ${scope} did not load${eng.errors.length ? ` (${eng.errors[eng.errors.length - 1]})` : ""}`);
    resolved.add(languageId);
    return makeProvider(eng, grammar);
  } catch (e) {
    if (!failure) log("Editor", `TextMate colouring for '${languageId}' failed (${String((e as Error)?.message ?? e)}); using Monaco's built-in colouring.`, "warn");
    return monarchFallback(languageId);
  }
}

function registerFactory(languageId: string) {
  if (factories.has(languageId)) return;
  factories.add(languageId);
  monaco.languages.registerTokensProviderFactory(languageId, { create: () => createProvider(languageId) });
}

let installed = false;
/** Called once from setupMonaco, before any model exists (so no Monarch tokenizer has been created yet). */
export function installTextmate() {
  if (installed) return;
  installed = true;
  // Monaco's JSON mode brings its own tokenizer; the textmate one replaces it.
  const json = monaco.json.jsonDefaults;
  json.setModeConfiguration({ ...json.modeConfiguration, tokens: false });
  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
  for (const l of EXTRA_LANGUAGES) if (!known.has(l.id)) monaco.languages.register(l);
  for (const lang of tmLanguages()) registerFactory(lang);
  setEditorThemeSink((theme, id) => {
    activeTheme = theme;
    activeThemeId = id;
    defineAndApplyTheme();
  });
}

/**
 * Grammars changed (extension installed/enabled/removed): a fresh registry,
 * and every language already coloured gets a new tokenizer (Monaco then
 * re-tokenizes its open models).
 */
export async function refreshTextmate() {
  for (const lang of tmLanguages()) {
    if (!monaco.languages.getLanguages().some((l) => l.id === lang)) continue;
    registerFactory(lang);
  }
  if (!engine) return;
  const langs = [...resolved];
  resolved.clear();
  for (const lang of langs) {
    const provider = await createProvider(lang);
    if (provider && "tokenize" in provider) monaco.languages.setTokensProvider(lang, provider as monaco.languages.TokensProvider);
    else if (provider) monaco.languages.setMonarchTokensProvider(lang, provider as monaco.languages.IMonarchLanguage);
  }
  // Languages that are now coloured but were not before (new grammar for an already-open language).
  for (const lang of tmLanguages()) {
    if (resolved.has(lang) || langs.includes(lang)) continue;
    if (!monaco.editor.getModels().some((m) => m.getLanguageId() === lang)) continue;
    const provider = await createProvider(lang);
    if (provider && "tokenize" in provider) monaco.languages.setTokensProvider(lang, provider as monaco.languages.TokensProvider);
  }
}

/** Registers a language an extension contributes, so its grammar has a tokenizer. */
export function ensureTextmateLanguage(languageId: string) {
  registerFactory(languageId);
}

type MonarchModule = { language: monaco.languages.IMonarchLanguage };
const MONARCH: Record<string, () => Promise<MonarchModule>> = {
  python: () => import("monaco-editor/languages/definitions/python/python"),
  javascript: () => import("monaco-editor/languages/definitions/javascript/javascript"),
  typescript: () => import("monaco-editor/languages/definitions/typescript/typescript"),
  html: () => import("monaco-editor/languages/definitions/html/html"),
  css: () => import("monaco-editor/languages/definitions/css/css"),
  scss: () => import("monaco-editor/languages/definitions/scss/scss"),
  less: () => import("monaco-editor/languages/definitions/less/less"),
  markdown: () => import("monaco-editor/languages/definitions/markdown/markdown"),
  c: () => import("monaco-editor/languages/definitions/cpp/cpp"),
  cpp: () => import("monaco-editor/languages/definitions/cpp/cpp"),
  java: () => import("monaco-editor/languages/definitions/java/java"),
  php: () => import("monaco-editor/languages/definitions/php/php"),
  sql: () => import("monaco-editor/languages/definitions/sql/sql"),
  shell: () => import("monaco-editor/languages/definitions/shell/shell"),
  yaml: () => import("monaco-editor/languages/definitions/yaml/yaml"),
  xml: () => import("monaco-editor/languages/definitions/xml/xml"),
  go: () => import("monaco-editor/languages/definitions/go/go"),
  rust: () => import("monaco-editor/languages/definitions/rust/rust"),
  csharp: () => import("monaco-editor/languages/definitions/csharp/csharp"),
};

async function monarchFallback(languageId: string): Promise<monaco.languages.IMonarchLanguage | null> {
  if (languageId === "json") {
    // Give the JSON mode its own tokenizer back.
    const json = monaco.json.jsonDefaults;
    setTimeout(() => json.setModeConfiguration({ ...json.modeConfiguration, tokens: true }), 0);
    return null;
  }
  const load = MONARCH[languageId];
  if (!load) return null;
  try {
    return (await load()).language;
  } catch {
    return null;
  }
}
