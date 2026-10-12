/** Web front-end (§13.8) and TMCode's built-in logic tables. */
import { kind } from "./kit";

export const WEB_KINDS = [
  kind({
    id: "web/static",
    language: "web",
    label: "Website (HTML, CSS, JavaScript)",
    runtime: "browser",
    wave: "A",
    detect: { anyOf: ["*.html", "*.htm"], none: ["package.json"], priority: 15 },
    entry: { default: "index.html" },
    steps: {},
    tier: "browser",
    preview: "static",
    notes: "TMCode's sandboxed Live Preview (signed token on the web).",
  }),
  kind({
    id: "web/react-cdn",
    language: "web",
    label: "React page (bundled in the browser)",
    runtime: "browser",
    wave: "A",
    detect: { files: ["index.html"], none: ["package.json"], contains: [{ file: "index.html", text: "<script\\b[^>]*\\bsrc\\s*=\\s*[\"'][^\"']+\\.(jsx|tsx)[\"']" }], priority: 20 },
    entry: { default: "index.html" },
    steps: {},
    tier: "browser",
    preview: "bundle-react",
    notes: "esbuild-wasm bundles the JSX in the browser (offline, also in exams).",
  }),
  kind({
    id: "logic/tables",
    language: "logic",
    label: "Logic – truth tables",
    runtime: "browser",
    wave: "A",
    detect: { anyOf: ["*.logic"], priority: 5 },
    entry: { default: "main.logic" },
    steps: {},
    tier: "browser",
    notes: "TMCode's built-in truth-table view (logic/).",
  }),
];
