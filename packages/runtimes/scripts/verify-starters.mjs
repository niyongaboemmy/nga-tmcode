#!/usr/bin/env node
// Runs the wave A starters with the toolchains on THIS computer (not the
// sandbox): every single-file hello must run, and every starter with
// .nga/tests.json must pass its stdin → stdout cases (whitespace-normalised).
// With --projects it also runs each new project/api/data starter's unit tests
// (make test, mvn test, gradle test, pytest, npm test, go test, cargo test).
// Missing toolchains are skipped, never failures.
//
//   node packages/runtimes/scripts/verify-starters.mjs [--projects] [--only <id-substring>]
//   PYTHON=/path/to/venv/bin/python3 … to use a Python that has pytest/pandas/flask.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const projects = args.includes("--projects");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

const tool = join(tmpdir(), `nga-verify-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `export { loadStarters } from "./src/node/starters.ts"; export { kindById } from "./src/catalog/index.ts"; export { javaMainClass, isTestPath } from "./src/detect.ts";`,
    resolveDir: pkg,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: tool,
  logLevel: "warning",
});
const { loadStarters, kindById, javaMainClass, isTestPath } = await import(pathToFileURL(tool).href);
rmSync(tool);

// rustup's cargo first (Homebrew's can be broken next to rustup).
const PATH = [join(homedir(), ".cargo/bin"), process.env.PATH].join(":");
const env = { ...process.env, PATH, NO_COLOR: "1", CARGO_TERM_COLOR: "never" };
const PY = process.env.PYTHON ?? "python3";
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { env }).status === 0;
const TOOLS = { c: "cc", cpp: "c++", java: "javac", python: PY, javascript: "node", typescript: "node", go: "go", rust: "rustc", sql: "sqlite3" };
const esbuildBin = join(pkg, "../../node_modules/.bin/esbuild");

const norm = (s) => s.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");

function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { env, encoding: "utf8", timeout: opts.timeout ?? 120_000, cwd: opts.cwd, input: opts.input ?? "", maxBuffer: 32 << 20 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: `${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
}

/** Builds the program once; returns [command, argv] to run it with stdin. */
function prepare(s, dir) {
  const m = s.manifest;
  const io = m.tests?.io ? JSON.parse(readFileSync(join(dir, m.tests.io), "utf8")) : null;
  const entry = io?.entry ?? m.entry;
  const kind = m.kind;
  const files = s.files.map((f) => f.path);
  const srcs = (re) => files.filter((p) => re.test(p) && !isTestPath(p));
  const fail = (what, r) => ({ error: `${what} failed: ${(r.err || r.out).trim().split("\n").slice(-6).join("\n")}` });
  switch (m.language) {
    case "c":
    case "cpp": {
      const cpp = m.language === "cpp";
      const sources = kind.endsWith("/single") ? srcs(cpp ? /\.(cpp|cc|cxx)$/ : /\.c$/) : srcs(cpp ? /\.(cpp|cc|cxx)$/ : /\.c$/).filter((p) => !p.startsWith("tests/"));
      const r = sh(cpp ? "c++" : "cc", [cpp ? "-std=c++20" : "-std=c17", "-O2", "-w", ...(files.some((p) => p.startsWith("include/")) ? ["-Iinclude"] : []), ...sources, "-o", "verify-bin", ...(cpp ? [] : ["-lm"])], { cwd: dir });
      return r.ok ? { run: ["./verify-bin", []] } : fail("compile", r);
    }
    case "java": {
      const sources = srcs(/\.java$/).filter((p) => !p.startsWith("src/test/"));
      const r = sh("javac", ["-encoding", "UTF-8", "-d", "verify-out", ...sources], { cwd: dir });
      if (!r.ok) return fail("javac", r);
      return { run: ["java", ["-cp", "verify-out", javaMainClass(entry, readFileSync(join(dir, entry), "utf8"))]] };
    }
    case "python":
      return { run: [PY, ["-u", entry]] };
    case "javascript":
      return { run: ["node", [entry]] };
    case "typescript": {
      const r = sh(esbuildBin, [entry, "--bundle", "--platform=node", "--format=esm", "--log-level=warning", "--outfile=verify-main.mjs"], { cwd: dir });
      return r.ok ? { run: ["node", ["verify-main.mjs"]] } : fail("esbuild", r);
    }
    case "go": {
      const r = sh("go", files.includes("go.mod") ? ["build", "-o", "verify-bin", "."] : ["build", "-o", "verify-bin", entry], { cwd: dir, timeout: 300_000 });
      return r.ok ? { run: ["./verify-bin", []] } : fail("go build", r);
    }
    case "rust": {
      if (files.includes("Cargo.toml")) {
        const r = sh("cargo", ["build", "--release", "--quiet"], { cwd: dir, timeout: 600_000 });
        const name = /^name\s*=\s*"([^"]+)"/m.exec(readFileSync(join(dir, "Cargo.toml"), "utf8"))?.[1];
        return r.ok ? { run: [`./target/release/${name}`, []] } : fail("cargo build", r);
      }
      const r = sh("rustc", ["--edition", "2021", "-O", entry, "-o", "verify-bin"], { cwd: dir, timeout: 300_000 });
      return r.ok ? { run: ["./verify-bin", []] } : fail("rustc", r);
    }
    case "sql": {
      if (files.includes("schema.sql") && files.includes("seed.sql")) {
        const r = sh("sqlite3", ["-bail", "verify.db", ".read schema.sql", ".read seed.sql"], { cwd: dir });
        if (!r.ok) return fail("seed", r);
      }
      return { run: ["sqlite3", ["-bail", "-header", "-box", "verify.db"]], stdinFile: entry };
    }
    default:
      return { skip: `no local runner for ${m.language}` };
  }
}

const UNIT = {
  "c/make": [["make", ["-s", "test"]]],
  "cpp/make": [["make", ["-s", "test"]]],
  "c/cmake": [["cmake", ["-S", ".", "-B", "build"]], ["cmake", ["--build", "build"]], ["ctest", ["--test-dir", "build", "--output-on-failure"]]],
  "cpp/cmake": [["cmake", ["-S", ".", "-B", "build"]], ["cmake", ["--build", "build"]], ["ctest", ["--test-dir", "build", "--output-on-failure"]]],
  "java/maven": [["mvn", ["-q", "-B", "test"]]],
  "java/spring-boot": [["mvn", ["-q", "-B", "test"]]],
  "java/gradle": [["gradle", ["-q", "--no-daemon", "test"]]],
  "python/project": [[PY, ["-m", "pytest", "-q", "-p", "no:cacheprovider"]]],
  "python/data": [[PY, ["-m", "pytest", "-q", "-p", "no:cacheprovider"]]],
  "python/flask": [[PY, ["-m", "pytest", "-q", "-p", "no:cacheprovider"]]],
  "python/fastapi": [[PY, ["-m", "pytest", "-q", "-p", "no:cacheprovider"]]],
  "js/npm": [["npm", ["install", "--no-audit", "--no-fund", "--silent"]], ["npm", ["test", "--silent"]]],
  "js/express": [["npm", ["install", "--no-audit", "--no-fund", "--silent"]], ["npm", ["test", "--silent"]]],
  "ts/npm": [["npm", ["install", "--no-audit", "--no-fund", "--silent"]], ["npm", ["test", "--silent"]]],
  "go/module": [["go", ["test", "./..."]]],
  "go/web": [["go", ["test", "./..."]]],
  "rust/cargo": [["cargo", ["test", "--quiet"]]],
  "rust/web": [["cargo", ["test", "--quiet"]]],
};

const results = [];
const record = (id, status, detail = "") => {
  results.push({ id, status, detail });
  console.log(`${status === "pass" ? "✓" : status === "skip" ? "–" : "✗"} ${id}${detail ? `  ${detail}` : ""}`);
};

for (const s of loadStarters(join(pkg, "starters"))) {
  const m = s.manifest;
  if (only && !m.id.includes(only)) continue;
  const kind = kindById(m.kind);
  const lang = m.language;
  if (!kind || !TOOLS[lang]) continue; // wave A program languages only
  const single = kind.id.endsWith("/single") || kind.id === "sql/sqlite";
  const wantHello = m.purpose === "hello" && single;
  if (m.tests?.io && m.tags.includes("unsolved")) record(m.id, "skip", "unsolved exercise: its tests pass once a student solves it");
  const wantIo = !!m.tests?.io && !m.tags.includes("unsolved");
  const wantUnit = projects && m.tests?.unit && UNIT[m.kind] && !m.id.startsWith("tmcode-");
  if (!wantHello && !wantIo && !wantUnit) continue;
  if (!has(TOOLS[lang])) {
    record(m.id, "skip", `${TOOLS[lang]} not installed`);
    continue;
  }
  const dir = mkdtempSync(join(tmpdir(), `nga-starter-${m.id}-`));
  try {
    cpSync(s.dir, dir, { recursive: true });
    if (wantHello || wantIo) {
      const p = prepare(s, dir);
      if (p.skip) record(m.id, "skip", p.skip);
      else if (p.error) record(m.id, "fail", p.error);
      else {
        const [cmd, argv] = p.run;
        const stdinOf = (input) => (p.stdinFile ? readFileSync(join(dir, p.stdinFile), "utf8") : input);
        if (wantIo) {
          const io = JSON.parse(readFileSync(join(dir, m.tests.io), "utf8"));
          const bad = [];
          for (const t of io.tests) {
            const r = sh(cmd, argv, { cwd: dir, input: stdinOf(t.input), timeout: 30_000 });
            if (norm(r.out) !== norm(t.expected_output)) bad.push(`${t.id} "${t.name}": expected ${JSON.stringify(norm(t.expected_output))}, got ${JSON.stringify(norm(r.out))}${r.err ? ` (stderr: ${r.err.trim().slice(0, 200)})` : ""}`);
          }
          record(`${m.id} [io ${io.tests.length - bad.length}/${io.tests.length}]`, bad.length ? "fail" : "pass", bad.join("; "));
        } else {
          const r = sh(cmd, argv, { cwd: dir, input: stdinOf(""), timeout: 30_000 });
          record(`${m.id} [hello]`, r.ok && r.out.trim() ? "pass" : "fail", r.ok ? r.out.trim().split("\n")[0] : r.err.trim().slice(0, 300));
        }
      }
    }
    if (wantUnit) {
      const steps = UNIT[m.kind];
      const missing = steps.map(([c]) => c).find((c) => !has(c));
      if (missing) record(`${m.id} [unit]`, "skip", `${missing} not installed`);
      else {
        let r = { ok: true };
        for (const [c, a] of steps) {
          r = sh(c, a, { cwd: dir, timeout: 900_000 });
          if (!r.ok) break;
        }
        record(`${m.id} [unit]`, r.ok ? "pass" : "fail", r.ok ? "" : (r.err || r.out).trim().split("\n").slice(-8).join(" | ").slice(0, 600));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (st) => results.filter((r) => r.status === st).length;
console.log(`\n${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped`);
process.exit(count("fail") ? 1 : 0);
