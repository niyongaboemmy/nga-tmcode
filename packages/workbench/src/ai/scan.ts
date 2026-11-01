import { recordActivity } from "../activity/log";
import { registerCommand } from "../commands/registry";
import { getDocument } from "../monaco/documents";
import { monaco } from "../monaco/setup";
import { listFiles } from "../parts/search/search";
import { getPlatform, notify, showPanel } from "../state/store";
import { checkPackage, packageWarning, type PackageRef } from "./agent/packages";
import { maskSecrets } from "./agent/ignore";

/**
 * The pre-publish safety scan (proposal M1, basic tier; Lovable's "block publishing with critical
 * findings", Replit's Semgrep step): offline checks for the mistakes AI-built apps ship most often,
 * in seconds, on every project, in every layer (it isn't AI). Critical findings stop sharing and
 * publishing, and are shown before Submit (F1); they never stop a student handing work in.
 *
 * Findings go to the Problems panel (source "TMCode safety scan") and the Activity log.
 */

export type Severity = "critical" | "high" | "medium";

export interface Finding {
  rule: string;
  severity: Severity;
  path: string;
  line: number;
  message: string;
}

interface Rule {
  id: string;
  severity: Severity;
  files: RegExp;
  test: RegExp;
  message: string;
  /** A line that matches this is fine (the safe form). */
  unless?: RegExp;
}

const CODE = /\.(m?[jt]sx?|cjs|py|php|rb|java|kt|cs|go|rs|swift|dart)$/;
const WEB = /\.(m?[jt]sx?|cjs|html?|vue|svelte|php)$/;

const RULES: Rule[] = [
  { id: "sql-from-strings", severity: "critical", files: CODE, test: /\b(query|execute|exec|raw|prepare)\s*\(\s*(?:f["']|["'`][^"'`]*(?:SELECT|INSERT|UPDATE|DELETE)\b[^"'`]*["'`]\s*\+|`[^`]*(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{)/i, message: "SQL built from strings: an attacker can change the query (SQL injection). Use parameters (?, $1, :name)." },
  { id: "sql-format", severity: "critical", files: /\.py$/, test: /\.(execute|executemany)\s*\(\s*(?:f["']|["'][^"']*%s?[^"']*["']\s*%|["'][^"']*\{[^}]*\}[^"']*["']\.format)/, message: "SQL built with string formatting (SQL injection). Pass the values as parameters: execute(sql, (value,))." },
  { id: "eval", severity: "high", files: /\.(m?[jt]sx?|cjs|py|php|rb)$/, test: /(^|[^\w.])(eval|exec)\s*\((?!\s*["'`][^"'`]*["'`]\s*\))/, message: "eval/exec runs text as code: never with anything a user can change." },
  { id: "innerhtml", severity: "high", files: WEB, test: /\.(innerHTML|outerHTML)\s*\+?=(?!=)(?!\s*["'`][^"'`$]*["'`]\s*;?\s*$)/, message: "innerHTML with data can run an attacker's script (XSS). Use textContent, or escape the data." },
  { id: "dangerously-set", severity: "high", files: /\.[jt]sx$/, test: /dangerouslySetInnerHTML/, message: "dangerouslySetInnerHTML: make sure the HTML is sanitised (e.g. DOMPurify)." },
  { id: "open-cors", severity: "high", files: CODE, test: /(Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*["']|\bcors\(\s*\)|origin\s*:\s*["']\*["']|CORS\(\s*app\s*\))/, message: "CORS open to every website. Allow only your own front end's origin." },
  { id: "debug-on", severity: "medium", files: /\.(py|php|js|ts|json|env|ya?ml|toml)$/, test: /(\bDEBUG\s*=\s*True\b|app\.run\([^)]*debug\s*=\s*True|display_errors\s*=\s*(On|1)|["']?NODE_ENV["']?\s*[:=]\s*["']?development)/i, message: "Debug mode on: it shows internals and errors to anyone. Turn it off before sharing." },
  { id: "plain-http", severity: "medium", files: WEB, test: /["'`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[^"'`\s]+\/(api|v\d)\b/, message: "An API called over plain http:// (anyone on the network can read it). Use https://." },
  { id: "weak-hash", severity: "high", files: CODE, test: /\b(md5|sha1)\s*\(|createHash\(\s*["'](md5|sha1)["']\)|hashlib\.(md5|sha1)\(/i, message: "MD5/SHA-1 is not safe for passwords. Use bcrypt, scrypt or argon2." },
  { id: "plain-password", severity: "critical", files: CODE, test: /\b(password|passwd|pwd)\s*(===?|!==?)\s*["'`][^"'`]+["'`]|\bif\s*\(?\s*\w*password\w*\s*==/i, message: "A password compared in plain text. Store a hash (bcrypt) and compare the hash." },
  { id: "jwt-none", severity: "critical", files: CODE, test: /algorithms?\s*[:=]\s*\[?\s*["']none["']/i, message: "JWT with the 'none' algorithm: anyone can forge tokens." },
];

/** Routes with no sign-in check (Express/Flask style), when the project has sign-in at all. */
function routesWithoutAuth(path: string, text: string): Finding[] {
  if (!/\.(m?[jt]s|py)$/.test(path)) return [];
  const usesAuth = /\b(requireAuth|isAuthenticated|authenticate|ensureAuth|login_required|jwt_required|passport\.authenticate|protect|verifyToken|auth)\b/.test(text);
  if (!usesAuth) return [];
  const out: Finding[] = [];
  text.split("\n").forEach((l, i) => {
    const m = /\b(?:app|router)\.(post|put|patch|delete)\(\s*["'`]([^"'`]+)/.exec(l) ?? /@\w+\.route\(\s*["']([^"']+)["'][^)]*methods\s*=\s*\[[^\]]*(POST|PUT|DELETE|PATCH)/.exec(l);
    if (!m) return;
    const route = m[2] ?? m[1];
    if (/login|register|signup|sign-in|signin|auth|webhook|health|public/i.test(route)) return;
    const window = text.split("\n").slice(i, i + 3).join(" ");
    if (/\b(requireAuth|isAuthenticated|authenticate|ensureAuth|login_required|jwt_required|passport\.authenticate|protect|verifyToken|auth)\b/.test(window)) return;
    out.push({ rule: "route-without-auth", severity: "high", path, line: i + 1, message: `A route that changes data (${route}) with no sign-in check, while the app has sign-in elsewhere. Protect it, or say why it's public.` });
  });
  return out;
}

/** The scan over files already read (pure: the tests and the runner use it). */
export function scanFiles(files: { path: string; text: string }[]): Finding[] {
  const out: Finding[] = [];
  const paths = new Set(files.map((f) => f.path));
  for (const f of files) {
    if (/(^|\/)(node_modules|dist|build|vendor|\.git)\//.test(f.path) || f.text.length > 400_000) continue;
    const lines = f.text.split("\n");
    // Secrets in code (not in .env, which is checked below).
    if (!/(^|\/)\.env/.test(f.path)) {
      lines.forEach((l, i) => {
        if (maskSecrets(l).masked) out.push({ rule: "secret-in-code", severity: "critical", path: f.path, line: i + 1, message: "A key, token or password is written in the code. Move it to .env (kept out of git) and rotate it." });
      });
    }
    for (const r of RULES) {
      if (!r.files.test(f.path)) continue;
      lines.forEach((l, i) => {
        if (/^\s*(\/\/|#|\*|<!--)/.test(l)) return;
        if (r.test.test(l) && !(r.unless && r.unless.test(l))) out.push({ rule: r.id, severity: r.severity, path: f.path, line: i + 1, message: r.message });
      });
    }
    out.push(...routesWithoutAuth(f.path, f.text));
  }
  // An .env file that git would publish.
  const envs = [...paths].filter((p) => /(^|\/)\.env(\.[\w-]+)?$/.test(p) && !/\.(example|sample)$/.test(p));
  if (envs.length) {
    const gitignore = files.find((f) => f.path === ".gitignore")?.text ?? "";
    if (!/^\s*\.env\b/m.test(gitignore)) for (const e of envs) out.push({ rule: "env-not-ignored", severity: "critical", path: e, line: 1, message: ".env isn't in .gitignore: its secrets would be published with the code. Add .env to .gitignore." });
  }
  const rank = { critical: 0, high: 1, medium: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.line - b.line).slice(0, 200);
}

/** Dependencies a project declares (package.json, requirements.txt), for the package check. */
export function declaredPackages(files: { path: string; text: string }[]): PackageRef[] {
  const out: PackageRef[] = [];
  for (const f of files) {
    if (/(^|\/)package\.json$/.test(f.path) && !f.path.includes("node_modules/")) {
      try {
        const j = JSON.parse(f.text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        for (const n of Object.keys({ ...j.dependencies, ...j.devDependencies })) out.push({ ecosystem: "npm", name: n });
      } catch {
        /* not JSON */
      }
    }
    if (/(^|\/)requirements[\w-]*\.txt$/.test(f.path))
      for (const l of f.text.split("\n")) {
        const n = l.replace(/#.*$/, "").trim().replace(/\[.*$/, "").replace(/[<>=!~;].*$/, "").trim();
        if (n && !n.startsWith("-")) out.push({ ecosystem: "pypi", name: n });
      }
  }
  return out.slice(0, 60);
}

export interface ScanResult {
  findings: Finding[];
  files: number;
  ms: number;
  critical: number;
}

const OWNER = "tmcode-scan";

/** Scans the open project (and checks its declared packages exist), into Problems and the log. */
export async function runSafetyScan(opts: { quiet?: boolean } = {}): Promise<ScanResult> {
  const t0 = performance.now();
  const fs = getPlatform().fs;
  const paths = (await listFiles(fs).catch(() => [] as string[])).filter((p) => !/(^|\/)(node_modules|dist|build|\.git)\//.test(p)).slice(0, 1500);
  const files: { path: string; text: string }[] = [];
  for (const p of paths) {
    if (!/\.(m?[jt]sx?|cjs|py|php|rb|java|kt|cs|go|rs|swift|dart|html?|vue|svelte|json|env|ya?ml|toml|txt|gitignore)$|(^|\/)\.env(\.[\w-]+)?$|(^|\/)\.gitignore$/.test(p)) continue;
    const text = getDocument(p)?.getValue() ?? (await fs.readFile(p).catch(() => null));
    if (text !== null) files.push({ path: p, text });
  }
  const findings = scanFiles(files);
  // Packages that don't exist (F2), checked against the registries when online.
  const checks = await Promise.all(declaredPackages(files).map((r) => checkPackage(r).catch(() => null)));
  for (const c of checks) {
    if (!c || c.state !== "missing") continue;
    const w = packageWarning([c]);
    if (w) findings.unshift({ rule: "package-missing", severity: "critical", path: c.ref.ecosystem === "npm" ? "package.json" : "requirements.txt", line: 1, message: w.text });
  }
  for (const model of monaco.editor.getModels()) {
    const p = model.uri.path.replace(/^\//, "");
    monaco.editor.setModelMarkers(
      model,
      OWNER,
      findings.filter((f) => f.path === p).map((f) => ({ startLineNumber: f.line, endLineNumber: f.line, startColumn: 1, endColumn: model.getLineMaxColumn(Math.min(f.line, model.getLineCount())), severity: f.severity === "medium" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error, message: `${f.severity.toUpperCase()}: ${f.message}`, source: "TMCode safety scan", code: f.rule })),
    );
  }
  const critical = findings.filter((f) => f.severity === "critical").length;
  const ms = Math.round(performance.now() - t0);
  recordActivity({ kind: "project", action: "safety-scan", text: `Safety scan: ${findings.length ? `${critical} critical, ${findings.length - critical} other finding${findings.length - critical === 1 ? "" : "s"}` : "nothing found"} (${files.length} files, ${ms} ms)`, data: { findings: findings.length, critical, files: files.length } });
  if (!opts.quiet) {
    if (findings.length) {
      notify(critical ? "error" : "warning", `Safety scan: ${critical ? `${critical} critical finding${critical === 1 ? "" : "s"} (fix before sharing), ` : ""}${findings.length} in all. See the Problems panel.`);
      showPanel("problems");
    } else notify("info", `Safety scan: nothing found in ${files.length} files.`);
  }
  return { findings, files: files.length, ms, critical };
}

let wired = false;
export function wireSafetyScan() {
  if (wired) return;
  wired = true;
  registerCommand({ id: "tmcode.safetyScan", title: "Safety Scan (Before Sharing)", category: "TMCode", aliases: ["security scan", "pre-publish scan", "audit"], run: () => void runSafetyScan() });
}
