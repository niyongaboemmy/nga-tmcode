#!/usr/bin/env node
// Bumps TMCode's version everywhere, writes the changelog section, commits and tags.
//   npm run release -- 0.2.0          (then: git push --follow-tags)
//   npm run release -- 0.2.0 --push   (pushes too; the tag starts the Release workflow)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [version, ...flags] = process.argv.slice(2);
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const fail = (m) => {
  console.error(`release: ${m}`);
  process.exit(1);
};

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) fail("usage: npm run release -- X.Y.Z [--push]");
const current = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version;
const cmp = (a, b) => a.split(".").map(Number).reduce((r, n, i) => r || n - b.split(".").map(Number)[i], 0);
if (cmp(version, current) <= 0) fail(`${version} must be newer than ${current}`);
if (sh("git", ["status", "--porcelain"])) fail("commit or stash your changes first");
if (sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") fail("release from main");

// package.json files
for (const f of ["package.json", "apps/desktop/package.json", "packages/workbench/package.json", "packages/protocol/package.json", "packages/profiles/package.json", "services/judge/package.json"]) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.version = version;
  writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`);
}
// Cargo.toml + Cargo.lock (the tmcode package only)
const cargo = "apps/desktop/src-tauri/Cargo.toml";
writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^version = "[^"]+"/m, `version = "${version}"`));
const lock = "apps/desktop/src-tauri/Cargo.lock";
writeFileSync(lock, readFileSync(lock, "utf8").replace(/(\[\[package\]\]\nname = "tmcode"\nversion = )"[^"]+"/, `$1"${version}"`));
// package-lock.json workspace entries
const plock = JSON.parse(readFileSync("package-lock.json", "utf8"));
plock.version = version;
for (const [k, v] of Object.entries(plock.packages ?? {})) {
  // Only the workspaces themselves, never their nested node_modules entries.
  if (k === "" || /^(apps|packages|services)\/[^/]+$/.test(k)) v.version = version;
}
writeFileSync("package-lock.json", `${JSON.stringify(plock, null, 2)}\n`);

// CHANGELOG: commits since the previous tag
let since = "";
try {
  since = sh("git", ["describe", "--tags", "--abbrev=0"]);
} catch {
  /* first release */
}
const log = sh("git", ["log", "--no-merges", "--format=- %s", since ? `${since}..HEAD` : "HEAD"])
  .split("\n")
  .filter((l) => l && !/^- (Release v|Plan:)/.test(l))
  .join("\n");
const date = new Date().toISOString().slice(0, 10);
const prev = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8").replace(/^# Changelog\n+/, "") : "";
writeFileSync("CHANGELOG.md", `# Changelog\n\n## ${version} — ${date}\n\n${log || "- Maintenance release"}\n\n${prev}`);

// The release workflow runs `npm ci`: refuse to tag a lock file it would reject.
try {
  sh("npm", ["ci", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund"]);
} catch (e) {
  sh("git", ["checkout", "--", "."]);
  fail(`package-lock.json would fail \`npm ci\` — nothing was committed.\n${e.stdout ?? e.message}`);
}

sh("git", ["add", "-A"]);
sh("git", ["commit", "-m", `Release v${version}`]);
sh("git", ["tag", "-a", `v${version}`, "-m", `TMCode ${version}`]);
console.log(`Tagged v${version}.`);
if (flags.includes("--push")) {
  sh("git", ["push", "--follow-tags"]);
  console.log("Pushed: the Release workflow is building the installers.");
} else console.log("Push with: git push --follow-tags");
