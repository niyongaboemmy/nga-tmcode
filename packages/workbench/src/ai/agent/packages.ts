import { getPlatform } from "../../state/store";

/**
 * Package reality check (proposal F2, on for everyone): before an install the agent asked for (or
 * a terminal answer offers), each package is looked up in its registry. AI code names packages that
 * don't exist about one time in five (CSA 2026: 19.7% of 2.23 M samples), and attackers register
 * those names ("slopsquatting"). A missing package is refused; one published in the last 30 days
 * is flagged so the person looks before saying yes. Offline or no registry answer: nothing is said.
 */

export type Ecosystem = "npm" | "pypi" | "crates" | "rubygems" | "packagist" | "go";

export interface PackageRef {
  ecosystem: Ecosystem;
  name: string;
}

const NPM = /^\s*(?:npm\s+(?:i|install|add)|yarn\s+add|pnpm\s+(?:add|i|install)|bun\s+add)\b(.*)$/;
const PIP = /^\s*(?:python3?\s+-m\s+)?pip3?\s+install\b(.*)$/;
const CARGO = /^\s*cargo\s+add\b(.*)$/;
const GEM = /^\s*gem\s+install\b(.*)$/;
const COMPOSER = /^\s*composer\s+require\b(.*)$/;
const GO = /^\s*go\s+get\b(.*)$/;

/** Flags whose next word is a file, folder or URL, not a package. */
const VALUE_FLAGS = new Set(["-r", "--requirement", "-e", "--editable", "-c", "--constraint", "-t", "--target", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "--prefix", "--registry", "-w", "--workspace", "--path"]);

/** Names after an install command, without flags, versions, local paths or URLs. */
function names(rest: string): string[] {
  const out: string[] = [];
  const words = rest.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const a = words[i].replace(/^["']|["']$/g, "");
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-") || /^[.~/]/.test(a) || /^(?:https?|git\+|file):/.test(a) || /[|&]/.test(a)) continue;
    out.push(a);
  }
  return out.slice(0, 20);
}

/** The packages a command line installs (each `&&`/`;` part is read). */
export function installedPackages(command: string): PackageRef[] {
  const out: PackageRef[] = [];
  for (const part of command.split(/&&|;|\|\|/)) {
    let m: RegExpExecArray | null;
    if ((m = NPM.exec(part)))
      for (const n of names(m[1])) {
        const name = n.startsWith("@") ? n.replace(/^(@[^@/]+\/[^@]+)(@.*)?$/, "$1") : n.replace(/@.*$/, "");
        if (name) out.push({ ecosystem: "npm", name });
      }
    else if ((m = PIP.exec(part))) for (const n of names(m[1])) out.push({ ecosystem: "pypi", name: n.replace(/\[.*$/, "").replace(/[<>=!~;].*$/, "") });
    else if ((m = CARGO.exec(part))) for (const n of names(m[1])) out.push({ ecosystem: "crates", name: n.replace(/@.*$/, "") });
    else if ((m = GEM.exec(part))) for (const n of names(m[1])) out.push({ ecosystem: "rubygems", name: n });
    else if ((m = COMPOSER.exec(part))) {
      for (const n of names(m[1])) if (n.includes("/")) out.push({ ecosystem: "packagist", name: n.replace(/:.*$/, "") });
    } else if ((m = GO.exec(part))) for (const n of names(m[1])) out.push({ ecosystem: "go", name: n.replace(/@.*$/, "") });
  }
  return out.filter((p) => p.name && /^[@\w][\w.@/-]*$/.test(p.name));
}

function registryUrl(p: PackageRef): string {
  switch (p.ecosystem) {
    case "npm":
      return `https://registry.npmjs.org/${p.name.replace("/", "%2F")}`;
    case "pypi":
      return `https://pypi.org/pypi/${encodeURIComponent(p.name)}/json`;
    case "crates":
      return `https://crates.io/api/v1/crates/${encodeURIComponent(p.name)}`;
    case "rubygems":
      return `https://rubygems.org/api/v1/gems/${encodeURIComponent(p.name)}.json`;
    case "packagist":
      return `https://repo.packagist.org/p2/${p.name}.json`;
    case "go":
      return `https://proxy.golang.org/${p.name.toLowerCase()}/@v/list`;
  }
}

export interface PackageCheck {
  ref: PackageRef;
  /** "missing": not in the registry; "new": first published in the last 30 days; "ok"; "unknown": couldn't ask. */
  state: "ok" | "missing" | "new" | "unknown";
  created?: string;
}

const NEW_MS = 30 * 24 * 3600_000;
const cache = new Map<string, PackageCheck>();

/** When the registry says the package was first published (npm, PyPI, crates), if it does. */
function createdOf(p: PackageRef, body: string): string | undefined {
  try {
    const j = JSON.parse(body);
    if (p.ecosystem === "npm") return j?.time?.created;
    if (p.ecosystem === "crates") return j?.crate?.created_at;
    if (p.ecosystem === "pypi") {
      const times = Object.values(j?.releases ?? {})
        .flat()
        .map((f: any) => f?.upload_time_iso_8601)
        .filter(Boolean)
        .sort();
      return times[0];
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

export async function checkPackage(ref: PackageRef, now = Date.now()): Promise<PackageCheck> {
  const key = `${ref.ecosystem}:${ref.name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const http = getPlatform().http;
  if (!http) return { ref, state: "unknown" };
  let res;
  try {
    res = await http.request({ method: "GET", url: registryUrl(ref), headers: [["Accept", "application/json"]] });
  } catch {
    return { ref, state: "unknown" };
  }
  let out: PackageCheck;
  if (res.status === 404 || (ref.ecosystem === "go" && res.status === 410)) out = { ref, state: "missing" };
  else if (res.status >= 200 && res.status < 300) {
    const created = createdOf(ref, res.body);
    out = { ref, state: created && now - Date.parse(created) < NEW_MS ? "new" : "ok", ...(created ? { created } : {}) };
  } else return { ref, state: "unknown" };
  cache.set(key, out);
  return out;
}

/** Checks every package of a command (at most 8, in parallel). */
export async function checkInstall(command: string): Promise<PackageCheck[]> {
  const refs = installedPackages(command).slice(0, 8);
  return Promise.all(refs.map((r) => checkPackage(r)));
}

/** Words for the person (null when everything is fine or unknown). */
export function packageWarning(checks: PackageCheck[]): { refuse: boolean; text: string } | null {
  const missing = checks.filter((c) => c.state === "missing");
  if (missing.length)
    return {
      refuse: true,
      text: `${missing.map((c) => `"${c.ref.name}"`).join(", ")} ${missing.length === 1 ? "doesn't" : "don't"} exist on ${missing[0].ref.ecosystem}. AI often invents package names, and attackers register them: check the name before installing.`,
    };
  const fresh = checks.filter((c) => c.state === "new");
  if (fresh.length) return { refuse: false, text: `${fresh.map((c) => `"${c.ref.name}"`).join(", ")} ${fresh.length === 1 ? "was" : "were"} first published in the last 30 days. Make sure it's the package you mean.` };
  return null;
}

/** Tests only. */
export function clearPackageCache() {
  cache.clear();
}
