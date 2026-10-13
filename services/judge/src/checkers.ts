/**
 * Output checkers for I/O tests (CODE_RUNNER_PLAN §15.2). The default,
 * `whitespace`, is today's rule (CRLF → LF, trailing whitespace at the end
 * ignored) and the same as @tmcode/protocol `normalizeOutput`.
 */

export type CheckerType = "exact" | "whitespace" | "token" | "float" | "unordered";

export interface CheckerSpec {
  type: CheckerType;
  /** `float` only: the allowed absolute OR relative difference (default 1e-6). */
  tolerance?: number;
}

export const CHECKERS: CheckerType[] = ["exact", "whitespace", "token", "float", "unordered"];
export const DEFAULT_CHECKER: CheckerSpec = { type: "whitespace" };
export const DEFAULT_TOLERANCE = 1e-6;

/** Same rule as @tmcode/protocol `normalizeOutput` (asserted in tests). */
export function normalizeOutput(s: string | null | undefined): string {
  return (s ?? "").replace(/\r\n/g, "\n").trimEnd();
}

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function numbersClose(a: number, b: number, tol: number) {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const diff = Math.abs(a - b);
  return diff <= tol || diff <= tol * Math.abs(b);
}

function parseNumber(t: string): number | null {
  if (NUMBER.test(t)) return Number(t);
  const l = t.toLowerCase();
  if (l === "nan") return NaN;
  if (l === "inf" || l === "+inf" || l === "infinity" || l === "+infinity") return Infinity;
  if (l === "-inf" || l === "-infinity") return -Infinity;
  return null;
}

/** Lines without line endings or trailing spaces; trailing empty lines dropped. */
function lines(s: string) {
  const out = lf(s)
    .split("\n")
    .map((l) => l.trimEnd());
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Whether `actual` passes against `expected` under the checker. */
export function check(spec: CheckerSpec | undefined, expected: string, actual: string): boolean {
  const c = spec ?? DEFAULT_CHECKER;
  switch (c.type) {
    case "exact":
      // Byte-for-byte, except that CRLF and LF line endings are the same.
      return lf(actual) === lf(expected);
    case "token": {
      const a = tokens(actual);
      const e = tokens(expected);
      return a.length === e.length && a.every((t, i) => t === e[i]);
    }
    case "float": {
      const tol = c.tolerance ?? DEFAULT_TOLERANCE;
      const a = tokens(actual);
      const e = tokens(expected);
      if (a.length !== e.length) return false;
      return e.every((want, i) => {
        const x = parseNumber(want);
        const y = parseNumber(a[i]);
        return x !== null && y !== null ? numbersClose(y, x, tol) : want === a[i];
      });
    }
    case "unordered": {
      const a = lines(actual).sort();
      const e = lines(expected).sort();
      return a.length === e.length && a.every((l, i) => l === e[i]);
    }
    case "whitespace":
    default:
      return normalizeOutput(actual) === normalizeOutput(expected);
  }
}

/** Validates a request's checker; returns an error message or null. */
export function checkerProblem(spec: unknown): string | null {
  if (spec === undefined || spec === null) return null;
  if (typeof spec !== "object") return "checker must be an object { type, tolerance? }.";
  const c = spec as Partial<CheckerSpec>;
  if (!CHECKERS.includes(c.type as CheckerType)) return `Unknown checker '${String(c.type)}' (one of ${CHECKERS.join(", ")}).`;
  if (c.tolerance !== undefined && (typeof c.tolerance !== "number" || !(c.tolerance >= 0) || c.tolerance > 1e6)) return "checker.tolerance must be a non-negative number.";
  return null;
}
