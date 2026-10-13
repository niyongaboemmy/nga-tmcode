/**
 * Cross-checks the schemas can't express: references between runtimes,
 * languages, kinds and starters. Used by scripts/build.mjs and the tests.
 * Each function returns human-readable problems (empty = fine).
 */
import { detect, entryFor } from "./detect";
import { CatalogSchema, IoTestsSchema, StarterManifestSchema, type Catalog, type StarterFile, type StarterManifest } from "./schema";

const dupes = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

export function validateCatalog(catalog: Catalog): string[] {
  const problems: string[] = [];
  const parsed = CatalogSchema.safeParse(catalog);
  if (!parsed.success) return parsed.error.issues.map((i) => `catalog.${i.path.join(".")}: ${i.message}`);
  for (const d of dupes(catalog.languages.map((l) => l.key))) problems.push(`duplicate language ${d}`);
  for (const d of dupes(catalog.runtimes.map((r) => r.id))) problems.push(`duplicate runtime ${d}`);
  for (const d of dupes(catalog.kinds.map((k) => k.id))) problems.push(`duplicate kind ${d}`);
  const runtimes = new Map(catalog.runtimes.map((r) => [r.id, r]));
  const languages = new Map(catalog.languages.map((l) => [l.key, l]));
  for (const r of catalog.runtimes) for (const u of r.uses ?? []) if (!runtimes.has(u)) problems.push(`runtime ${r.id}: uses unknown runtime ${u}`);
  for (const k of catalog.kinds) {
    const lang = languages.get(k.language);
    if (!lang) problems.push(`kind ${k.id}: unknown language ${k.language}`);
    if (lang && k.enabled && !lang.enabled) problems.push(`kind ${k.id}: enabled but language ${k.language} is not`);
    const rt = runtimes.get(k.runtime);
    if (!rt) {
      problems.push(`kind ${k.id}: unknown runtime ${k.runtime}`);
      continue;
    }
    const tools = new Set([...Object.keys(rt.tools), ...(rt.uses ?? []).flatMap((u) => Object.keys(runtimes.get(u)?.tools ?? {}))]);
    for (const [name, step] of Object.entries(k.steps)) {
      if (step && !tools.has(step.tool)) problems.push(`kind ${k.id}: step ${name} uses tool "${step.tool}" that runtime ${rt.id} doesn't provide`);
    }
    if (k.tier !== "browser" && !k.steps.run && !k.steps.test && !k.steps.serve) problems.push(`kind ${k.id}: no run, test or serve step`);
    if (k.tier !== "container" && k.steps.serve) problems.push(`kind ${k.id}: serve steps need tier "container"`);
    if (k.tier !== "container" && k.services?.length) problems.push(`kind ${k.id}: database services need tier "container"`);
    for (const [name, step] of Object.entries(k.steps)) {
      if (step?.runsProjectScripts && k.tier === "isolate") problems.push(`kind ${k.id}: step ${name} runs project scripts in tier "isolate" (use isolate-build)`);
    }
    for (const rule of k.detect.contains ?? []) {
      try {
        new RegExp(rule.text, "m");
      } catch (e) {
        problems.push(`kind ${k.id}: bad contains regex ${rule.text}: ${(e as Error).message}`);
      }
    }
  }
  return problems;
}

export interface StarterInput {
  manifest: StarterManifest;
  files: StarterFile[];
}

/** One starter against the catalog: manifest, files named by it, tests, and detection. */
export function validateStarter(s: StarterInput, catalog: Catalog): string[] {
  const id = s.manifest?.id ?? "?";
  const p: string[] = [];
  const parsed = StarterManifestSchema.safeParse(s.manifest);
  if (!parsed.success) return parsed.error.issues.map((i) => `starter ${id}: ${i.path.join(".")}: ${i.message}`);
  const m = parsed.data;
  const kind = catalog.kinds.find((k) => k.id === m.kind);
  if (!kind) return [`starter ${id}: unknown kind ${m.kind}`];
  if (kind.language !== m.language) p.push(`starter ${id}: language ${m.language} but kind ${m.kind} is ${kind.language}`);
  const paths = s.files.map((f) => f.path);
  const has = (path: string) => paths.includes(path);
  const scaffolded = !!m.setup && paths.every((x) => /(^|\/)(readme\.md|\.gitignore)$/i.test(x));
  if (!has(m.entry)) p.push(`starter ${id}: entry ${m.entry} is missing`);
  for (const o of m.open) if (!has(o)) p.push(`starter ${id}: open file ${o} is missing`);
  for (const r of m.readonly ?? []) if (!has(r)) p.push(`starter ${id}: readonly file ${r} is missing`);
  if (has(".tmcode/tests.json")) p.push(`starter ${id}: use .nga/tests.json, not .tmcode/tests.json`);
  if (m.tests?.io) {
    const file = s.files.find((f) => f.path === m.tests!.io);
    if (!file) p.push(`starter ${id}: tests.io ${m.tests.io} is missing`);
    else {
      try {
        const io = IoTestsSchema.parse(JSON.parse(file.content));
        if (!has(io.entry)) p.push(`starter ${id}: ${m.tests.io} entry ${io.entry} is missing`);
        for (const d of dupes(io.tests.map((t) => t.id))) p.push(`starter ${id}: duplicate io test id ${d}`);
      } catch (e) {
        p.push(`starter ${id}: ${m.tests.io}: ${(e as Error).message.slice(0, 300)}`);
      }
    }
  } else if (has(".nga/tests.json")) p.push(`starter ${id}: has .nga/tests.json but no tests.io`);
  if (m.purpose === "io-exercise" && !m.tests?.io) p.push(`starter ${id}: io-exercise without io tests`);
  for (const f of s.files) if (f.path.endsWith(".json")) {
    try {
      JSON.parse(f.content);
    } catch {
      p.push(`starter ${id}: ${f.path} is not valid JSON`);
    }
  }
  if (!scaffolded) {
    const read = (path: string) => s.files.find((f) => f.path === path)?.content ?? null;
    const ranked = detect(paths, read, { kinds: catalog.kinds });
    const top = ranked[0];
    if (!top) p.push(`starter ${id}: no kind detected from its files`);
    else if (top.kind !== m.kind) {
      // Accept another kind of the same language only when it ties on priority (a judgement call the manifest settles).
      const mine = ranked.find((r) => r.kind === m.kind);
      if (!mine) p.push(`starter ${id}: declared ${m.kind} doesn't match its files (detected ${top.kind})`);
      else if (top.language !== m.language || Math.floor(top.score / 1000) !== Math.floor(mine.score / 1000)) p.push(`starter ${id}: detected ${top.kind} ahead of declared ${m.kind}`);
    }
    if (kind.entry && !entryFor(kind, paths, read)) p.push(`starter ${id}: entryFor(${m.kind}) found no entry`);
  }
  return p;
}

/** Whole set: each starter plus unique ids and aliases. */
export function validateStarters(starters: StarterInput[], catalog: Catalog): string[] {
  const ids = starters.flatMap((s) => [s.manifest.id, ...(s.manifest.aliases ?? [])]);
  return [...dupes(ids).map((d) => `duplicate starter id or alias ${d}`), ...starters.flatMap((s) => validateStarter(s, catalog))];
}
