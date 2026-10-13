/**
 * Reading starters from disk (Node only: build script, tests, verify script).
 * Not exported from the package's browser-safe index.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { StarterManifestSchema, type Starter, type StarterFile, type StarterManifest } from "../schema";

/** Files never shipped in starters.json. */
const SKIP = /(^|\/)(\.DS_Store|node_modules\/|target\/|build\/|dist\/|__pycache__\/)/;

export interface StarterOnDisk {
  dir: string;
  manifest: StarterManifest;
  files: StarterFile[];
  /** Paths left out because they aren't UTF-8 text. */
  skipped: string[];
}

function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, root));
    else out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

const isText = (buf: Buffer) => !buf.subarray(0, 8000).includes(0);

/** Every starter under `startersDir/<language>/<id>/starter.json`, manifests validated. */
export function loadStarters(startersDir: string): StarterOnDisk[] {
  const out: StarterOnDisk[] = [];
  for (const lang of readdirSync(startersDir).sort()) {
    const langDir = join(startersDir, lang);
    if (!statSync(langDir).isDirectory()) continue;
    for (const id of readdirSync(langDir).sort()) {
      const dir = join(langDir, id);
      if (!statSync(dir).isDirectory()) continue;
      const raw = JSON.parse(readFileSync(join(dir, "starter.json"), "utf8")) as unknown;
      const parsed = StarterManifestSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`${lang}/${id}/starter.json: ${parsed.error.message}`);
      const files: StarterFile[] = [];
      const skipped: string[] = [];
      for (const path of walk(dir)) {
        if (path === "starter.json" || SKIP.test(path)) continue;
        const buf = readFileSync(join(dir, path));
        if (isText(buf)) files.push({ path, content: buf.toString("utf8") });
        else skipped.push(path);
      }
      out.push({ dir, manifest: parsed.data, files, skipped });
    }
  }
  return out;
}

/** The shipped form: manifest plus files. */
export const toStarter = (s: StarterOnDisk): Starter => ({ ...s.manifest, files: s.files });
