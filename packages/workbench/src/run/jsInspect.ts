/**
 * Structured console values, like the browser devtools console: a program's
 * `console.log({ a: [1, 2] })` becomes a tree the JavaScript Console (and the
 * live preview's console) render with expandable objects and clickable stacks.
 * Pure; unit-tested in jsInspect.test.ts.
 */

export type JsValue =
  | { t: "str"; v: string }
  | { t: "num" | "bool" | "undef" | "null" | "bigint" | "sym"; v: string }
  | { t: "fn"; v: string }
  | { t: "err"; name: string; message: string; stack: string }
  | {
      t: "obj";
      kind: "object" | "array" | "map" | "set" | "date" | "regexp" | "dom" | "promise";
      /** Constructor name ("Object", "Array", "Map", "Person", "div"). */
      cls: string;
      size?: number;
      /** Child entries; null when not loaded yet (expand through `ref`) or not expandable. */
      entries: [string, JsValue][] | null;
      /** Entries left out of a long object. */
      more?: number;
      /** Handle for loading the children later (the worker keeps the object). */
      ref?: number;
      /** Text for dates, regular expressions and DOM nodes. */
      v?: string;
    }
  | { t: "circ" };

/**
 * Serialises a value to a JsValue tree. Self-contained on purpose: its source
 * is also injected into the console worker and the preview page's console
 * shim (`String(inspectValue)`), so it must not use anything from outside.
 *
 * @param depth  levels expanded eagerly; deeper objects get a `ref` when `keep` is given
 * @param keep   stores an object for later expansion and returns its handle
 */
export function inspectValue(value: unknown, depth = 3, keep: ((o: object) => number) | null = null): JsValue {
  const MAX = 100;
  const seen: object[] = [];
  function ctorName(o: object): string {
    try {
      const p = Object.getPrototypeOf(o);
      if (p === null) return "Object";
      const c = p.constructor;
      return (c && typeof c.name === "string" && c.name) || "Object";
    } catch (_e) {
      return "Object";
    }
  }
  function fnText(f: Function): string {
    let src = "";
    try {
      src = Function.prototype.toString.call(f);
    } catch (_e) {
      src = "";
    }
    const params = /^[^(]*\(([^)]*)\)/.exec(src);
    const arrow = /^(async\s*)?(\([^)]*\)|[\w$]+)\s*=>/.exec(src);
    const name = f.name || "anonymous";
    if (/^class\b/.test(src)) return "class " + name;
    if (arrow) return (arrow[1] ? "async " : "") + (arrow[2].charAt(0) === "(" ? arrow[2] : "(" + arrow[2] + ")") + " => {…}";
    return (/^async\b/.test(src) ? "async " : "") + "ƒ " + name + "(" + (params ? params[1].replace(/\s+/g, " ").trim() : "") + ")";
  }
  function preview(n: JsValue): string {
    if (n.t === "str") return JSON.stringify(n.v);
    if (n.t === "obj") return n.v ?? n.cls;
    if (n.t === "err") return n.name;
    if (n.t === "circ") return "[Circular]";
    return n.v;
  }
  function walk(v: unknown, d: number): JsValue {
    if (v === null) return { t: "null", v: "null" };
    switch (typeof v) {
      case "string":
        return { t: "str", v: v };
      case "number":
        return { t: "num", v: Object.is(v, -0) ? "-0" : String(v) };
      case "boolean":
        return { t: "bool", v: String(v) };
      case "undefined":
        return { t: "undef", v: "undefined" };
      case "bigint":
        return { t: "bigint", v: String(v) + "n" };
      case "symbol":
        return { t: "sym", v: String(v) };
      case "function":
        return { t: "fn", v: fnText(v as Function) };
    }
    const o = v as Record<string, unknown> & object;
    if (seen.indexOf(o) >= 0) return { t: "circ" };
    if (o instanceof Error || (typeof (o as { stack?: unknown }).stack === "string" && typeof (o as { message?: unknown }).message === "string" && "name" in o)) {
      const e = o as unknown as Error;
      return { t: "err", name: String(e.name || "Error"), message: String(e.message || ""), stack: String(e.stack || "") };
    }
    if (o instanceof Date) return { t: "obj", kind: "date", cls: "Date", entries: null, v: isNaN(o.getTime()) ? "Invalid Date" : o.toISOString() };
    if (o instanceof RegExp) return { t: "obj", kind: "regexp", cls: "RegExp", entries: null, v: String(o) };
    if (typeof (o as { nodeType?: unknown }).nodeType === "number" && typeof (o as { nodeName?: unknown }).nodeName === "string") {
      const n = o as unknown as { nodeName: string; outerHTML?: string; textContent?: string };
      const text = n.outerHTML || n.textContent || n.nodeName;
      return { t: "obj", kind: "dom", cls: n.nodeName.toLowerCase(), entries: null, v: text.length > 160 ? text.slice(0, 160) + "…" : text };
    }
    if (typeof Promise !== "undefined" && o instanceof Promise) return { t: "obj", kind: "promise", cls: "Promise", entries: null, v: "Promise {<pending>}" };
    const isArray = Array.isArray(o);
    const isMap = typeof Map !== "undefined" && o instanceof Map;
    const isSet = typeof Set !== "undefined" && o instanceof Set;
    const kind = isArray ? "array" : isMap ? "map" : isSet ? "set" : "object";
    const cls = ctorName(o);
    const size = isArray ? (o as unknown as unknown[]).length : isMap || isSet ? (o as unknown as Map<unknown, unknown>).size : undefined;
    if (d <= 0) {
      const out: JsValue = { t: "obj", kind, cls, size, entries: null };
      if (keep) out.ref = keep(o);
      return out;
    }
    seen.push(o);
    const entries: [string, JsValue][] = [];
    let total = 0;
    const add = (k: string, val: () => unknown) => {
      total++;
      if (entries.length >= MAX) return;
      let x: unknown;
      try {
        x = val();
      } catch (e) {
        x = e;
      }
      entries.push([k, walk(x, d - 1)]);
    };
    if (isMap) {
      (o as unknown as Map<unknown, unknown>).forEach((val, k) => add(preview(walk(k, 0)), () => val));
    } else if (isSet) {
      let i = 0;
      (o as unknown as Set<unknown>).forEach((val) => add(String(i++), () => val));
    } else {
      let keys: string[] = [];
      try {
        keys = Object.keys(o);
      } catch (_e) {
        keys = [];
      }
      for (const k of keys) add(k, () => o[k]);
    }
    seen.pop();
    const out: JsValue = { t: "obj", kind, cls, size, entries };
    if (total > entries.length) out.more = total - entries.length;
    return out;
  }
  return walk(value, depth);
}

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;

/** One-line text, as the devtools console shows a value before it is expanded. */
export function previewOf(n: JsValue, nested = false, budget = 100): string {
  switch (n.t) {
    case "str":
      return nested ? quote(n.v) : n.v;
    case "fn":
      return n.v;
    case "err":
      return nested ? `${n.name}: ${n.message}` : n.stack || `${n.name}: ${n.message}`;
    case "circ":
      return "[Circular]";
    case "obj": {
      if (n.kind === "date" || n.kind === "regexp" || n.kind === "dom" || n.kind === "promise") return n.v ?? n.cls;
      const head = n.kind === "array" ? `(${n.size ?? 0})` : n.kind === "map" || n.kind === "set" ? `${n.cls}(${n.size ?? 0})` : n.cls === "Object" ? "" : n.cls;
      if (!n.entries) return n.kind === "array" ? `Array(${n.size ?? 0})` : head || "{…}";
      if (nested) return n.kind === "array" ? `Array(${n.size ?? 0})` : n.kind === "map" || n.kind === "set" ? head : head ? `${head} {…}` : "{…}";
      const parts: string[] = [];
      let used = 0;
      for (const [k, v] of n.entries) {
        const p =
          n.kind === "array" || n.kind === "set"
            ? previewOf(v, true)
            : n.kind === "map"
              ? `${k} => ${previewOf(v, true)}`
              : `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k)}: ${previewOf(v, true)}`;
        used += p.length + 2;
        if (used > budget && parts.length) {
          parts.push("…");
          break;
        }
        parts.push(p);
      }
      if (n.more && parts[parts.length - 1] !== "…") parts.push("…");
      const body = n.kind === "array" ? `[${parts.join(", ")}]` : `{${parts.join(", ")}}`;
      return head ? `${head} ${body}` : body;
    }
    default:
      return n.v;
  }
}

/** True when a value can be expanded (has, or can load, children). */
export function expandable(n: JsValue): boolean {
  return (n.t === "obj" && (n.entries ? n.entries.length > 0 : n.ref !== undefined)) || (n.t === "err" && !!n.stack);
}

// ───────────── stacks ─────────────

export interface StackLine {
  text: string;
  /** Workspace path of the frame, when it points into one of the student's files. */
  path?: string;
  line?: number;
  column?: number;
}

const FRAME = /((?:[\w.-]+\/)*[\w.-]+\.(?:[mc]?[jt]sx?|html?)):(\d+)(?::(\d+))?/;

/**
 * Splits an error stack (V8 "at f (a.js:3:9)" or JavaScriptCore "f@a.js:3:9")
 * into lines with file positions. `known` tells which paths are workspace files.
 */
export function parseStack(stack: string, known: (path: string) => boolean = () => true): StackLine[] {
  return stack
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((text) => {
      const m = FRAME.exec(text);
      if (!m || /^(blob|https?|file):/.test(m[1]) || !known(m[1])) return { text };
      return { text, path: m[1], line: +m[2], column: m[3] ? +m[3] : 1 };
    });
}

// ───────────── source maps (bundled TypeScript / modules) ─────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVlq(s: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of s) {
    const digit = B64.indexOf(ch);
    if (digit < 0) continue;
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

export interface SourceMapLike {
  sources: string[];
  mappings: string;
}

/** Decoded mappings: per generated line, [generatedColumn, sourceIndex, line, column] (all 0-based). */
export function decodeMappings(map: SourceMapLike): number[][][] {
  const lines: number[][][] = [];
  let src = 0;
  let line = 0;
  let col = 0;
  for (const l of map.mappings.split(";")) {
    let gen = 0;
    const segs: number[][] = [];
    for (const seg of l.split(",")) {
      if (!seg) continue;
      const v = decodeVlq(seg);
      gen += v[0];
      if (v.length >= 4) {
        src += v[1];
        line += v[2];
        col += v[3];
        segs.push([gen, src, line, col]);
      }
    }
    lines.push(segs);
  }
  return lines;
}

/** Maps a generated position (1-based line and column) back to the original file. */
export function originalPosition(map: SourceMapLike, decoded: number[][][], line: number, column: number): { source: string; line: number; column: number } | null {
  const segs = decoded[line - 1];
  if (!segs?.length) return null;
  let best = segs[0];
  for (const s of segs) if (s[0] <= column - 1) best = s;
  return { source: map.sources[best[1]], line: best[2] + 1, column: best[3] + 1 };
}
