/**
 * What AI may not see (proposal F6, F4): `.tmcodeignore` (gitignore syntax) keeps paths away from
 * the agent, suggestions and `@`-mentions; a default list always applies (secrets, keys, lock files,
 * binaries, media); teacher-hidden files (hidden tests, reference solutions, marking notes, sent by
 * Task Mentor as `hidden_paths`) are excluded in every layer. Unlike Cursor's ignore file, the
 * agent's own commands are refused for these paths too (rules.ts).
 */

export const IGNORE_FILE = ".tmcodeignore";

/** Always ignored (Cursor's defaults, plus TMCode's own records). */
export const DEFAULT_IGNORE = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "*.keystore",
  ".npmrc",
  ".pypirc",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.ico",
  "*.pdf",
  "*.zip",
  "*.gz",
  "*.tar",
  "*.mp3",
  "*.mp4",
  "*.mov",
  "*.wasm",
  "*.exe",
  "*.dll",
  "*.so",
  "*.dylib",
  "*.class",
  "*.jar",
  "*.pyc",
  "node_modules/",
  ".git/",
  ".tmcode/activity/",
  ".tmcode/layer.json",
];

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** One gitignore line as a rule (null: blank or comment). */
export function compileIgnoreLine(raw: string): Rule | null {
  let line = raw.replace(/\s+$/, "");
  if (!line || line.startsWith("#")) return null;
  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  }
  if (line.startsWith("\\")) line = line.slice(1);
  const dirOnly = line.endsWith("/");
  if (dirOnly) line = line.slice(0, -1);
  // A slash anywhere but the end anchors to the root; else it matches at any depth.
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);
  let re = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "*") {
      if (line[i + 1] === "*") {
        const slash = line[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += escape(c);
  }
  // A match covers the path itself and anything under it (a folder).
  return { re: new RegExp(`${anchored ? "^" : "(?:^|/)"}${re}(?:/.*)?$`), negate, dirOnly };
}

export class IgnoreMatcher {
  private readonly rules: Rule[];
  constructor(lines: readonly string[]) {
    this.rules = lines.map(compileIgnoreLine).filter((r): r is Rule => !!r);
  }
  /** Is this workspace-relative path ignored? The last matching line decides (gitignore). */
  ignores(path: string): boolean {
    const p = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
    let hit = false;
    for (const r of this.rules) {
      if (r.dirOnly && !p.includes("/") && !r.re.test(`${p}/`)) continue;
      if (r.re.test(p)) hit = !r.negate;
    }
    return hit;
  }
}

/** The matcher from the defaults, the project's `.tmcodeignore` and the teacher's hidden paths. */
export function buildIgnore(projectFile: string | null, hidden: readonly string[] = []): { ignore: IgnoreMatcher; hidden: IgnoreMatcher } {
  const own = (projectFile ?? "").split(/\r?\n/);
  return { ignore: new IgnoreMatcher([...DEFAULT_IGNORE, ...own, ...hidden]), hidden: new IgnoreMatcher(hidden) };
}

// ── secrets (F4) ──

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-or-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
];

/** `NAME=value` lines whose name says secret (an .env pasted into code). */
const SECRET_ASSIGNMENT = /^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*)(["']?)([^\s"'#]{6,})\2/gim;

/** Text with secrets masked (keys, tokens, private keys, secret-named assignments). */
export function maskSecrets(text: string): { text: string; masked: number } {
  let masked = 0;
  let out = text;
  for (const re of SECRET_PATTERNS)
    out = out.replace(re, () => {
      masked++;
      return "«secret removed by TMCode»";
    });
  out = out.replace(SECRET_ASSIGNMENT, (_all, head: string, q: string) => {
    masked++;
    return `${head}${q}«secret removed by TMCode»${q}`;
  });
  return { text: out, masked };
}
