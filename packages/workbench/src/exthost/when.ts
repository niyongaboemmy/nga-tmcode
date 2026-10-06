/**
 * VS Code `when` clauses (https://code.visualstudio.com/api/references/when-clause-contexts),
 * the subset extensions use in menus and keybindings: `!`, `&&`, `||`,
 * parentheses, `==` / `!=` / `===` / `!==`, `<` `<=` `>` `>=`, `=~ /re/flags`,
 * `in` / `not in`, `true` / `false`, quoted strings and bare words. Unknown
 * context keys are undefined (falsy), as in VS Code.
 */

export type Context = (key: string) => unknown;

type Token = { t: "op"; v: string } | { t: "word"; v: string } | { t: "str"; v: string } | { t: "re"; v: RegExp | null } | { t: "end" };

const OPS = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "=~", "!", "(", ")", "<", ">"];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      out.push({ t: "str", v: end < 0 ? src.slice(i + 1) : src.slice(i + 1, end) });
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    // A regex literal follows =~.
    const prev = out[out.length - 1];
    if (c === "/" && prev?.t === "op" && prev.v === "=~") {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "[") (inClass = true), j++;
        else if (src[j] === "]") (inClass = false), j++;
        else if (src[j] === "/" && !inClass) break;
        else j++;
      }
      let k = j + 1;
      while (k < src.length && /[a-z]/i.test(src[k])) k++;
      let re: RegExp | null = null;
      try {
        re = new RegExp(src.slice(i + 1, j), src.slice(j + 1, k).replace(/[^gimsuy]/g, ""));
      } catch {
        re = null;
      }
      out.push({ t: "re", v: re });
      i = k;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s()!=<>&|'"]/.test(src[j])) j++;
    if (j === i) j = i + 1;
    out.push({ t: "word", v: src.slice(i, j) });
    i = j;
  }
  out.push({ t: "end" });
  return out;
}

type Node =
  | { k: "lit"; v: unknown }
  | { k: "key"; v: string }
  | { k: "not"; e: Node }
  | { k: "and" | "or"; a: Node; b: Node }
  | { k: "cmp"; op: string; key: string; v: unknown }
  | { k: "re"; key: string; re: RegExp | null }
  | { k: "in"; key: string; list: string; negate: boolean };

function literal(word: string): unknown {
  if (word === "true") return true;
  if (word === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(word)) return Number(word);
  return word;
}

function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (v: string) => peek().t === "op" && (peek() as { v: string }).v === v;
  const wordOrStr = (t: Token) => (t.t === "word" || t.t === "str" ? t.v : "");

  const primary = (): Node => {
    const tok = next();
    if (tok.t === "op" && tok.v === "!") return { k: "not", e: primary() };
    if (tok.t === "op" && tok.v === "(") {
      const e = or();
      if (isOp(")")) next();
      return e;
    }
    if (tok.t === "str") return { k: "lit", v: tok.v };
    if (tok.t !== "word") return { k: "lit", v: false };
    const word = tok.v;
    if (word === "true" || word === "false") return { k: "lit", v: word === "true" };
    const p = peek();
    if (p.t === "op" && ["==", "!=", "===", "!==", "<", "<=", ">", ">="].includes(p.v)) {
      next();
      const rhs = next();
      const v = rhs.t === "str" ? rhs.v : rhs.t === "word" ? literal(rhs.v) : undefined;
      return { k: "cmp", op: p.v.length === 3 ? p.v.slice(0, 2) : p.v, key: word, v };
    }
    if (p.t === "op" && p.v === "=~") {
      next();
      const rhs = next();
      return { k: "re", key: word, re: rhs.t === "re" ? rhs.v : null };
    }
    if (p.t === "word" && p.v === "in") {
      next();
      return { k: "in", key: word, list: wordOrStr(next()), negate: false };
    }
    if (p.t === "word" && p.v === "not" && tokens[pos + 1]?.t === "word" && (tokens[pos + 1] as { v: string }).v === "in") {
      next();
      next();
      return { k: "in", key: word, list: wordOrStr(next()), negate: true };
    }
    return { k: "key", v: word };
  };
  const and = (): Node => {
    let a = primary();
    while (isOp("&&")) {
      next();
      a = { k: "and", a, b: primary() };
    }
    return a;
  };
  const or = (): Node => {
    let a = and();
    while (isOp("||")) {
      next();
      a = { k: "or", a, b: and() };
    }
    return a;
  };
  return or();
}

function evaluate(n: Node, ctx: Context): boolean {
  switch (n.k) {
    case "lit":
      return !!n.v;
    case "key":
      return !!ctx(n.v);
    case "not":
      return !evaluate(n.e, ctx);
    case "and":
      return evaluate(n.a, ctx) && evaluate(n.b, ctx);
    case "or":
      return evaluate(n.a, ctx) || evaluate(n.b, ctx);
    case "cmp": {
      const left = ctx(n.key);
      // Loose, as VS Code compares string forms ("1" == 1).
      const eq = left === n.v || (left !== undefined && String(left) === String(n.v));
      if (n.op === "==") return eq;
      if (n.op === "!=") return !eq;
      const a = Number(left);
      const b = Number(n.v);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return n.op === "<" ? a < b : n.op === "<=" ? a <= b : n.op === ">" ? a > b : a >= b;
    }
    case "re": {
      const v = ctx(n.key);
      return !!n.re && typeof v === "string" && n.re.test(v);
    }
    case "in": {
      const item = ctx(n.key);
      const list = ctx(n.list);
      let hit = false;
      if (Array.isArray(list)) hit = list.includes(item);
      else if (list && typeof list === "object" && typeof item === "string") hit = Object.prototype.hasOwnProperty.call(list, item);
      return n.negate ? !hit : hit;
    }
  }
}

const cache = new Map<string, Node>();

/** Evaluates a when clause; empty or missing means "always". */
export function evaluateWhen(when: string | undefined | null, ctx: Context): boolean {
  if (!when || !when.trim()) return true;
  let node = cache.get(when);
  if (!node) {
    try {
      node = parse(tokenize(when));
    } catch {
      node = { k: "lit", v: false };
    }
    if (cache.size > 1000) cache.clear();
    cache.set(when, node);
  }
  return evaluate(node, ctx);
}
