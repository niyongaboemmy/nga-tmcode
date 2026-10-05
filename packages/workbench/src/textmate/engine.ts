import type * as vsctm from "vscode-textmate";
import { grammarFor, injectionsFor, type RawGrammarSource } from "./grammars";
import { decodeTokens } from "./themeData";

/**
 * VS Code's tokenization, without Monaco: vscode-textmate + Oniguruma (wasm).
 * One registry per set of grammars; the theme on the registry decides the
 * colour ids that tokenizeLine2 encodes into every token.
 */

type TextmateModule = typeof vsctm;
type OnigModule = typeof import("vscode-oniguruma");

export interface TextmateLibs {
  vsctm: TextmateModule;
  onig: OnigModule;
}

/** Loads the libraries and the Oniguruma wasm once. `wasm` supplies the bytes (bundled URL in the app, a file in tests). */
export async function loadTextmateLibs(wasm: () => Promise<ArrayBuffer | Response>): Promise<TextmateLibs> {
  const [vsctmMod, onigMod] = await Promise.all([import("vscode-textmate"), import("vscode-oniguruma")]);
  // CommonJS interop: the namespace may wrap the module in `default`.
  const vsctmLib = ((vsctmMod as unknown as { default?: TextmateModule }).default ?? vsctmMod) as TextmateModule;
  const onig = ((onigMod as unknown as { default?: OnigModule }).default ?? onigMod) as OnigModule;
  await onig.loadWASM(await wasm());
  return { vsctm: vsctmLib, onig };
}

function toRawGrammar(libs: TextmateLibs, src: RawGrammarSource): vsctm.IRawGrammar {
  if (src.kind === "object") return src.value as vsctm.IRawGrammar;
  // parseRawGrammar understands both JSON and TextMate plist (.tmLanguage) grammars.
  return libs.vsctm.parseRawGrammar(src.text, src.path);
}

const TOKEN_TYPES: Record<string, number> = { other: 0, comment: 1, string: 2, regex: 3 };

export class TextmateEngine {
  private registry: vsctm.Registry;
  private grammars = new Map<string, Promise<vsctm.IGrammar | null>>();
  readonly errors: string[] = [];

  constructor(private libs: TextmateLibs) {
    const onigLib: Promise<vsctm.IOnigLib> = Promise.resolve({
      createOnigScanner: (patterns: string[]) => new libs.onig.OnigScanner(patterns),
      createOnigString: (s: string) => new libs.onig.OnigString(s),
    });
    this.registry = new libs.vsctm.Registry({
      onigLib,
      loadGrammar: async (scopeName) => {
        const def = grammarFor(scopeName);
        if (!def) return null; // unknown embedded language: left uncoloured
        try {
          return toRawGrammar(libs, await def.load());
        } catch (e) {
          this.errors.push(`${scopeName}: ${String((e as Error)?.message ?? e)}`);
          return null;
        }
      },
      getInjections: (scopeName) => injectionsFor(scopeName),
    });
  }

  /** Sets the theme and returns the colour map (index = colour id in token metadata). */
  setTheme(raw: vsctm.IRawTheme): string[] {
    this.registry.setTheme(raw);
    return this.registry.getColorMap();
  }

  colorMap(): string[] {
    return this.registry.getColorMap();
  }

  grammar(scopeName: string): Promise<vsctm.IGrammar | null> {
    let g = this.grammars.get(scopeName);
    if (!g) {
      const def = grammarFor(scopeName);
      const tokenTypes: vsctm.ITokenTypeMap = {};
      for (const [sel, t] of Object.entries(def?.tokenTypes ?? {})) if (t in TOKEN_TYPES) tokenTypes[sel] = TOKEN_TYPES[t] as vsctm.ITokenTypeMap[string];
      g = this.registry.loadGrammarWithConfiguration(scopeName, 1, { tokenTypes });
      this.grammars.set(scopeName, g);
    }
    return g;
  }

  /** Tokenizes one line; Monaco-shaped tokens ("tm<color>.<fontStyle>[.kind]"). */
  tokenizeLine(grammar: vsctm.IGrammar, line: string, state: vsctm.StateStack | null, timeLimitMs = 500) {
    const r = grammar.tokenizeLine2(line, state ?? this.libs.vsctm.INITIAL, timeLimitMs);
    return { tokens: decodeTokens(r.tokens), endState: r.stoppedEarly ? (state ?? this.libs.vsctm.INITIAL) : r.ruleStack };
  }

  get initialState(): vsctm.StateStack {
    return this.libs.vsctm.INITIAL;
  }

  dispose() {
    this.registry.dispose();
  }
}
