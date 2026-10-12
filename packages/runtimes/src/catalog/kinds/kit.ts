/** Helpers for writing kinds compactly. */
import type { KindDef, Limits, Token } from "../../schema";

export type KindInput = Omit<KindDef, "starters" | "caches" | "limits" | "interactive" | "enabled"> &
  Partial<Pick<KindDef, "caches" | "limits" | "interactive" | "enabled">>;

/** Fills defaults: no caches, pipes, tier-based limits, enabled when wave A. */
export function kind(k: KindInput): KindDef {
  return {
    caches: [],
    interactive: k.tier === "container" ? "pty" : k.tier === "browser" ? "none" : "pipes",
    limits: LIMITS[k.tier],
    enabled: k.wave === "A",
    ...k,
    starters: [],
  };
}

const RUN: Limits = { cpu_s: 5, wall_s: 10, memory_mb: 256, processes: 16, output_kb: 1024 };
const BUILD: Limits = { cpu_s: 20, wall_s: 40, memory_mb: 512, processes: 32, disk_mb: 256 };
const PROJECT_BUILD: Limits = { cpu_s: 60, wall_s: 120, memory_mb: 1024, processes: 128, disk_mb: 1024 };

export const LIMITS: Record<KindDef["tier"], KindDef["limits"]> = {
  browser: {},
  isolate: { build: BUILD, run: RUN },
  "isolate-build": { restore: PROJECT_BUILD, build: PROJECT_BUILD, run: { ...RUN, cpu_s: 10, wall_s: 20, memory_mb: 512, processes: 64 }, test: PROJECT_BUILD },
  container: { build: PROJECT_BUILD, test: PROJECT_BUILD, serve: { memory_mb: 1024, processes: 128, wall_s: 1800 } },
};

/** Runtimes that reserve big virtual ranges or many threads (JVM, Node, Go). */
export const MANAGED_RUN: Limits = { cpu_s: 10, wall_s: 15, memory_mb: 512, processes: 64, output_kb: 1024 };

export const entry: Token = { entry: true };
export const mainClass: Token = { main_class: true };
export const testFilter: Token = { test_filter: true };
export const report: Token = { report_path: true };
export const out = (path: string, prefix?: string): Token => (prefix ? { out: path, prefix } : { out: path });
export const sources = (ext: string | string[]): Token => ({ sources: ext });
/** The report path glued to a flag: reportTo("--junitxml=") → --junitxml=<path>. */
export const reportTo = (prefix: string): Token => ({ report_path: true, prefix });
