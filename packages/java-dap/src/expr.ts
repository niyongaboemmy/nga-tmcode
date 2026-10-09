// A small Java expression language for conditions, watches and hovers:
// literals, names, `this`, field access, array indexing, method calls,
// unary ! - +, * / %, + -, < > <= >=, == !=, &&, ||, and ?: — with Java's
// numeric promotion, int/long overflow and integer division.

export type PrimType = "I" | "J" | "S" | "B" | "C" | "F" | "D" | "Z";

export type Val =
  | { k: "prim"; t: PrimType; v: number | bigint | boolean }
  /** A VM object (id 0n is null); `tag` is the JDWP value tag. */
  | { k: "obj"; id: bigint; tag: number }
  /** A string computed by the evaluator (not an object in the VM). */
  | { k: "str"; v: string }
  /** A class named in the expression (for static members). */
  | { k: "class"; id: bigint; sig: string }
  /** The result of a void method call. */
  | { k: "void" };

export type Node =
  | { t: "lit"; v: Val }
  | { t: "name"; name: string }
  | { t: "this" }
  | { t: "field"; obj: Node; name: string }
  | { t: "index"; obj: Node; index: Node }
  | { t: "call"; obj: Node | null; name: string; args: Node[] }
  | { t: "unary"; op: string; e: Node }
  | { t: "binary"; op: string; l: Node; r: Node }
  | { t: "cond"; c: Node; a: Node; b: Node };

export class EvalError extends Error {}

export const NULL: Val = { k: "obj", id: 0n, tag: 76 };
export const TRUE: Val = { k: "prim", t: "Z", v: true };
export const FALSE: Val = { k: "prim", t: "Z", v: false };
export const int = (v: number): Extract<Val, { k: "prim" }> => ({ k: "prim", t: "I", v: v | 0 });
export const bool = (v: boolean): Val => (v ? TRUE : FALSE);

// ───────────────────────── tokenizer ─────────────────────────

type Tok = { k: "num" | "str" | "chr" | "id" | "op" | "end"; v: string; pos: number };

const OPS = ["||", "&&", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", "[", "]", ".", ",", "?", ":"];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(0[xX][0-9a-fA-F_]+[lL]?|0[bB][01_]+[lL]?|(?:[0-9][0-9_]*)?\.?[0-9_]*(?:[eE][+-]?[0-9]+)?[fFdDlL]?)/.exec(src.slice(i))!;
      out.push({ k: "num", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          const e = src[j + 1];
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0", "\\": "\\", "'": "'", '"': '"' };
          if (e === "u") {
            s += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          s += map[e] ?? e;
          j += 2;
        } else s += src[j++];
      }
      if (src[j] !== c) throw new EvalError(`unterminated ${c === '"' ? "string" : "character"} literal`);
      out.push({ k: c === '"' ? "str" : "chr", v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new EvalError(`unexpected '${c}'`);
    out.push({ k: "op", v: op, pos: i });
    i += op.length;
  }
  out.push({ k: "end", v: "", pos: src.length });
  return out;
}

// ───────────────────────── parser ─────────────────────────

export function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => toks[p].k === "op" && toks[p].v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new EvalError(`expected '${v}'${toks[p].k === "end" ? " at end" : ` near '${toks[p].v}'`}`);
    p++;
  };

  const binaryLevel = (ops: string[], next: () => Node) => (): Node => {
    let l = next();
    while (toks[p].k === "op" && ops.includes(toks[p].v)) {
      const op = toks[p++].v;
      l = { t: "binary", op, l, r: next() };
    }
    return l;
  };

  const unary = (): Node => {
    if (isOp("!") || isOp("-") || isOp("+")) {
      const op = toks[p++].v;
      return { t: "unary", op, e: unary() };
    }
    return postfix();
  };
  const mul = binaryLevel(["*", "/", "%"], unary);
  const add = binaryLevel(["+", "-"], mul);
  const rel = binaryLevel(["<", ">", "<=", ">="], add);
  const eq = binaryLevel(["==", "!="], rel);
  const and = binaryLevel(["&&"], eq);
  const or = binaryLevel(["||"], and);
  const cond = (): Node => {
    const c = or();
    if (!isOp("?")) return c;
    p++;
    const a = cond();
    expect(":");
    const b = cond();
    return { t: "cond", c, a, b };
  };

  const args = (): Node[] => {
    expect("(");
    const out: Node[] = [];
    if (!isOp(")")) {
      out.push(cond());
      while (isOp(",")) {
        p++;
        out.push(cond());
      }
    }
    expect(")");
    return out;
  };

  function postfix(): Node {
    let e = primary();
    for (;;) {
      if (isOp(".")) {
        p++;
        const t = peek();
        if (t.k !== "id") throw new EvalError("expected a name after '.'");
        p++;
        e = isOp("(") ? { t: "call", obj: e, name: t.v, args: args() } : { t: "field", obj: e, name: t.v };
      } else if (isOp("[")) {
        p++;
        const index = cond();
        expect("]");
        e = { t: "index", obj: e, index };
      } else return e;
    }
  }

  function primary(): Node {
    const t = toks[p];
    if (t.k === "num") {
      p++;
      return { t: "lit", v: numberLiteral(t.v) };
    }
    if (t.k === "str") {
      p++;
      return { t: "lit", v: { k: "str", v: t.v } };
    }
    if (t.k === "chr") {
      p++;
      if (t.v.length !== 1) throw new EvalError("bad character literal");
      return { t: "lit", v: { k: "prim", t: "C", v: t.v.charCodeAt(0) } };
    }
    if (t.k === "id") {
      p++;
      if (t.v === "true") return { t: "lit", v: TRUE };
      if (t.v === "false") return { t: "lit", v: FALSE };
      if (t.v === "null") return { t: "lit", v: NULL };
      if (t.v === "this") return { t: "this" };
      if (isOp("(")) return { t: "call", obj: null, name: t.v, args: args() };
      return { t: "name", name: t.v };
    }
    if (isOp("(")) {
      p++;
      const e = cond();
      expect(")");
      return e;
    }
    throw new EvalError(t.k === "end" ? "unexpected end of expression" : `unexpected '${t.v}'`);
  }

  if (toks[0].k === "end") throw new EvalError("empty expression");
  const e = cond();
  if (toks[p].k !== "end") throw new EvalError(`unexpected '${toks[p].v}'`);
  return e;
}

function numberLiteral(raw: string): Val {
  const s = raw.replace(/_/g, "");
  if (/^0[xX]/.test(s) || /^0[bB]/.test(s)) {
    const long = /[lL]$/.test(s);
    const body = long ? s.slice(0, -1) : s;
    const big = BigInt(body.replace(/^0[bB]/, "0b"));
    return long ? { k: "prim", t: "J", v: BigInt.asIntN(64, big) } : { k: "prim", t: "I", v: Number(BigInt.asIntN(32, big)) };
  }
  if (/[lL]$/.test(s)) return { k: "prim", t: "J", v: BigInt(s.slice(0, -1)) };
  if (/[fF]$/.test(s)) return { k: "prim", t: "F", v: Math.fround(Number(s.slice(0, -1))) };
  if (/[dD]$/.test(s) || /[.eE]/.test(s)) return { k: "prim", t: "D", v: Number(s.replace(/[dD]$/, "")) };
  const n = Number(s);
  if (!Number.isFinite(n) || n > 2147483648) throw new EvalError(`integer number too large: ${raw}`);
  return { k: "prim", t: "I", v: n | 0 };
}

// ───────────────────────── Java arithmetic ─────────────────────────

type Prim = Extract<Val, { k: "prim" }>;

function promoted(a: Prim, b: Prim): "I" | "J" | "F" | "D" {
  if (a.t === "Z" || b.t === "Z") throw new EvalError("bad operand types: boolean in arithmetic");
  if (a.t === "D" || b.t === "D") return "D";
  if (a.t === "F" || b.t === "F") return "F";
  if (a.t === "J" || b.t === "J") return "J";
  return "I";
}

const asNumber = (p: Prim) => (typeof p.v === "bigint" ? Number(p.v) : Number(p.v));
const asBig = (p: Prim) => (typeof p.v === "bigint" ? p.v : BigInt(Math.trunc(Number(p.v))));

/** Unary minus/plus on a primitive (with int/long promotion). */
export function negate(a: Prim, op: "-" | "+"): Val {
  const t = promoted(a, int(0) as Prim);
  if (op === "+") return t === "J" ? { k: "prim", t, v: asBig(a) } : { k: "prim", t, v: asNumber(a) };
  if (t === "J") return { k: "prim", t, v: BigInt.asIntN(64, -asBig(a)) };
  if (t === "I") return int(-asNumber(a));
  if (t === "F") return { k: "prim", t, v: Math.fround(-asNumber(a)) };
  return { k: "prim", t, v: -asNumber(a) };
}

/** `* / % + -` on two primitives with Java semantics. */
export function arith(op: string, a: Prim, b: Prim): Val {
  const t = promoted(a, b);
  if (t === "J") {
    const x = asBig(a);
    const y = asBig(b);
    if ((op === "/" || op === "%") && y === 0n) throw new EvalError("java.lang.ArithmeticException: / by zero");
    const r = op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : op === "/" ? x / y : x % y;
    return { k: "prim", t, v: BigInt.asIntN(64, r) };
  }
  const x = asNumber(a);
  const y = asNumber(b);
  if (t === "I") {
    if ((op === "/" || op === "%") && y === 0) throw new EvalError("java.lang.ArithmeticException: / by zero");
    const r = op === "+" ? x + y : op === "-" ? x - y : op === "*" ? Math.imul(x, y) : op === "/" ? Math.trunc(x / y) : x % y;
    return int(r);
  }
  const r = op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : op === "/" ? x / y : x % y;
  return { k: "prim", t, v: t === "F" ? Math.fround(r) : r };
}

/** `< > <= >= == !=` on two primitives. */
export function compare(op: string, a: Prim, b: Prim): Val {
  if (a.t === "Z" || b.t === "Z") {
    if (a.t !== b.t) throw new EvalError(`incomparable types: ${typeName(a.t)} and ${typeName(b.t)}`);
    if (op === "==") return bool(a.v === b.v);
    if (op === "!=") return bool(a.v !== b.v);
    throw new EvalError(`bad operand types for ${op}: boolean`);
  }
  const t = promoted(a, b);
  let c: number;
  if (t === "J") {
    const x = asBig(a);
    const y = asBig(b);
    c = x < y ? -1 : x > y ? 1 : 0;
  } else {
    const x = asNumber(a);
    const y = asNumber(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return bool(op === "!=");
    c = x < y ? -1 : x > y ? 1 : 0;
  }
  switch (op) {
    case "<":
      return bool(c < 0);
    case ">":
      return bool(c > 0);
    case "<=":
      return bool(c <= 0);
    case ">=":
      return bool(c >= 0);
    case "==":
      return bool(c === 0);
    default:
      return bool(c !== 0);
  }
}

export function typeName(t: PrimType): string {
  return { I: "int", J: "long", S: "short", B: "byte", C: "char", F: "float", D: "double", Z: "boolean" }[t];
}

// ───────────────────────── Java-style formatting ─────────────────────────

/** Formats a double the way Double.toString does (1.0, 0.1, 1.0E10, 1.0E-5). */
export function formatDouble(x: number, float = false): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  let digits: string;
  if (float) {
    // Shortest decimal that round-trips through float32.
    digits = String(x);
    for (let p = 1; p <= 9; p++) {
      const s = x.toPrecision(p);
      if (Math.fround(Number(s)) === x) {
        digits = String(Number(s));
        break;
      }
    }
  } else digits = String(x);
  const v = Number(digits);
  const abs = Math.abs(v);
  if (abs >= 1e-3 && abs < 1e7) {
    const s = /e/i.test(digits) ? v.toFixed(20).replace(/0+$/, "") : digits;
    return s.includes(".") ? (s.endsWith(".") ? s + "0" : s) : s + ".0";
  }
  const [mant, exp] = v.toExponential().split("e");
  return `${mant.includes(".") ? mant : mant + ".0"}E${exp.replace("+", "")}`;
}

export function formatChar(code: number): string {
  return `'${escapeJava(String.fromCharCode(code), "'")}'`;
}

export function quoteString(s: string): string {
  return `"${escapeJava(s, '"')}"`;
}

function escapeJava(s: string, quote: string): string {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\0":
        out += "\\0";
        break;
      case "\\":
        out += "\\\\";
        break;
      default:
        out += ch === quote ? `\\${ch}` : ch;
    }
  }
  return out;
}

/** A primitive as Java prints it (chars quoted when `quoteChars`). */
export function formatPrim(p: Prim, quoteChars = true): string {
  switch (p.t) {
    case "Z":
      return String(p.v);
    case "C":
      return quoteChars ? formatChar(Number(p.v)) : String.fromCharCode(Number(p.v));
    case "F":
      return formatDouble(Number(p.v), true);
    case "D":
      return formatDouble(Number(p.v));
    default:
      return String(p.v);
  }
}
