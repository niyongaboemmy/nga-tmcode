/**
 * Git's `--progress` lines → one overall percentage for the progress
 * notification ("Receiving objects:  45% (450/1000)" etc.).
 */

/** Where each phase sits in the overall bar. */
const PHASES: [RegExp, number, number][] = [
  [/^enumerating objects/i, 0, 5],
  [/^counting objects/i, 5, 10],
  [/^compressing objects/i, 10, 20],
  [/^(receiving|writing) objects/i, 20, 90],
  [/^resolving deltas/i, 90, 98],
  [/^(updating files|checking out files|filtering content)/i, 98, 100],
];

export interface ParsedProgress {
  phase: string;
  /** This phase's own percentage. */
  percent: number;
  /** Mapped onto the whole operation. */
  overall: number;
}

export function parseProgress(line: string): ParsedProgress | null {
  const text = line.replace(/^remote:\s*/, "").trim();
  const m = /^([A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%/.exec(text);
  if (!m) return null;
  const phase = m[1];
  const percent = Math.min(100, parseInt(m[2], 10));
  const hit = PHASES.find(([re]) => re.test(phase));
  if (!hit) return { phase, percent, overall: -1 };
  const [, from, to] = hit;
  return { phase, percent, overall: Math.round(from + ((to - from) * percent) / 100) };
}

/** Keeps the bar moving forward only (phases restart at 0%). */
export class ProgressTracker {
  overall = 0;
  phase = "";
  update(line: string): ParsedProgress | null {
    const p = parseProgress(line);
    if (!p) return null;
    this.phase = p.phase;
    if (p.overall > this.overall) this.overall = p.overall;
    return p;
  }
}
