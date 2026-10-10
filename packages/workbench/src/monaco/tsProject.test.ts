import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  createBudget,
  globToRegExp,
  isModuleSource,
  listSources,
  loadProjectConfig,
  MAX_SOURCE_FILE_BYTES,
  orderByPreference,
  parseJsonc,
  planSources,
  toServiceOptions,
  type DirEntryLike,
} from "./tsProject";
import { isJump, NavHistory } from "./navHistory";

/** A fake folder: path → text. */
function folder(files: Record<string, string>) {
  const read = async (p: string) => (p in files ? files[p] : null);
  const readDir = async (dir: string): Promise<DirEntryLike[]> => {
    const prefix = dir ? `${dir}/` : "";
    const seen = new Map<string, DirEntryLike>();
    for (const f of Object.keys(files)) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const name = rest.split("/")[0];
      const kind = rest.includes("/") ? "dir" : "file";
      seen.set(name, { name, path: prefix + name, kind });
    }
    return [...seen.values()];
  };
  return { read, readDir };
}

describe("tsconfig reading", () => {
  it("parses JSON with comments and trailing commas", () => {
    expect(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,2,],\n}')).toEqual({ a: "http://x", b: [1, 2] });
    expect(parseJsonc('{"s": "a\\"//b"}')).toEqual({ s: 'a"//b' });
    expect(parseJsonc("{ nope")).toBeNull();
  });

  it("follows extends and keeps path options relative to the config that set them", async () => {
    const { read } = folder({
      "tsconfig.json": '{ "extends": "./config/base.json", "compilerOptions": { "strict": true }, "include": ["src"] }',
      "config/base.json": '{ "compilerOptions": { "baseUrl": "..", "paths": { "@/*": ["src/*"] }, "target": "ES2022", "strict": false } }',
    });
    const cfg = await loadProjectConfig(read);
    expect(cfg.kind).toBe("tsconfig");
    expect(cfg.include).toEqual(["src"]);
    const opts = toServiceOptions(cfg, {});
    expect(opts.strict).toBe(true);
    expect(opts.target).toBe(9);
    // baseUrl ".." from config/ is the folder root.
    expect(opts.baseUrl).toBe("tmcode:/");
    expect(opts.paths).toEqual({ "@/*": ["src/*"] });
  });

  it("extends a package config from node_modules", async () => {
    const { read } = folder({
      "tsconfig.json": '{ "extends": "@tsconfig/node20/tsconfig.json" }',
      "node_modules/@tsconfig/node20/tsconfig.json": '{ "compilerOptions": { "module": "node16", "moduleResolution": "node16", "lib": ["es2023"] } }',
    });
    const opts = toServiceOptions(await loadProjectConfig(read), {});
    expect(opts.module).toBe(100);
    expect(opts.moduleResolution).toBe(3);
    expect(opts.lib).toEqual(["lib.es2023.d.ts"]);
  });

  it("merges a solution config's references (Vite's template)", async () => {
    const { read } = folder({
      "tsconfig.json": '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }',
      "tsconfig.app.json": '{ "compilerOptions": { "jsx": "react-jsx", "moduleResolution": "bundler", "lib": ["ES2020", "DOM", "DOM.Iterable"] }, "include": ["src"] }',
      "tsconfig.node.json": '{ "compilerOptions": { "module": "ESNext" }, "include": ["vite.config.ts"] }',
    });
    const cfg = await loadProjectConfig(read);
    expect(cfg.include).toEqual(["src", "vite.config.ts"]);
    const opts = toServiceOptions(cfg, {});
    expect(opts).toMatchObject({ jsx: 4, moduleResolution: 100, lib: ["lib.es2020.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], allowNonTsExtensions: true });
    const plan = planSources(cfg);
    expect(plan.accepts("src/App.tsx")).toBe(true);
    expect(plan.accepts("vite.config.ts")).toBe(true);
    expect(plan.accepts("scripts/x.ts")).toBe(false);
  });

  it("uses TMCode's defaults without a config, and jsconfig's defaults with one", async () => {
    expect(toServiceOptions(await loadProjectConfig(folder({}).read), { strict: true })).toEqual({ strict: true });
    const js = toServiceOptions(await loadProjectConfig(folder({ "jsconfig.json": '{ "compilerOptions": { "checkJs": true } }' }).read), {});
    expect(js).toMatchObject({ allowJs: true, checkJs: true, allowSyntheticDefaultImports: true });
  });

  it("paths without baseUrl resolve from the config's folder, the way TypeScript does", async () => {
    const files: Record<string, string> = {
      "tsconfig.json": '{ "compilerOptions": { "module": "esnext", "moduleResolution": "bundler", "paths": { "@lib/*": ["./src/lib/*"] } } }',
      "src/main.ts": 'import { a } from "@lib/a";\nimport { u } from "./utils";\n',
      "src/lib/a.ts": "export const a = 1;\n",
      "src/utils.ts": "export const u = 2;\n",
    };
    const opts = toServiceOptions(await loadProjectConfig(folder(files).read), {}) as ts.CompilerOptions;
    // The worker's file names are tmcode: URIs; resolve with them as Monaco's worker does.
    const host: ts.ModuleResolutionHost = {
      fileExists: (f) => f.startsWith("tmcode:/") && f.slice(8) in files,
      readFile: (f) => files[f.slice(8)],
    };
    const resolve = (name: string) => ts.resolveModuleName(name, "tmcode:/src/main.ts", opts, host).resolvedModule?.resolvedFileName;
    expect(resolve("./utils")).toBe("tmcode:/src/utils.ts");
    expect(resolve("@lib/a")).toBe("tmcode:/src/lib/a.ts");
  });
});

describe("which files the TypeScript service gets", () => {
  it("matches tsconfig globs", () => {
    expect(globToRegExp("src/**/*", "").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/**/*", "").test("src/b.ts")).toBe(true);
    expect(globToRegExp("src", "").test("src/x/y.tsx")).toBe(true);
    expect(globToRegExp("*.ts", "").test("a/b.ts")).toBe(false);
    expect(globToRegExp("**/*.spec.ts", "").test("a/b.spec.ts")).toBe(true);
    expect(globToRegExp("lib/?.ts", "pkg").test("pkg/lib/a.ts")).toBe(true);
  });

  it("honours include, exclude, outDir and allowJs", async () => {
    const { read, readDir } = folder({
      "tsconfig.json": '{ "compilerOptions": { "outDir": "lib" }, "exclude": ["src/legacy"] }',
      "src/a.ts": "",
      "src/b.js": "",
      "src/legacy/old.ts": "",
      "lib/a.d.ts": "",
      "node_modules/x/index.ts": "",
      ".git/x.ts": "",
    });
    const plan = planSources(await loadProjectConfig(read));
    expect(await listSources(readDir, plan)).toEqual(["src/a.ts"]);
  });

  it("without a config: JS and TS modules, no build output or dependencies", async () => {
    const { read, readDir } = folder({ "a.ts": "", "web/app.js": "", "web/app.min.js": "", "dist/bundle.js": "", "node_modules/r/index.d.ts": "", "notes.md": "" });
    const plan = planSources(await loadProjectConfig(read));
    expect(plan.modulesOnly).toBe(true);
    expect(await listSources(readDir, plan)).toEqual(["a.ts", "web/app.js"]);
  });

  it("tells modules from global scripts", () => {
    expect(isModuleSource('import { x } from "./x";')).toBe(true);
    expect(isModuleSource("export const a = 1;")).toBe(true);
    expect(isModuleSource("module.exports = { a };")).toBe(true);
    expect(isModuleSource("exports.a = 1;")).toBe(true);
    expect(isModuleSource("const a = 1;\nconsole.log(a);")).toBe(false);
    expect(isModuleSource('const fs = require("fs");')).toBe(false);
  });

  it("keeps to the budget, open files and their folders first", () => {
    expect(orderByPreference(["a/x.ts", "b/y.ts", "b/z.ts", "c.ts"], ["b/z.ts"])).toEqual(["b/z.ts", "b/y.ts", "a/x.ts", "c.ts"]);
    const b = createBudget({ files: 2, bytes: 100 });
    expect(b.take(60)).toBe(true);
    expect(b.take(60)).toBe(false);
    expect(b.take(40)).toBe(true);
    expect(b.full()).toBe(true);
    expect(b.take(1)).toBe(false);
    expect(b.used).toEqual({ files: 2, bytes: 100, skipped: 2 });
    b.release(40);
    expect(b.take(MAX_SOURCE_FILE_BYTES + 1)).toBe(false);
    expect(b.take(10)).toBe(true);
  });
});

describe("Go Back / Go Forward", () => {
  it("returns to where Go to Definition started", () => {
    const h = new NavHistory();
    h.record({ path: "main.ts", line: 3, column: 5 });
    expect(h.goBack({ path: "utils.ts", line: 1, column: 17 })).toEqual({ path: "main.ts", line: 3, column: 5 });
    expect(h.goForward({ path: "main.ts", line: 3, column: 5 })).toEqual({ path: "utils.ts", line: 1, column: 17 });
    expect(h.goForward(null)).toBeNull();
  });

  it("merges nearby entries, drops deleted files and follows renames", () => {
    const h = new NavHistory();
    h.record({ path: "a.ts", line: 10, column: 1 });
    h.record({ path: "a.ts", line: 12, column: 1 });
    h.record({ path: "src/b.ts", line: 1, column: 1 });
    h.rename("src", "lib");
    expect(h.goBack(null)?.path).toBe("lib/b.ts");
    expect(h.goBack(null)?.line).toBe(12);
    expect(h.canGoBack()).toBe(false);
    h.record({ path: "gone.ts", line: 1, column: 1 });
    h.rename("gone.ts", null);
    expect(h.canGoBack()).toBe(false);
    expect(isJump({ line: 1 }, { line: 11 })).toBe(true);
    expect(isJump({ line: 1 }, { line: 5 })).toBe(false);
  });
});
