#!/usr/bin/env node
// One-off: TMCode's New Project templates (packages/workbench/src/projects/templates/*.ts,
// inline file maps) → starters/<language>/tmcode-<id>/ folders with starter.json.
// Re-running rewrites those folders (other starters are left alone).
//   node packages/runtimes/scripts/migrate-templates.mjs
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const repo = join(pkg, "../..");
const bundle = join(tmpdir(), `nga-migrate-templates-${process.pid}.mjs`);

await build({
  stdin: {
    contents: `
      export { TEMPLATES } from "./packages/workbench/src/projects/templates.ts";
      export { detect, entryFor } from "./packages/runtimes/src/detect.ts";
      export { kindById } from "./packages/runtimes/src/catalog/index.ts";
      export { detectSuites, snapshotsOf } from "./packages/runtimes/src/testing/index.ts";
      export { StarterManifestSchema, IoTestsSchema } from "./packages/runtimes/src/schema.ts";
    `,
    resolveDir: repo,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundle,
  logLevel: "warning",
});
const { TEMPLATES, detect, entryFor, kindById, detectSuites, snapshotsOf, StarterManifestSchema, IoTestsSchema } = await import(pathToFileURL(bundle).href);
rmSync(bundle);

/** Templates whose files alone don't say what they are (scaffolded later, or TMCode-only). */
const KIND_OVERRIDE = { laravel: "php/laravel", rails: "ruby/rails" };
/** "unsolved": the student writes the solution, so its tests fail until then. */
const EXTRA_TAGS = { "problem-solving": ["unsolved"] };

const PURPOSE = {
  Websites: "web",
  "Frontend frameworks": "web",
  "Backend & APIs": "api",
  "Mobile & desktop": "project",
  "Data & SQL": "data",
  Learning: "algorithms",
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const report = [];

for (const t of TEMPLATES) {
  const files = { ...t.files };
  // .tmcode/tests.json → .nga/tests.json with points.
  if (files[".tmcode/tests.json"]) {
    const io = JSON.parse(files[".tmcode/tests.json"]);
    io.tests = io.tests.map((x) => ({ ...x, points: x.points ?? 1 }));
    IoTestsSchema.parse(io);
    delete files[".tmcode/tests.json"];
    files[".nga/tests.json"] = `${JSON.stringify(io, null, 2)}\n`;
  }
  // README mentions of the old path.
  for (const [p, text] of Object.entries(files)) if (/\.md$/i.test(p)) files[p] = text.replaceAll(".tmcode/tests.json", ".nga/tests.json");

  const paths = Object.keys(files);
  const read = (p) => files[p] ?? null;
  const ranked = detect(paths, read);
  const kind = KIND_OVERRIDE[t.id] ?? ranked[0]?.kind;
  if (!kind) throw new Error(`${t.id}: no catalog kind matches ${paths.join(", ")}`);
  const k = kindById(kind);
  const entry = t.main ?? entryFor(k, paths, read) ?? paths.find((p) => !/readme\.md$/i.test(p)) ?? paths[0];

  let purpose = PURPOSE[t.category];
  if (t.category === "Languages") purpose = files[".nga/tests.json"] ? "io-exercise" : "project";
  if (t.id === "sql") purpose = "data";

  const suite = detectSuites(snapshotsOf(paths, read))[0];
  const manifest = {
    id: `tmcode-${t.id}`,
    language: k.language,
    kind,
    title: t.label,
    description: t.description,
    level: t.category === "Learning" || t.category === "Languages" || t.category === "Websites" ? "beginner" : "intermediate",
    purpose,
    entry,
    open: [entry],
    ...(files[".nga/tests.json"] || suite
      ? { tests: { ...(files[".nga/tests.json"] ? { io: ".nga/tests.json" } : {}), ...(suite ? { unit: { framework: suite.framework, command: "test" } } : {}) } }
      : {}),
    tags: [slug(t.category), "tmcode-template", ...(EXTRA_TAGS[t.id] ?? [])],
    since: "2026.10.1",
    icon: t.icon,
    ...(t.tools?.length ? { tools: t.tools } : {}),
    ...(t.setup ? { setup: t.setup } : {}),
    aliases: [t.id],
  };
  StarterManifestSchema.parse(manifest);

  const dir = join(pkg, "starters", k.language, manifest.id);
  rmSync(dir, { recursive: true, force: true });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  writeFileSync(join(dir, "starter.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  report.push(`${manifest.id.padEnd(28)} ${kind.padEnd(18)} ${purpose.padEnd(12)} ${entry}${ranked[0] && ranked[0].kind !== kind ? `   (detected ${ranked[0].kind})` : ""}`);
}
console.log(report.join("\n"));
console.log(`\n${TEMPLATES.length} templates migrated.`);
