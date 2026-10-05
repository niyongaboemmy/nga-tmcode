import { emmetCSS, emmetHTML, emmetJSX } from "emmet-monaco-es";
import { getPlatform, log, useWorkbench } from "../state/store";
import { monaco } from "./setup";

/**
 * What VS Code users expect in a real project beyond Monaco's defaults:
 * Emmet, Prettier formatting (honouring the project's .prettierrc) and
 * IntelliSense for installed npm packages (types read from node_modules).
 */

let emmetOn = false;
export function enableEmmet(tokenizer: "monarch" | "standard" = "monarch") {
  if (emmetOn) return;
  emmetOn = true;
  emmetHTML(monaco, ["html", "php", "vue", "handlebars"], { tokenizer });
  emmetCSS(monaco, ["css", "scss", "less"], { tokenizer });
  emmetJSX(monaco, ["javascript", "typescript"], { tokenizer });
}

// ── Prettier ──────────────────────────────────────────────────────────────

const PARSERS: Record<string, string> = {
  javascript: "babel",
  typescript: "typescript",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  vue: "vue",
  markdown: "markdown",
  yaml: "yaml",
  json: "json",
  graphql: "graphql",
};

let prettierConfig: Record<string, unknown> | null | undefined;

async function projectPrettierConfig(): Promise<Record<string, unknown> | null> {
  if (prettierConfig !== undefined) return prettierConfig;
  const fs = getPlatform().fs;
  prettierConfig = null;
  for (const name of [".prettierrc", ".prettierrc.json"]) {
    const text = await fs.readFile(name).catch(() => null);
    if (text) {
      try {
        prettierConfig = JSON.parse(text) as Record<string, unknown>;
      } catch {
        log("Prettier", `${name} is not JSON; using defaults (YAML/JS configs are not read).`, "warn");
      }
      break;
    }
  }
  if (!prettierConfig) {
    const pkg = await fs.readFile("package.json").catch(() => null);
    try {
      const fromPkg = pkg ? (JSON.parse(pkg) as { prettier?: unknown }).prettier : undefined;
      if (fromPkg && typeof fromPkg === "object") prettierConfig = fromPkg as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return prettierConfig;
}

/** The workspace changed (or its config did): read .prettierrc again next time. */
export function resetProjectConfig() {
  prettierConfig = undefined;
  typesLoadedFor = null;
}

async function loadPrettier() {
  const [prettier, babel, estree, typescript, postcss, html, markdown, yaml, graphql] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/babel"),
    import("prettier/plugins/estree"),
    import("prettier/plugins/typescript"),
    import("prettier/plugins/postcss"),
    import("prettier/plugins/html"),
    import("prettier/plugins/markdown"),
    import("prettier/plugins/yaml"),
    import("prettier/plugins/graphql"),
  ]);
  return { prettier, plugins: [babel, estree, typescript, postcss, html, markdown, yaml, graphql] };
}
let prettierPromise: ReturnType<typeof loadPrettier> | null = null;

/** Formats `text` with Prettier as VS Code's Prettier extension would; exported for tests. */
export async function formatWithPrettier(text: string, languageId: string, path: string, options: { tabSize: number; insertSpaces: boolean }) {
  const parser = PARSERS[languageId];
  if (!parser) return null;
  prettierPromise ??= loadPrettier();
  const { prettier, plugins } = await prettierPromise;
  const config = await projectPrettierConfig().catch(() => null);
  return prettier.format(text, {
    parser: languageId === "typescript" || languageId === "javascript" ? (path.endsWith(".ts") || path.endsWith(".tsx") ? "typescript" : "babel") : parser,
    plugins: plugins as never,
    tabWidth: options.tabSize,
    useTabs: !options.insertSpaces,
    filepath: path,
    ...(config ?? {}),
  });
}

let prettierOn = false;
export function enablePrettier() {
  if (prettierOn) return;
  prettierOn = true;
  for (const lang of Object.keys(PARSERS)) {
    monaco.languages.registerDocumentFormattingEditProvider(lang, {
      displayName: "Prettier",
      async provideDocumentFormattingEdits(model, options) {
        try {
          const formatted = await formatWithPrettier(model.getValue(), lang, model.uri.path, options);
          if (formatted === null || formatted === model.getValue()) return [];
          return [{ range: model.getFullModelRange(), text: formatted }];
        } catch (e) {
          // A syntax error: leave the file alone, say why in Output.
          log("Prettier", String((e as Error)?.message ?? e).split("\n")[0], "warn");
          return [];
        }
      },
    });
  }
}

// ── Type acquisition from node_modules ───────────────────────────────────

const SCHEME_ROOT = "tmcode:/";
const MAX_FILES = 600;
const MAX_BYTES = 12 * 1024 * 1024;
let typesLoadedFor: string | null = null;
const libs: monaco.IDisposable[] = [];

/** Relative imports and reference paths inside a .d.ts. */
export function dtsDependencies(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/(?:from|import|export\s+\*\s+from)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) out.add(m[1]);
  for (const m of source.matchAll(/\/\/\/\s*<reference\s+path=["']([^"']+)["']/g)) out.add(m[1].startsWith(".") ? m[1] : `./${m[1]}`);
  return [...out];
}

function joinRel(dir: string, rel: string) {
  const parts = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Reads the declaration files of the project's dependencies (their own
 * `types` or @types/…) and gives them to the TypeScript worker, so
 * `import React from "react"` completes and type-checks as in VS Code.
 */
export async function acquireTypes() {
  const ws = useWorkbench.getState().workspace;
  if (!ws || typesLoadedFor === ws.root) return;
  typesLoadedFor = ws.root;
  libs.splice(0).forEach((d) => d.dispose());
  const fs = getPlatform().fs;
  const pkgText = await fs.readFile("package.json").catch(() => null);
  if (!pkgText) return;
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return;
  }
  const names = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])];
  const seen = new Set<string>();
  let bytes = 0;
  const started = performance.now();

  const add = (path: string, text: string) => {
    libs.push(monaco.typescript.typescriptDefaults.addExtraLib(text, `${SCHEME_ROOT}${path}`));
    libs.push(monaco.typescript.javascriptDefaults.addExtraLib(text, `${SCHEME_ROOT}${path}`));
  };
  const readTree = async (entry: string) => {
    const queue = [entry];
    while (queue.length && seen.size < MAX_FILES && bytes < MAX_BYTES) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      let text = await fs.readFile(file).catch(() => null);
      if (text === null && !file.endsWith(".d.ts")) {
        for (const alt of [`${file}.d.ts`, `${file}/index.d.ts`]) {
          text = await fs.readFile(alt).catch(() => null);
          if (text !== null) {
            seen.add(alt);
            add(alt, text);
            const dir = alt.slice(0, alt.lastIndexOf("/"));
            for (const dep of dtsDependencies(text)) queue.push(joinRel(dir, dep.replace(/\.js$/, "")));
            break;
          }
        }
        continue;
      }
      if (text === null) continue;
      bytes += text.length;
      add(file, text);
      const dir = file.slice(0, file.lastIndexOf("/"));
      for (const dep of dtsDependencies(text)) queue.push(joinRel(dir, dep.replace(/\.js$/, "")));
    }
  };

  for (const name of names) {
    if (seen.size >= MAX_FILES || bytes >= MAX_BYTES) break;
    const base = `node_modules/${name}`;
    const own = await fs.readFile(`${base}/package.json`).catch(() => null);
    let entry: string | null = null;
    if (own) {
      try {
        const meta = JSON.parse(own) as { types?: string; typings?: string };
        const t = meta.types ?? meta.typings;
        if (t) entry = joinRel(base, t);
      } catch {
        /* ignore */
      }
      if (!entry && (await fs.readFile(`${base}/index.d.ts`).catch(() => null)) !== null) entry = `${base}/index.d.ts`;
    }
    if (!entry && !name.startsWith("@types/")) {
      const at = `node_modules/@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
      if ((await fs.readFile(`${at}/index.d.ts`).catch(() => null)) !== null) entry = `${at}/index.d.ts`;
    }
    if (name.startsWith("@types/")) entry = `${base}/index.d.ts`;
    if (!entry) continue;
    await readTree(entry);
    // TypeScript looks for <pkg>/index.d.ts when it cannot read package.json "types": point it at the real entry.
    if (!entry.endsWith(`${base}/index.d.ts`) && entry.startsWith(base)) {
      const rel = `./${entry.slice(base.length + 1).replace(/\.d\.ts$/, "")}`;
      add(`${base}/index.d.ts`, `export * from "${rel}";\nexport { default } from "${rel}";\n`);
    }
  }
  if (seen.size) log("IntelliSense", `Loaded ${seen.size} type declaration files from node_modules in ${Math.round(performance.now() - started)} ms.`);
}
