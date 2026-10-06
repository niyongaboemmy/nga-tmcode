/** Production React sources, served by the host's Vite plugin (see apps/desktop/build/reactVendorPlugin.ts). */
declare module "virtual:tmcode-react-vendor" {
  export const react: string;
  export const jsxRuntime: string;
  export const reactDom: string;
  export const reactDomClient: string;
  export const scheduler: string;
}

/** Monaco's Monarch definitions (no typings shipped); the textmate tokenizer falls back to them. */
declare module "monaco-editor/languages/definitions/*" {
  export const language: import("monaco-editor").languages.IMonarchLanguage;
  export const conf: import("monaco-editor").languages.LanguageConfiguration;
}

// Monaco internals used by the Outline pane (outline/OutlinePane.tsx).
declare module "monaco-editor/base/common/cancellation.js" {
  export const CancellationToken: { None: unknown };
}
declare module "monaco-editor/editor/contrib/documentSymbols/browser/outlineModel.js" {
  export const IOutlineModelService: unknown;
}
declare module "monaco-editor/editor/standalone/browser/standaloneServices.js" {
  export const StandaloneServices: { get(id: unknown): unknown };
}

// Formatter selection (monaco/formatters.ts): VS Code's FormattingConflicts hook and extension ids.
declare module "monaco-editor/editor/contrib/format/browser/format.js" {
  export const FormattingConflicts: {
    setFormatterSelector(selector: (formatters: unknown[], model: import("monaco-editor").editor.ITextModel, mode: number, kind: number) => Promise<unknown> | unknown): { dispose(): void };
  };
}
declare module "monaco-editor/platform/extensions/common/extensions.js" {
  export class ExtensionIdentifier {
    constructor(value: string);
    readonly value: string;
  }
}
declare module "monaco-editor/editor/common/services/languageFeatures.js" {
  export const ILanguageFeaturesService: unknown;
}
