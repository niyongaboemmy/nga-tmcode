/**
 * Logical expressions for .logic files: a parser for the notations students
 * meet (and/or/not, & | !, ∧ ∨ ¬, ->, <->, xor, nand, nor, 0/1, T/F), truth
 * tables with every step, and what each table tells (tautology, minterms,
 * canonical sums/products, which expressions are equivalent).
 */

export type Expr =
  | { op: "var"; name: string }
  | { op: "const"; value: boolean }
  | { op: "not"; a: Expr }
  | { op: "and" | "or" | "xor" | "nand" | "nor" | "implies" | "iff"; a: Expr; b: Expr };

export class LogicError extends Error {
  constructor(
    message: string,
    public column: number,
  ) {
    super(message);
  }
}

type Tok = { t: "id" | "op" | "(" | ")" | "const"; v: string; col: number };

const OPS: [RegExp, string][] = [
  [/^(<->|<=>|↔|⇔|==|≡)/, "iff"],
  [/^(->|=>|→|⇒)/, "implies"],
  [/^(&&|&|∧|·|\*)/, "and"],
  [/^(\|\||\||∨|\+)/, "or"],
  [/^(\^|⊕|!=|≠)/, "xor"],
  [/^(!|~|¬)/, "not"],
  [/^(↑)/, "nand"],
  [/^(↓)/, "nor"],
];
const WORDS: Record<string, string> = { and: "and", or: "or", not: "not", xor: "xor", nand: "nand", nor: "nor", implies: "implies", iff: "iff", eqv: "iff" };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      i += ws[0].length;
      continue;
    }
    if (rest[0] === "(" || rest[0] === ")") {
      out.push({ t: rest[0], v: rest[0], col: i + 1 });
      i++;
      continue;
    }
    const op = OPS.find(([re]) => re.test(rest));
    if (op) {
      const m = op[0].exec(rest)![0];
      out.push({ t: "op", v: op[1], col: i + 1 });
      i += m.length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*|^[01]/.exec(rest);
    if (id) {
      const w = id[0];
      const lower = w.toLowerCase();
      if (lower in WORDS) out.push({ t: "op", v: WORDS[lower], col: i + 1 });
      else if (/^(0|1|true|false|T|F)$/.test(w)) out.push({ t: "const", v: /^(1|true|T)$/.test(w) ? "1" : "0", col: i + 1 });
      else out.push({ t: "id", v: w, col: i + 1 });
      i += w.length;
      continue;
    }
    throw new LogicError(`Unexpected "${rest[0]}"`, i + 1);
  }
  return out;
}

/** Precedence, lowest first: ↔, →, ∨/nor, ⊕, ∧/nand, ¬. → is right-associative. */
export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (...ops: string[]) => peek()?.t === "op" && ops.includes(peek()!.v);
  const end = () => (toks.length ? toks[toks.length - 1].col + toks[toks.length - 1].v.length : 1);
  const bin = (next: () => Expr, ops: string[], right = false): (() => Expr) => {
    const f = (): Expr => {
      let a = next();
      while (isOp(...ops)) {
        const op = toks[p++].v as "and";
        const b = right ? f() : next();
        a = { op, a, b };
        if (right) break;
      }
      return a;
    };
    return f;
  };
  const unary = (): Expr => {
    const t = peek();
    if (!t) throw new LogicError("The expression ends too early", end());
    if (t.t === "op" && t.v === "not") {
      p++;
      return { op: "not", a: unary() };
    }
    if (t.t === "(") {
      p++;
      const e = iff();
      if (peek()?.t !== ")") throw new LogicError("Missing )", peek()?.col ?? end());
      p++;
      return e;
    }
    if (t.t === "id") {
      p++;
      return { op: "var", name: t.v };
    }
    if (t.t === "const") {
      p++;
      return { op: "const", value: t.v === "1" };
    }
    throw new LogicError(t.t === ")" ? "Unexpected )" : `Expected a variable before "${t.v}"`, t.col);
  };
  const and = bin(unary, ["and", "nand"]);
  const xor = bin(and, ["xor"]);
  const or = bin(xor, ["or", "nor"]);
  const implies = bin(or, ["implies"], true);
  const iff = bin(implies, ["iff"]);
  const e = iff();
  if (p < toks.length) throw new LogicError(`Unexpected "${toks[p].v}"`, toks[p].col);
  return e;
}

export function variables(e: Expr, out = new Set<string>()): Set<string> {
  if (e.op === "var") out.add(e.name);
  else if (e.op === "not") variables(e.a, out);
  else if (e.op !== "const") {
    variables(e.a, out);
    variables(e.b, out);
  }
  return out;
}

export function evaluate(e: Expr, env: Record<string, boolean>): boolean {
  switch (e.op) {
    case "var":
      return !!env[e.name];
    case "const":
      return e.value;
    case "not":
      return !evaluate(e.a, env);
  }
  const a = evaluate(e.a, env);
  const b = evaluate(e.b, env);
  switch (e.op) {
    case "and":
      return a && b;
    case "or":
      return a || b;
    case "xor":
      return a !== b;
    case "nand":
      return !(a && b);
    case "nor":
      return !(a || b);
    case "implies":
      return !a || b;
    case "iff":
      return a === b;
  }
}

const SYMBOL: Record<string, string> = { and: "∧", or: "∨", xor: "⊕", nand: "↑", nor: "↓", implies: "→", iff: "↔" };
const PREC: Record<string, number> = { iff: 1, implies: 2, or: 3, nor: 3, xor: 4, and: 5, nand: 5, not: 6, var: 7, const: 7 };

/** Pretty form with the fewest brackets: ¬(A ∧ B) ∨ C. */
export function show(e: Expr, parent = 0): string {
  let s: string;
  if (e.op === "var") s = e.name;
  else if (e.op === "const") s = e.value ? "1" : "0";
  else if (e.op === "not") s = `¬${show(e.a, PREC.not)}`;
  else s = `${show(e.a, PREC[e.op])} ${SYMBOL[e.op]} ${show(e.b, PREC[e.op] + (e.op === "implies" ? 0 : 1))}`;
  return PREC[e.op] < parent ? `(${s})` : s;
}

/** Every sub-expression that isn't a variable or a constant, innermost first (the "steps" columns). */
export function steps(e: Expr, out: Expr[] = [], seen = new Set<string>()): Expr[] {
  if (e.op === "var" || e.op === "const") return out;
  if (e.op === "not") steps(e.a, out, seen);
  else {
    steps(e.a, out, seen);
    steps(e.b, out, seen);
  }
  const key = show(e);
  if (!seen.has(key)) {
    seen.add(key);
    out.push(e);
  }
  return out;
}

export const MAX_VARS = 10;

export interface LogicLine {
  line: number;
  name: string | null;
  source: string;
  expr: Expr | null;
  error: { message: string; column: number } | null;
}

/** "F = A and B", "A -> B", comments (# or //) and blank lines. */
export function parseFile(text: string): LogicLine[] {
  const out: LogicLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const code = raw.replace(/(#|\/\/).*$/, "").trim();
    if (!code) return;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=(?!=|>))\s*(.+)$/.exec(code);
    const name = m ? m[1] : null;
    const source = m ? m[2] : code;
    const offset = raw.indexOf(source) + 1;
    try {
      out.push({ line: i + 1, name, source, expr: parseExpr(source), error: null });
    } catch (e) {
      const le = e as LogicError;
      out.push({ line: i + 1, name, source, expr: null, error: { message: le.message, column: (le.column ?? 1) + offset - 1 } });
    }
  });
  return out;
}

export interface TruthTable {
  vars: string[];
  /** Steps then the expression itself (last). */
  columns: { label: string; expr: Expr }[];
  /** rows[i][j]: the value of columns[j] for the i-th assignment (vars in binary order, A first). */
  inputs: boolean[][];
  values: boolean[][];
  kind: "tautology" | "contradiction" | "contingency";
  minterms: number[];
  maxterms: number[];
  sop: string;
  pos: string;
}

export function truthTable(e: Expr, opts: { vars?: string[]; steps?: boolean } = {}): TruthTable {
  const vars = opts.vars ?? [...variables(e)].sort((a, b) => a.localeCompare(b));
  if (vars.length > MAX_VARS) throw new LogicError(`Too many variables (${vars.length}); at most ${MAX_VARS}`, 1);
  const cols = (opts.steps !== false ? steps(e) : []).filter((s) => s !== e && show(s) !== show(e));
  const columns = [...cols.map((c) => ({ label: show(c), expr: c })), { label: show(e), expr: e }];
  const inputs: boolean[][] = [];
  const values: boolean[][] = [];
  const minterms: number[] = [];
  const maxterms: number[] = [];
  const n = vars.length;
  for (let i = 0; i < 1 << n; i++) {
    const row = vars.map((_, k) => !!((i >> (n - 1 - k)) & 1));
    const env = Object.fromEntries(vars.map((v, k) => [v, row[k]]));
    const vals = columns.map((c) => evaluate(c.expr, env));
    inputs.push(row);
    values.push(vals);
    (vals[vals.length - 1] ? minterms : maxterms).push(i);
  }
  const lit = (i: number, positive: boolean) =>
    vars.map((v, k) => {
      const bit = !!((i >> (n - 1 - k)) & 1);
      return bit === positive ? v : `¬${v}`;
    });
  const sop = minterms.length === 0 ? "0" : n === 0 ? "1" : minterms.map((i) => `(${lit(i, true).join(" ∧ ")})`).join(" ∨ ");
  const pos = maxterms.length === 0 ? "1" : n === 0 ? "0" : maxterms.map((i) => `(${lit(i, false).join(" ∨ ")})`).join(" ∧ ");
  return {
    vars,
    columns,
    inputs,
    values,
    kind: maxterms.length === 0 ? "tautology" : minterms.length === 0 ? "contradiction" : "contingency",
    minterms,
    maxterms,
    sop,
    pos,
  };
}

/** Groups of lines whose expressions have the same truth table (over all their variables). */
export function equivalences(lines: LogicLine[]): number[][] {
  const ok = lines.filter((l) => l.expr);
  const groups = new Map<string, number[]>();
  for (const l of ok) {
    const vars = [...variables(l.expr!)].sort();
    const sig = `${vars.join(",")}|${truthTable(l.expr!, { vars, steps: false }).minterms.join(",")}`;
    groups.set(sig, [...(groups.get(sig) ?? []), l.line]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
