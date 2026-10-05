import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);
const pkg = (name: string) => dirname(require.resolve(`${name}/package.json`));

const FILES = {
  react: ["react", "cjs/react.production.js"],
  jsxRuntime: ["react", "cjs/react-jsx-runtime.production.js"],
  reactDom: ["react-dom", "cjs/react-dom.production.js"],
  reactDomClient: ["react-dom", "cjs/react-dom-client.production.js"],
  scheduler: ["scheduler", "cjs/scheduler.production.js"],
} as const;

const ID = "virtual:tmcode-react-vendor";

/**
 * Serves the production React sources the preview bundler compiles student
 * React apps against, as `virtual:tmcode-react-vendor` (plan §9.1). A virtual
 * module keeps them out of Vite's dependency optimizer.
 */
export function reactVendorPlugin(): Plugin {
  return {
    name: "tmcode-react-vendor",
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load(id) {
      if (id !== `\0${ID}`) return null;
      return Object.entries(FILES)
        .map(([key, [name, file]]) => `export const ${key} = ${JSON.stringify(readFileSync(join(pkg(name), file), "utf8"))};`)
        .join("\n");
    },
  };
}
