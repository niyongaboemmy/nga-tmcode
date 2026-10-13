#!/usr/bin/env node
// Validates the catalog and every starter, then writes:
//   dist/catalog.json   languages, runtimes and kinds (kind.starters filled in)
//   dist/starters.json  every starter manifest plus its text files ({path, content})
//   dist/index.js       the TypeScript API as one ES module (zod stays a dependency)
//   dist/index.d.ts     its types (tsc, declarations only)
// Exits 1 on any problem.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkg, "dist");
const tool = join(tmpdir(), `nga-runtimes-build-${process.pid}.mjs`);

// 1. Load the TypeScript sources (catalog, validators, the Node starter loader).
await build({
  stdin: {
    contents: `
      export { CATALOG } from "./src/catalog/index.ts";
      export { validateCatalog, validateStarters } from "./src/validate.ts";
      export { loadStarters, toStarter } from "./src/node/starters.ts";
    `,
    resolveDir: pkg,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: tool,
  logLevel: "warning",
});
const { CATALOG, validateCatalog, validateStarters, loadStarters, toStarter } = await import(pathToFileURL(tool).href);
rmSync(tool);

// 2. Validate.
const starters = loadStarters(join(pkg, "starters"));
const problems = [...validateCatalog(CATALOG), ...validateStarters(starters, CATALOG)];
if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

// 3. JSON artefacts.
const byKind = new Map();
for (const s of starters) byKind.set(s.manifest.kind, [...(byKind.get(s.manifest.kind) ?? []), s.manifest.id]);
const catalog = { ...CATALOG, kinds: CATALOG.kinds.map((k) => ({ ...k, starters: (byKind.get(k.id) ?? []).sort() })) };
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
writeFileSync(join(dist, "starters.json"), `${JSON.stringify({ version: CATALOG.version, starters: starters.map(toStarter) }, null, 2)}\n`);
for (const s of starters) if (s.skipped.length) console.warn(`  ${s.manifest.id}: skipped binary ${s.skipped.join(", ")}`);

// 4. The TypeScript API.
await build({
  entryPoints: [join(pkg, "src/index.ts")],
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  outfile: join(dist, "index.js"),
  external: ["zod"],
  banner: { js: "// Built from packages/runtimes/src by scripts/build.mjs — do not edit." },
  logLevel: "warning",
});
execFileSync(process.execPath, [join(pkg, "../../node_modules/typescript/bin/tsc"), "-p", join(pkg, "tsconfig.build.json")], { stdio: "inherit" });
writeFileSync(join(dist, "index.d.ts"), `export * from "./types/index";\n`);

const enabled = (xs) => xs.filter((x) => x.enabled).length;
console.log(
  `✓ catalog ${CATALOG.version}: ${CATALOG.languages.length} languages (${enabled(CATALOG.languages)} enabled), ${CATALOG.runtimes.length} runtimes, ` +
    `${CATALOG.kinds.length} kinds (${enabled(CATALOG.kinds)} enabled), ${starters.length} starters → ${dist}`,
);
