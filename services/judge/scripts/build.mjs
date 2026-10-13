// Bundles tm-judge to plain JavaScript (dist/server.mjs). Production Node builds
// (e.g. Ubuntu's nodejs) may lack TypeScript type stripping.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/server.mjs",
  external: ["esbuild"],
  // The runner installs only its own dependencies (install.sh uses --workspaces=false),
  // so packages it bundles from the monorepo (@nga/runtimes → zod) resolve here.
  nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
  banner: { js: "// Built from services/judge/src by scripts/build.mjs — do not edit." },
  logLevel: "info",
});
