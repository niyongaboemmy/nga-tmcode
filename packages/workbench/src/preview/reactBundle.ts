/// <reference path="../vendor.d.ts" />
import type * as esbuild from "esbuild-wasm";
import { ensureEsbuild, esbuild as esb } from "./esbuildInit";
// Provided by the host's Vite config (apps/desktop/build/reactVendorPlugin.ts).
import {
  jsxRuntime as jsxRuntimeSrc,
  react as reactSrc,
  reactDom as reactDomSrc,
  reactDomClient as reactDomClientSrc,
  scheduler as schedulerSrc,
} from "virtual:tmcode-react-vendor";
import { dirname, extname } from "../util/paths";

/**
 * Bundles a student's React project in the browser (plan §9.1) with
 * esbuild-wasm. Only the React that ships inside TMCode can be imported —
 * no npm, no network — so previews work offline and in locked-down exams.
 */

const VENDOR: Record<string, string> = {
  react: reactSrc,
  "react/jsx-runtime": jsxRuntimeSrc,
  "react/jsx-dev-runtime": jsxRuntimeSrc,
  "react-dom": reactDomSrc,
  "react-dom/client": reactDomClientSrc,
  scheduler: schedulerSrc,
};

const init = ensureEsbuild;

const RESOLVE_EXTS = ["", ".jsx", ".js", ".tsx", ".ts", "/index.jsx", "/index.js", "/index.tsx", "/index.ts"];
const LOADERS: Record<string, esbuild.Loader> = { js: "jsx", jsx: "jsx", ts: "tsx", tsx: "tsx", css: "css", json: "json", mjs: "js" };

export interface BundleResult {
  js: string;
  css: string;
  errors: string[];
  warnings: string[];
}

/**
 * @param entry   entry path relative to the project root (e.g. "src/main.jsx")
 * @param read    reads a project-relative file (null when missing)
 */
export async function bundleReact(entry: string, read: (path: string) => Promise<string | null>): Promise<BundleResult> {
  await init();
  const resolveFile = async (importer: string, spec: string): Promise<string | null> => {
    const parts = (spec.startsWith("/") ? [] : dirname(importer).split("/").filter(Boolean)) as string[];
    for (const p of spec.replace(/^\//, "").split("/")) {
      if (p === "..") parts.pop();
      else if (p && p !== ".") parts.push(p);
    }
    const base = parts.join("/");
    for (const ext of RESOLVE_EXTS) {
      const candidate = base + ext;
      if ((await read(candidate)) !== null) return candidate;
    }
    return null;
  };

  try {
    const result = await esb.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      outdir: "/out",
      jsx: "automatic",
      target: "es2020",
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        {
          name: "tmcode-project",
          setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
              if (args.kind === "entry-point") return { path: args.path, namespace: "project" };
              if (VENDOR[args.path] !== undefined) return { path: args.path, namespace: "vendor" };
              if (/^(\.{1,2}\/|\/)/.test(args.path)) {
                if (args.namespace === "vendor") return { errors: [{ text: `Unexpected import ${args.path}` }] };
                const file = await resolveFile(args.importer, args.path);
                if (!file) return { errors: [{ text: `Cannot find '${args.path}' (imported from ${args.importer})` }] };
                return { path: file, namespace: "project" };
              }
              return {
                errors: [{ text: `Package '${args.path}' is not available in TMCode previews. Only react and react-dom can be imported.` }],
              };
            });
            build.onLoad({ filter: /.*/, namespace: "vendor" }, (args) => ({ contents: VENDOR[args.path], loader: "js" }));
            build.onLoad({ filter: /.*/, namespace: "project" }, async (args) => {
              const contents = await read(args.path);
              if (contents === null) return { errors: [{ text: `Cannot read ${args.path}` }] };
              const ext = extname(args.path);
              if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) {
                return { contents: `export default ${JSON.stringify(args.path)};`, loader: "js" };
              }
              return { contents, loader: LOADERS[ext] ?? "jsx", resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    const js = result.outputFiles.filter((f) => f.path.endsWith(".js")).map((f) => f.text).join("\n");
    const css = result.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
    return { js, css, errors: [], warnings: result.warnings.map(formatMessage) };
  } catch (e) {
    const failure = e as esbuild.BuildFailure;
    return { js: "", css: "", errors: failure.errors?.map(formatMessage) ?? [String((e as Error)?.message ?? e)], warnings: [] };
  }
}

function formatMessage(m: esbuild.Message) {
  const loc = m.location ? `${m.location.file}:${m.location.line}:${m.location.column + 1}: ` : "";
  return `${loc}${m.text}`;
}
