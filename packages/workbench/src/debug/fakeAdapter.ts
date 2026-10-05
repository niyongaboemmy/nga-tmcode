/**
 * A scripted, in-memory Debug Adapter for the browser build (dev server,
 * Playwright, unit tests). It "runs" straight-line Python one line at a time —
 * assignments, augmented assignments, `print(...)`, `list.append(...)` and
 * expressions over numbers, strings, booleans and lists — so the whole Run and
 * Debug UI (breakpoints, stepping, variables, watch, debug console) can be
 * exercised without a real interpreter. Lines it doesn't understand (def, for,
 * if, import …) are stepped over as no-ops.
 *
 * It speaks real DAP JSON over `receive` / `emit`, exactly like a desktop adapter.
 */

import type { DebugHost } from "../platform/types";
import { DapFrameReader, encodeMessage } from "./dap";

type Value = number | string | boolean | null | Value[];

export class PyError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

// ───────────── expressions ─────────────

type Tok = { t: "num"; v: number } | { t: "str"; v: string } | { t: "id"; v: string } | { t: "op"; v: string } | { t: "end" };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^[0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))![0];
      out.push({ t: "num", v: Number(m.replace(/_/g, "")) });
      i += m.length;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[++j];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
        } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new PyError("SyntaxError", "unterminated string literal");
      out.push({ t: "str", v: s });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))![0];
      out.push({ t: "id", v: m });
      i += m.length;
    } else {
      const two = src.slice(i, i + 2);
      if (["//", "**", "==", "!=", "<=", ">="].includes(two)) {
        out.push({ t: "op", v: two });
        i += 2;
      } else if ("+-*/%()[],<>.".includes(c)) {
        out.push({ t: "op", v: c });
        i++;
      } else throw new PyError("SyntaxError", `invalid character '${c}'`);
    }
  }
  out.push({ t: "end" });
  return out;
}

export function typeName(v: Value): string {
  if (v === null) return "NoneType";
  if (Array.isArray(v)) return "list";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "str";
  return Number.isInteger(v) ? "int" : "float";
}

export function repr(v: Value): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
  if (Array.isArray(v)) return `[${v.map(repr).join(", ")}]`;
  return String(v);
}

function str(v: Value): string {
  return typeof v === "string" ? v : repr(v);
}

function num(v: Value, op: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new PyError("TypeError", `unsupported operand type(s) for ${op}: '${typeName(v)}'`);
}

const BUILTINS: Record<string, (args: Value[]) => Value> = {
  len: ([x]) => {
    if (typeof x === "string" || Array.isArray(x)) return x.length;
    throw new PyError("TypeError", `object of type '${typeName(x)}' has no len()`);
  },
  sum: ([x]) => (Array.isArray(x) ? x.reduce<number>((a, b) => a + num(b, "+"), 0) : num(x, "sum")),
  max: (a) => Math.max(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map((v) => num(v, "max"))),
  min: (a) => Math.min(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map((v) => num(v, "min"))),
  abs: ([x]) => Math.abs(num(x, "abs")),
  str: ([x]) => str(x ?? ""),
  int: ([x]) => {
    const n = typeof x === "string" ? Number(x.trim()) : num(x, "int");
    if (Number.isNaN(n)) throw new PyError("ValueError", `invalid literal for int() with base 10: ${repr(x)}`);
    return Math.trunc(n);
  },
  float: ([x]) => Number(typeof x === "string" ? x.trim() : num(x, "float")),
  round: ([x, n]) => {
    const d = n == null ? 0 : num(n, "round");
    const f = 10 ** d;
    return Math.round(num(x, "round") * f) / f;
  },
  list: ([x]) => (Array.isArray(x) ? [...x] : typeof x === "string" ? [...x] : []),
};

/** Evaluates a Python expression over `vars` (a small but honest subset). */
export function evaluate(src: string, vars: Map<string, Value>): Value {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek().t === "op" && (peek() as { v: string }).v === v;
  const isId = (v: string) => peek().t === "id" && (peek() as { v: string }).v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new PyError("SyntaxError", "invalid syntax");
    p++;
  };

  const orExpr = (): Value => {
    let l = andExpr();
    while (isId("or")) {
      p++;
      const r = andExpr();
      l = truthy(l) ? l : r;
    }
    return l;
  };
  const andExpr = (): Value => {
    let l = notExpr();
    while (isId("and")) {
      p++;
      const r = notExpr();
      l = truthy(l) ? r : l;
    }
    return l;
  };
  const notExpr = (): Value => {
    if (isId("not")) {
      p++;
      return !truthy(notExpr());
    }
    return comparison();
  };
  const comparison = (): Value => {
    let l = additive();
    for (;;) {
      const t = peek();
      if (t.t !== "op" || !["==", "!=", "<", ">", "<=", ">="].includes(t.v)) return l;
      p++;
      const r = additive();
      const eq = repr(l) === repr(r);
      if (t.v === "==") l = eq;
      else if (t.v === "!=") l = !eq;
      else {
        const [a, b] = typeof l === "string" && typeof r === "string" ? [l, r] : [num(l, t.v), num(r, t.v)];
        l = t.v === "<" ? a < b : t.v === ">" ? a > b : t.v === "<=" ? a <= b : a >= b;
      }
    }
  };
  const additive = (): Value => {
    let l = term();
    while (isOp("+") || isOp("-")) {
      const op = (toks[p++] as { v: string }).v;
      const r = term();
      if (op === "+" && typeof l === "string" && typeof r === "string") l = l + r;
      else if (op === "+" && Array.isArray(l) && Array.isArray(r)) l = [...l, ...r];
      else if (op === "+" && (typeof l === "string" || typeof r === "string")) throw new PyError("TypeError", `can only concatenate str (not "${typeName(typeof l === "string" ? r : l)}") to str`);
      else l = op === "+" ? num(l, op) + num(r, op) : num(l, op) - num(r, op);
    }
    return l;
  };
  const term = (): Value => {
    let l = unary();
    while (isOp("*") || isOp("/") || isOp("//") || isOp("%")) {
      const op = (toks[p++] as { v: string }).v;
      const r = unary();
      if (op === "*" && typeof l === "string") {
        l = l.repeat(Math.max(0, num(r, op)));
        continue;
      }
      const a = num(l, op);
      const b = num(r, op);
      if (op !== "*" && b === 0) throw new PyError("ZeroDivisionError", op === "%" ? "integer modulo by zero" : "division by zero");
      if (op === "*") l = a * b;
      else if (op === "/") l = a / b;
      else if (op === "//") l = Math.floor(a / b);
      else l = ((a % b) + b) % b;
    }
    return l;
  };
  const unary = (): Value => {
    if (isOp("-")) {
      p++;
      return -num(unary(), "-");
    }
    if (isOp("+")) {
      p++;
      return num(unary(), "+");
    }
    return postfix();
  };
  const postfix = (): Value => {
    let v = atom();
    while (isOp("[")) {
      p++;
      const i = orExpr();
      expect("]");
      if (!Array.isArray(v) && typeof v !== "string") throw new PyError("TypeError", `'${typeName(v)}' object is not subscriptable`);
      const n = num(i, "[]");
      const idx = n < 0 ? v.length + n : n;
      if (idx < 0 || idx >= v.length) throw new PyError("IndexError", `${Array.isArray(v) ? "list" : "string"} index out of range`);
      v = v[idx];
    }
    return v;
  };
  const atom = (): Value => {
    const t = toks[p++];
    if (t.t === "num") return t.v;
    if (t.t === "str") {
      let s = t.v;
      while (peek().t === "str") s += (toks[p++] as { v: string }).v; // implicit concatenation
      return s;
    }
    if (t.t === "op" && t.v === "(") {
      const v = orExpr();
      expect(")");
      return v;
    }
    if (t.t === "op" && t.v === "[") {
      const items: Value[] = [];
      while (!isOp("]")) {
        items.push(orExpr());
        if (!isOp("]")) expect(",");
      }
      p++;
      return items;
    }
    if (t.t === "id") {
      if (t.v === "True") return true;
      if (t.v === "False") return false;
      if (t.v === "None") return null;
      if (isOp("(") && BUILTINS[t.v]) {
        p++;
        const args: Value[] = [];
        while (!isOp(")")) {
          args.push(orExpr());
          if (!isOp(")")) expect(",");
        }
        p++;
        return BUILTINS[t.v](args);
      }
      if (!vars.has(t.v)) throw new PyError("NameError", `name '${t.v}' is not defined`);
      return vars.get(t.v)!;
    }
    throw new PyError("SyntaxError", "invalid syntax");
  };

  const v = orExpr();
  if (peek().t !== "end") throw new PyError("SyntaxError", "invalid syntax");
  return v;
}

function truthy(v: Value) {
  if (Array.isArray(v) || typeof v === "string") return v.length > 0;
  return !!v;
}

/** Splits `print(a, b)` arguments at top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if ("([".includes(c)) depth++;
    else if (")]".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((a) => a.trim());
}

function stripComment(line: string) {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** Runs one statement. Returns printed text (if any). */
export function execute(stmt: string, vars: Map<string, Value>): string | null {
  const s = stripComment(stmt).trim();
  if (!s || s.endsWith(":") || /^(def|class|import|from|return|pass|break|continue|global|elif|else)\b/.test(s)) return null;
  const print = /^print\((.*)\)$/.exec(s);
  if (print) return `${splitArgs(print[1]).map((a) => str(evaluate(a, vars))).join(" ")}\n`;
  const append = /^([A-Za-z_]\w*)\.append\((.*)\)$/.exec(s);
  if (append) {
    const list = vars.get(append[1]);
    if (!vars.has(append[1])) throw new PyError("NameError", `name '${append[1]}' is not defined`);
    if (!Array.isArray(list)) throw new PyError("AttributeError", `'${typeName(list!)}' object has no attribute 'append'`);
    list.push(evaluate(append[2], vars));
    return null;
  }
  const aug = /^([A-Za-z_]\w*)\s*([+\-*/])=\s*(.+)$/.exec(s);
  if (aug) {
    if (!vars.has(aug[1])) throw new PyError("NameError", `name '${aug[1]}' is not defined`);
    vars.set(aug[1], evaluate(`(${repr(vars.get(aug[1])!)}) ${aug[2]} (${aug[3]})`, vars));
    return null;
  }
  const assign = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(s);
  if (assign) {
    vars.set(assign[1], evaluate(assign[2], vars));
    return null;
  }
  evaluate(s, vars);
  return null;
}

// ───────────── the adapter ─────────────

interface Bp {
  id: number;
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  hits: number;
}

const LOCALS = 1;
const THREAD = 1;
const FRAME = 1;

export class FakeDebugAdapter {
  private seq = 1;
  private path = "";
  private name = "";
  private lines: string[] = [];
  private pc = -1;
  private vars = new Map<string, Value>();
  private bps = new Map<string, Bp[]>();
  private bpSeq = 1;
  private filters: string[] = [];
  private refs = new Map<number, Value[]>();
  private nextRef = 100;
  private stopOnEntry = false;
  private finished = false;
  private pendingError: PyError | null = null;

  constructor(
    private readFile: (path: string) => Promise<string>,
    private emitRaw: (json: string) => void,
    /** Adapter-reported delay so the UI sees real asynchrony. */
    private delay = 5,
  ) {}

  private send(msg: Record<string, unknown>) {
    const json = JSON.stringify({ seq: this.seq++, ...msg });
    setTimeout(() => this.emitRaw(json), this.delay);
  }
  private event(event: string, body: Record<string, unknown> = {}) {
    this.send({ type: "event", event, body });
  }
  private respond(req: { seq: number; command: string }, body: unknown = {}, error?: string) {
    this.send({ type: "response", request_seq: req.seq, command: req.command, success: !error, message: error, body });
  }

  receive(json: string) {
    const req = JSON.parse(json) as { seq: number; type: string; command: string; arguments?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (req.type !== "request") return;
    void this.handle(req).catch((e) => this.respond(req, {}, String(e?.message ?? e)));
  }

  private async handle(req: { seq: number; command: string; arguments?: any }) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const a = req.arguments ?? {};
    switch (req.command) {
      case "initialize":
        return this.respond(req, {
          supportsConfigurationDoneRequest: true,
          supportsConditionalBreakpoints: true,
          supportsHitConditionalBreakpoints: true,
          supportsLogPoints: true,
          supportsEvaluateForHovers: true,
          supportsSetVariable: true,
          supportsRestartRequest: true,
          supportsTerminateRequest: true,
          supportsExceptionInfoRequest: true,
          exceptionBreakpointFilters: [
            { filter: "raised", label: "Raised Exceptions", default: false },
            { filter: "uncaught", label: "Uncaught Exceptions", default: true },
          ],
        });
      case "launch": {
        this.path = String(a.program ?? "");
        this.name = this.path.split("/").pop() ?? this.path;
        this.stopOnEntry = !!a.stopOnEntry;
        this.lines = (await this.readFile(this.path)).split(/\r?\n/);
        this.respond(req);
        this.event("initialized");
        return;
      }
      case "setBreakpoints": {
        const path = String(a.source?.path ?? "");
        const list: Bp[] = (a.breakpoints ?? []).map((b: { line: number; condition?: string; hitCondition?: string; logMessage?: string }) => ({
          id: this.bpSeq++,
          line: path === this.path || !this.lines.length ? this.adjust(b.line) : b.line,
          condition: b.condition,
          hitCondition: b.hitCondition,
          logMessage: b.logMessage,
          hits: 0,
        }));
        this.bps.set(path, list);
        return this.respond(req, {
          breakpoints: list.map((b) => ({ id: b.id, verified: b.line > 0, line: b.line > 0 ? b.line : undefined, source: { path }, message: b.line > 0 ? undefined : "No code on or after this line" })),
        });
      }
      case "setExceptionBreakpoints":
        this.filters = a.filters ?? [];
        return this.respond(req);
      case "configurationDone":
        this.respond(req);
        this.event("process", { name: this.path, startMethod: "launch", isLocalProcess: false });
        this.event("thread", { reason: "started", threadId: THREAD });
        this.begin();
        return;
      case "threads":
        return this.respond(req, { threads: [{ id: THREAD, name: "MainThread" }] });
      case "stackTrace":
        return this.respond(req, {
          stackFrames: this.pc >= 0 && !this.finished ? [{ id: FRAME, name: "<module>", source: { name: this.name, path: this.path }, line: this.pc + 1, column: 1 }] : [],
          totalFrames: 1,
        });
      case "scopes":
        return this.respond(req, { scopes: [{ name: "Locals", presentationHint: "locals", variablesReference: LOCALS, expensive: false }] });
      case "variables":
        return this.respond(req, { variables: this.variables(a.variablesReference) });
      case "evaluate":
        return this.evaluateRequest(req, String(a.expression ?? ""), a.context);
      case "setVariable": {
        const v = evaluate(String(a.value), this.vars);
        if (a.variablesReference === LOCALS) this.vars.set(String(a.name), v);
        else {
          const list = this.refs.get(a.variablesReference);
          const i = Number(String(a.name).replace(/[[\]]/g, ""));
          if (!list || !(i in list)) throw new Error(`Cannot set ${a.name}`);
          list[i] = v;
        }
        return this.respond(req, this.describe(v));
      }
      case "exceptionInfo":
        return this.respond(req, { exceptionId: this.pendingError?.kind ?? "Exception", description: this.pendingError?.message ?? "", breakMode: "unhandled" });
      case "continue":
        this.respond(req, { allThreadsContinued: true });
        return this.resume("continue");
      case "next":
      case "stepIn":
      case "stepOut":
        this.respond(req);
        return this.resume("step");
      case "pause":
        this.respond(req);
        return this.stop("pause");
      case "restart":
        this.respond(req);
        this.vars.clear();
        this.finished = false;
        this.pendingError = null;
        this.bps.forEach((list) => list.forEach((b) => (b.hits = 0)));
        this.begin();
        return;
      case "terminate":
      case "disconnect":
        this.respond(req);
        if (!this.finished) this.finish(null);
        return;
      default:
        return this.respond(req, {}, `Unrecognized request '${req.command}'`);
    }
  }

  private isCode(i: number) {
    return i >= 0 && i < this.lines.length && stripComment(this.lines[i]).trim() !== "";
  }

  /** A breakpoint on a blank line or comment moves to the next line of code (1-based; 0 = none). */
  private adjust(line: number) {
    for (let i = line - 1; i < this.lines.length; i++) if (this.isCode(i)) return i + 1;
    return 0;
  }

  private nextLine(from: number) {
    for (let i = from + 1; i < this.lines.length; i++) if (this.isCode(i)) return i;
    return -1;
  }

  private begin() {
    this.pc = this.nextLine(-1);
    if (this.pc < 0) return this.finish(0);
    if (this.stopOnEntry) return this.stop("entry");
    if (this.hitBreakpoint()) return this.stop("breakpoint");
    this.resume("continue");
  }

  private hitBreakpoint(): boolean {
    for (const bp of this.bps.get(this.path) ?? []) {
      if (bp.line !== this.pc + 1) continue;
      try {
        if (bp.condition && !truthy(evaluate(bp.condition, this.vars))) continue;
      } catch {
        continue;
      }
      bp.hits++;
      if (bp.hitCondition) {
        const n = Number(bp.hitCondition.replace(/[^0-9]/g, ""));
        if (bp.hitCondition.trim().startsWith(">=") ? bp.hits < n : bp.hits !== n) continue;
      }
      if (bp.logMessage) {
        const text = bp.logMessage.replace(/\{([^}]+)\}/g, (_, e: string) => {
          try {
            return str(evaluate(e, this.vars));
          } catch (err) {
            return `<${(err as Error).message}>`;
          }
        });
        this.event("output", { category: "console", output: `${text}\n` });
        continue;
      }
      return true;
    }
    return false;
  }

  private resume(mode: "continue" | "step") {
    if (this.finished) return;
    this.event("continued", { threadId: THREAD, allThreadsContinued: true });
    if (this.pendingError) {
      const e = this.pendingError;
      return this.crash(e);
    }
    // Run lines until a stop condition (bounded so a mistake can't hang the page).
    for (let guard = 0; guard < 100_000; guard++) {
      try {
        const printed = execute(this.lines[this.pc], this.vars);
        if (printed) this.event("output", { category: "stdout", output: printed });
      } catch (e) {
        const err = e instanceof PyError ? e : new PyError("Exception", String((e as Error)?.message ?? e));
        if (this.filters.includes("uncaught") || this.filters.includes("raised")) {
          this.pendingError = err;
          return this.stop("exception", `${err.kind}: ${err.message}`);
        }
        return this.crash(err);
      }
      this.pc = this.nextLine(this.pc);
      if (this.pc < 0) return this.finish(0);
      if (mode === "step") return this.stop("step");
      if (this.hitBreakpoint()) return this.stop("breakpoint");
    }
  }

  private crash(err: PyError) {
    this.event("output", {
      category: "stderr",
      output: `Traceback (most recent call last):\n  File "${this.path}", line ${this.pc + 1}, in <module>\n    ${this.lines[this.pc].trim()}\n${err.kind}: ${err.message}\n`,
    });
    this.finish(1);
  }

  private stop(reason: string, text?: string) {
    this.refs.clear();
    const ids = (this.bps.get(this.path) ?? []).filter((b) => b.line === this.pc + 1).map((b) => b.id);
    this.event("stopped", { reason, threadId: THREAD, allThreadsStopped: true, description: text ? `Paused on exception` : undefined, text, hitBreakpointIds: reason === "breakpoint" ? ids : undefined });
  }

  private finish(code: number | null) {
    this.finished = true;
    this.pc = -1;
    if (code !== null) this.event("exited", { exitCode: code });
    this.event("terminated");
  }

  private describe(v: Value) {
    let variablesReference = 0;
    if (Array.isArray(v) && v.length) {
      variablesReference = this.nextRef++;
      this.refs.set(variablesReference, v);
    }
    return { value: repr(v), result: repr(v), type: typeName(v), variablesReference, indexedVariables: Array.isArray(v) ? v.length : undefined };
  }

  private variables(ref: number) {
    if (ref === LOCALS) {
      return [...this.vars.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, v]) => ({ name, evaluateName: name, ...this.describe(v) }));
    }
    const list = this.refs.get(ref) ?? [];
    return [...list.map((v, i) => ({ name: String(i), ...this.describe(v) })), { name: "len()", value: String(list.length), type: "int", variablesReference: 0, presentationHint: { kind: "virtual" } }];
  }

  private evaluateRequest(req: { seq: number; command: string }, expr: string, context: string) {
    try {
      if (context === "repl" && /^[A-Za-z_]\w*\s*([+\-*/])?=(?!=)|\.append\(|^print\(/.test(expr.trim())) {
        const printed = execute(expr, this.vars);
        if (printed) this.event("output", { category: "stdout", output: printed });
        return this.respond(req, { result: "", variablesReference: 0 });
      }
      const v = evaluate(expr, this.vars);
      const d = this.describe(v);
      return this.respond(req, { result: d.value, type: d.type, variablesReference: d.variablesReference });
    } catch (e) {
      const err = e as PyError;
      return this.respond(req, {}, err.kind ? `${err.kind}: ${err.message}` : String(err.message));
    }
  }
}

// ───────────── the browser build's DebugHost ─────────────

/** Where the simulated debugger pretends the folder is (paths in frames and breakpoints). */
export const SIMULATED_ROOT = "/workspace";

/**
 * A DebugHost over FakeDebugAdapter: Python only, no processes. Messages are
 * framed (`Content-Length`) in both directions like a real adapter's stdio.
 */
export function createSimulatedDebugHost(readFile: (path: string) => Promise<string>, opts: { delay?: number } = {}): DebugHost {
  let nextId = 0;
  const rel = (p: string) => (p.startsWith(`${SIMULATED_ROOT}/`) ? p.slice(SIMULATED_ROOT.length + 1) : p);
  return {
    note: "Simulated Python debugger (browser build): straight-line code only. The desktop app debugs Python, JavaScript, TypeScript and C/C++ for real.",
    kinds: ["python"],
    async probe(kind) {
      return kind === "python"
        ? { available: true, install: null, detail: "simulated", message: null }
        : { available: false, install: null, detail: null, message: "Only Python can be debugged in the browser build. Use the TMCode desktop app." };
    },
    async prepare(request) {
      if (request.build.length) throw new Error("Building programs is not available in the browser build.");
      await readFile(request.entry);
      return { root: SIMULATED_ROOT, entry: `${SIMULATED_ROOT}/${request.entry}`, cwd: SIMULATED_ROOT, program: "python", args: [] };
    },
    async start(kind, { parent }, onEvent) {
      if (kind !== "python" || parent !== undefined) throw new Error("The simulated debugger only runs Python.");
      const id = ++nextId;
      let open = true;
      const fromAdapter = new DapFrameReader();
      const toAdapter = new DapFrameReader();
      const adapter = new FakeDebugAdapter(
        (p) => readFile(rel(p)),
        (json) => {
          if (!open) return;
          fromAdapter.push(encodeMessage(json));
          for (const message of fromAdapter.drain()) onEvent({ type: "message", message });
        },
        opts.delay,
      );
      return {
        id,
        send(message) {
          if (!open) return;
          toAdapter.push(encodeMessage(message));
          for (const m of toAdapter.drain()) adapter.receive(m);
        },
        stop() {
          if (!open) return;
          open = false;
          setTimeout(() => onEvent({ type: "exit", code: 0 }), 0);
        },
      };
    },
  };
}
