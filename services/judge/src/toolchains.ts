/**
 * The Runtime Catalog as this runner sees it: which logical tools resolve to
 * real programs, which cache layers exist, and so which kinds it can run
 * (CODE_RUNNER_PLAN §11, §15.1 GET /v1/catalog).
 *
 * Tool resolution, first hit wins:
 *   1. JUDGE_TOOLCHAINS: JSON { "<runtime id>": { "<tool>": "/abs/path" }, "*": { "<tool>": "/abs/path" } }
 *   2. the catalog's absolute path (the runner image layout: /opt/go/bin/go…)
 *   3. `command -v <tool>` on the judge's PATH (unless JUDGE_TOOL_LOOKUP=0)
 * Cache layers: JUDGE_CACHES = JSON { "<cache id>": "/host/folder" }; a layer
 * counts only when its folder exists and isn't empty. Boxes see it read-only at /caches/<id>.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { CATALOG, CATALOG_VERSION, detect, entryFor, type KindDef, type RuntimeDef, type Step } from "../../../packages/runtimes/src/index.ts";
import { containerReason, databasesUsable, imageFor, type ContainerTier } from "./containers.ts";

export { CATALOG, CATALOG_VERSION };

/** Wrappers a step may drop when they aren't installed (stdbuf only changes buffering). */
export const OPTIONAL_TOOLS = new Set(["stdbuf"]);
/** Tiers isolate executes; browser kinds run in TMCode, container kinds need tier 3 (containers.ts). */
export const RUNNER_TIERS = new Set<KindDef["tier"]>(["isolate", "isolate-build"]);
export const STEP_NAMES = ["restore", "build", "run", "test"] as const;
export type StepName = (typeof STEP_NAMES)[number];

export interface RuntimeState {
  def: RuntimeDef;
  /** Logical tool → resolved absolute path (null = not installed). */
  tools: Record<string, string | null>;
  /** First line of the version command, null when its tool is missing (filled by `probeVersions`). */
  version: string | null;
}

export interface Toolchains {
  version: string;
  runtimes: Map<string, RuntimeState>;
  /** Cache layer id → host folder (existing folders only). */
  caches: Map<string, string>;
  /** Tier 3 (Docker + gVisor), when configured; container kinds are unavailable without it. */
  containers?: ContainerTier;
}

export interface ToolchainOptions {
  /** JUDGE_TOOLCHAINS (object or JSON text). */
  overrides?: unknown;
  /** JUDGE_CACHES (object or JSON text). */
  caches?: unknown;
  /** Fall back to `command -v` (default true). */
  lookup?: boolean;
}

function parseJson(v: unknown, name: string): Record<string, unknown> {
  if (v === undefined || v === null || v === "") return {};
  if (typeof v === "object") return v as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(v));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* reported below */
  }
  throw new Error(`${name} must be a JSON object.`);
}

function executable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function nonEmpty(dir: string) {
  try {
    return readdirSync(dir).some((n) => !n.startsWith("."));
  } catch {
    return false;
  }
}

const lookedUp = new Map<string, string | null>();
function onPath(tool: string): string | null {
  if (!/^[\w.+-]+$/.test(tool)) return null;
  if (!lookedUp.has(tool)) {
    const r = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
    const p = r.stdout.trim();
    lookedUp.set(tool, r.status === 0 && p.startsWith("/") ? p : null);
  }
  return lookedUp.get(tool) ?? null;
}

export function resolveToolchains(opts: ToolchainOptions = {}): Toolchains {
  const overrides = parseJson(opts.overrides, "JUDGE_TOOLCHAINS") as Record<string, Record<string, string>>;
  const cacheMap = parseJson(opts.caches, "JUDGE_CACHES") as Record<string, string>;
  const lookup = opts.lookup ?? true;
  const runtimes = new Map<string, RuntimeState>();
  for (const def of CATALOG.runtimes) {
    const tools: Record<string, string | null> = {};
    for (const [tool, path] of Object.entries(def.tools)) {
      const candidates = [overrides[def.id]?.[tool], overrides["*"]?.[tool], path].filter((p): p is string => typeof p === "string" && p.startsWith("/"));
      tools[tool] = candidates.find(executable) ?? (lookup ? onPath(tool) : null);
    }
    runtimes.set(def.id, { def, tools, version: null });
  }
  const caches = new Map<string, string>();
  for (const [id, host] of Object.entries(cacheMap)) {
    // An empty folder (created by install.sh, not filled yet) is no layer.
    if (typeof host === "string" && host.startsWith("/") && existsSync(host) && nonEmpty(host)) caches.set(id, host.replace(/\/+$/, ""));
  }
  return { version: CATALOG_VERSION, runtimes, caches };
}

/** Fills each runtime's version (runs its version command; slow, once at startup). */
export function probeVersions(tc: Toolchains) {
  for (const rt of tc.runtimes.values()) {
    const [cmd, ...args] = rt.def.version;
    const bin = cmd ? (rt.tools[cmd] ?? null) : null;
    if (!bin) continue;
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 15_000, env: { PATH: `${dirname(bin)}:/usr/local/bin:/usr/bin:/bin`, HOME: "/tmp", LANG: "C.UTF-8" } });
    rt.version = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("Picked up"))[0] ?? null;
  }
}

/** The runtime and the ones it builds on (TypeScript → node-22). */
export function runtimeChain(tc: Toolchains, id: string): RuntimeState[] {
  const out: RuntimeState[] = [];
  const visit = (rid: string) => {
    const rt = tc.runtimes.get(rid);
    if (!rt || out.includes(rt)) return;
    out.push(rt);
    for (const u of rt.def.uses ?? []) visit(u);
  };
  visit(id);
  return out;
}

/** A logical tool's path for a kind's runtime (or a runtime it uses). */
export function toolPath(tc: Toolchains, runtime: string, tool: string): string | null {
  for (const rt of runtimeChain(tc, runtime)) if (rt.tools[tool]) return rt.tools[tool];
  return null;
}

export function kindSteps(kind: KindDef): [StepName, Step][] {
  return STEP_NAMES.filter((n) => kind.steps[n]).map((n) => [n, kind.steps[n] as Step]);
}

export interface KindAvailability {
  available: boolean;
  /** Required tools that aren't installed. */
  missing: string[];
  /** Tools of conditional steps (`when`, e.g. uv for requirements.txt) that aren't installed: those projects get 503. */
  missing_optional: string[];
  /** Why the runner can't run it at all (tier). */
  reason?: string;
  /** Cache layers the kind wants that aren't installed (it still runs; dependencies outside the starters fail). */
  missing_caches: string[];
}

export function availability(tc: Toolchains, kind: KindDef): KindAvailability {
  const missing_caches = kind.caches.filter((c) => !tc.caches.has(c));
  const none = { missing: [], missing_optional: [], missing_caches };
  if (kind.tier === "container") {
    // The image carries the toolchain at the catalog's paths: no host tools to check.
    const why = containerReason(tc.containers, kind) ?? servicesReason(tc, kind.services ?? []);
    if (why) return { available: false, ...none, reason: why };
    if (!kindSteps(kind).length) return { available: false, ...none, reason: "no runnable steps" };
    return { available: true, ...none };
  }
  if (!RUNNER_TIERS.has(kind.tier)) return { available: false, ...none, reason: `tier ${kind.tier} is not run by this runner` };
  if (!tc.runtimes.has(kind.runtime)) return { available: false, ...none, reason: `unknown runtime ${kind.runtime}` };
  const steps = kindSteps(kind);
  if (!steps.length) return { available: false, ...none, reason: "no runnable steps" };
  const absent = (list: [StepName, Step][]) => [...new Set(list.map(([, s]) => s.tool).filter((t) => !OPTIONAL_TOOLS.has(t) && !toolPath(tc, kind.runtime, t)))];
  const missing = absent(steps.filter(([, s]) => !s.when));
  const missing_optional = absent(steps.filter(([, s]) => !!s.when)).filter((t) => !missing.includes(t));
  return { available: missing.length === 0, missing, missing_optional, missing_caches };
}

/** Why the database sidecars a run asks for can't start here (null = they can). */
export function servicesReason(tc: Toolchains, services: readonly string[]): string | null {
  if (!services.length) return null;
  const db = databasesUsable(tc.containers);
  for (const s of services) {
    if (s !== "postgres" && s !== "mysql") return `unknown service '${s}'`;
    if (!db[s]) return `the ${s} database image (${s === "postgres" ? tc.containers?.config.postgresImage : tc.containers?.config.mysqlImage}) is not available on this runner`;
  }
  return null;
}

/**
 * Whether a non-container kind can still run in a container (PTY sessions,
 * database services): tier 3 is up and its runtime has a built image.
 */
export function containerCapable(tc: Toolchains, kind: KindDef): boolean {
  return kind.tier !== "browser" && !!imageFor(tc.containers, kind.runtime);
}

/** GET /v1/catalog: the catalog filtered to the kinds this runner can run now. */
export function catalogView(tc: Toolchains) {
  const kinds = CATALOG.kinds.map((k) => ({ k, a: availability(tc, k) }));
  const usable = kinds.filter((x) => x.a.available);
  const usedRuntimes = new Set(usable.map((x) => x.k.runtime));
  const usedLanguages = new Set(usable.map((x) => x.k.language));
  return {
    version: tc.version,
    runtimes: [...tc.runtimes.values()]
      .filter((rt) => Object.keys(rt.def.tools).length > 0)
      .map((rt) => ({
        id: rt.def.id,
        label: rt.def.label,
        version: rt.version,
        healthy: usedRuntimes.has(rt.def.id),
        tools: Object.fromEntries(Object.entries(rt.tools).map(([t, p]) => [t, p !== null])),
      })),
    languages: CATALOG.languages.filter((l) => usedLanguages.has(l.key)),
    kinds: usable.map(({ k, a }) => ({
      ...k,
      actions: STEP_NAMES.filter((n) => n !== "restore" && k.steps[n]),
      missing_caches: a.missing_caches,
      ...(k.tier === "container" ? { image: imageFor(tc.containers, k.runtime) } : {}),
    })),
    unavailable: kinds.filter((x) => !x.a.available).map(({ k, a }) => ({ id: k.id, reason: a.reason ?? `missing tools: ${a.missing.join(", ")}` })),
    caches: Object.fromEntries([...new Set(CATALOG.kinds.flatMap((k) => k.caches))].sort().map((c) => [c, tc.caches.has(c)])),
  };
}

export interface DetectFile {
  path: string;
  content?: string;
}

/** POST /v1/detect: ranked kinds with their entry files. */
export function detectView(tc: Toolchains, files: DetectFile[], opts: { language?: string } = {}) {
  const paths = files.map((f) => f.path);
  const read = (p: string) => files.find((f) => f.path === p)?.content ?? null;
  const ranked = detect(paths, read).filter((d) => !opts.language || d.language === opts.language);
  const kinds = ranked.map((d) => {
    const kind = CATALOG.kinds.find((k) => k.id === d.kind)!;
    const a = availability(tc, kind);
    return {
      ...d,
      tier: kind.tier,
      entry: entryFor(kind, paths, read),
      available: a.available,
      actions: STEP_NAMES.filter((n) => n !== "restore" && kind.steps[n]),
      unit_tests: kind.steps.test ? { report: (kind.steps.test as { report: string }).report } : null,
      ...(a.available ? {} : { reason: a.reason ?? `missing tools: ${a.missing.join(", ")}` }),
    };
  });
  const best = kinds.find((k) => k.available) ?? null;
  const warnings: string[] = [];
  if (best) {
    const kind = CATALOG.kinds.find((k) => k.id === best.kind)!;
    for (const c of availability(tc, kind).missing_caches) warnings.push(`Cache layer ${c} is not installed on this runner: only dependency-free projects of this kind build.`);
    if (!best.entry && kind.steps.run) warnings.push("No entry file found for this kind.");
  } else if (kinds.length) warnings.push("This runner can't run any of the detected kinds.");
  return { kinds, best: best?.kind ?? null, entry: best?.entry ?? null, warnings };
}
