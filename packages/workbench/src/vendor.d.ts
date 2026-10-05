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
