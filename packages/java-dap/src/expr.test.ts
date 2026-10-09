// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DapReader, encodeMessage } from "./dap";
import { EvalError, arith, compare, formatDouble, formatPrim, int, parse, quoteString, type Val } from "./expr";
import { hitConditionMet } from "./session";

const prim = (t: "I" | "J" | "D" | "F" | "C" | "Z", v: number | bigint | boolean) => ({ k: "prim", t, v }) as Extract<Val, { k: "prim" }>;

describe("expression parser", () => {
  it("respects precedence and builds postfix chains", () => {
    expect(parse("a + b * c")).toEqual({ t: "binary", op: "+", l: { t: "name", name: "a" }, r: { t: "binary", op: "*", l: { t: "name", name: "b" }, r: { t: "name", name: "c" } } });
    expect(parse("i == 3 && !done || x < -1")).toMatchObject({ t: "binary", op: "||", l: { op: "&&" }, r: { op: "<", r: { t: "unary", op: "-" } } });
    expect(parse("p.items[i].name.length()")).toMatchObject({ t: "call", name: "length", obj: { t: "field", name: "name", obj: { t: "index" } } });
    expect(parse("a > 0 ? 'y' : \"n\\n\"")).toMatchObject({ t: "cond", a: { v: { t: "C", v: 121 } }, b: { v: { k: "str", v: "n\n" } } });
    expect(parse("10L")).toEqual({ t: "lit", v: { k: "prim", t: "J", v: 10n } });
    expect(parse("1.5f")).toEqual({ t: "lit", v: { k: "prim", t: "F", v: 1.5 } });
    expect(parse("0x1F")).toEqual({ t: "lit", v: { k: "prim", t: "I", v: 31 } });
  });

  it("rejects malformed input", () => {
    expect(() => parse("")).toThrow(EvalError);
    expect(() => parse("a +")).toThrow(/unexpected end/);
    expect(() => parse("(a")).toThrow(/expected '\)'/);
    expect(() => parse("a b")).toThrow(/unexpected 'b'/);
    expect(() => parse("x = 1")).toThrow(EvalError);
  });
});

describe("Java arithmetic", () => {
  it("follows int/long overflow, integer division and promotion", () => {
    expect(arith("+", prim("I", 2147483647), int(1))).toEqual(int(-2147483648));
    expect(arith("/", int(7), int(2))).toEqual(int(3));
    expect(arith("/", int(-7), int(2))).toEqual(int(-3));
    expect(arith("%", int(-7), int(2))).toEqual(int(-1));
    expect(arith("*", prim("J", 3000000000n), int(3))).toEqual(prim("J", 9000000000n));
    expect(arith("/", int(7), prim("D", 2))).toEqual(prim("D", 3.5));
    expect(arith("+", prim("C", 97), int(1))).toEqual(int(98));
    expect(() => arith("/", int(1), int(0))).toThrow("/ by zero");
    expect(compare("<", int(3), prim("D", 3.5))).toEqual(prim("Z", true));
    expect(compare("==", prim("Z", true), prim("Z", true))).toEqual(prim("Z", true));
    expect(() => compare("<", prim("Z", true), int(1))).toThrow(EvalError);
  });

  it("formats values like Java", () => {
    expect(formatDouble(1)).toBe("1.0");
    expect(formatDouble(0.1)).toBe("0.1");
    expect(formatDouble(1e10)).toBe("1.0E10");
    expect(formatDouble(1.5e-5)).toBe("1.5E-5");
    expect(formatDouble(-0)).toBe("-0.0");
    expect(formatDouble(Math.fround(0.1), true)).toBe("0.1");
    expect(formatDouble(NaN)).toBe("NaN");
    expect(formatPrim(prim("C", 10))).toBe("'\\n'");
    expect(quoteString('say "hi"\n')).toBe('"say \\"hi\\"\\n"');
  });

  it("evaluates VS Code hit conditions", () => {
    expect(hitConditionMet("3", 3)).toBe(true);
    expect(hitConditionMet("3", 4)).toBe(false);
    expect(hitConditionMet(">= 3", 4)).toBe(true);
    expect(hitConditionMet("% 2", 4)).toBe(true);
    expect(hitConditionMet("% 2", 3)).toBe(false);
  });
});

describe("DAP framing", () => {
  it("parses split and concatenated messages", () => {
    const got: unknown[] = [];
    const r = new DapReader((m) => got.push(m));
    const a = encodeMessage({ seq: 1, type: "event", event: "é" });
    const b = encodeMessage({ seq: 2, type: "event", event: "x" });
    const all = Buffer.concat([a, b]);
    r.feed(all.subarray(0, 5));
    r.feed(all.subarray(5, a.length + 3));
    r.feed(all.subarray(a.length + 3));
    expect(got).toEqual([
      { seq: 1, type: "event", event: "é" },
      { seq: 2, type: "event", event: "x" },
    ]);
  });
});
