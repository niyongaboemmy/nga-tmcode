// Bundles tm-judge to plain JavaScript (dist/server.mjs). Production Node builds
// (e.g. Ubuntu's nodejs) may lack TypeScript type stripping.
import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/server.mjs",
  external: ["esbuild"],
  banner: { js: "// Built from services/judge/src by scripts/build.mjs — do not edit." },
  logLevel: "info",
});
