import { describe, expect, it } from "vitest";
import { decodeMappings, expandable, inspectValue, originalPosition, parseStack, previewOf, type JsValue } from "./jsInspect";

type Obj = Extract<JsValue, { t: "obj" }>;

describe("inspectValue", () => {
  it("keeps primitives typed", () => {
    expect(inspectValue("hi")).toEqual({ t: "str", v: "hi" });
    expect(inspectValue(-0)).toEqual({ t: "num", v: "-0" });
    expect(inspectValue(10n)).toEqual({ t: "bigint", v: "10n" });
    expect(inspectValue(undefined)).toEqual({ t: "undef", v: "undefined" });
    expect(inspectValue(null)).toEqual({ t: "null", v: "null" });
  });

  it("describes functions and classes", () => {
    expect(inspectValue(function add(a: number, b: number) { return a + b; })).toEqual({ t: "fn", v: "ƒ add(a, b)" });
    expect((inspectValue((x: number) => x) as { v: string }).v).toBe("(x) => {…}");
    expect((inspectValue(class Point {}) as { v: string }).v).toBe("class Point");
  });

  it("builds trees for objects, arrays, maps and sets with class names", () => {
    class Person {
      name = "Ada";
      tags = ["math"];
    }
    expect(inspectValue({ p: new Person(), m: new Map([["k", 1]]), s: new Set([true]) })).toMatchObject({
      t: "obj",
      kind: "object",
      cls: "Object",
      entries: [
        ["p", { cls: "Person", entries: [["name", { t: "str", v: "Ada" }], ["tags", { kind: "array", size: 1 }]] }],
        ["m", { kind: "map", size: 1, entries: [['"k"', { t: "num", v: "1" }]] }],
        ["s", { kind: "set", size: 1 }],
      ],
    });
  });

  it("marks cycles and stops at the depth limit with a handle", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect((inspectValue(a) as Obj).entries![1][1]).toEqual({ t: "circ" });
    const kept: object[] = [];
    const deep = inspectValue({ x: { y: { z: 1 } } }, 1, (o) => kept.push(o) - 1);
    expect((deep as Obj).entries![0][1]).toMatchObject({ entries: null, ref: 0 });
    expect(kept[0]).toEqual({ y: { z: 1 } });
  });

  it("caps long objects", () => {
    const v = inspectValue(Array.from({ length: 150 }, (_, i) => i)) as Obj;
    expect(v.entries).toHaveLength(100);
    expect(v.more).toBe(50);
  });

  it("captures errors with their stack", () => {
    expect(inspectValue(new TypeError("bad"))).toMatchObject({ t: "err", name: "TypeError", message: "bad" });
  });

  it("is self-contained, so it can run inside a worker or a preview page", () => {
    const copy = new Function(`return (${String(inspectValue)})`)() as typeof inspectValue;
    expect(copy({ a: [1, "x"] }, 3, null)).toEqual(inspectValue({ a: [1, "x"] }));
  });
});

describe("previewOf", () => {
  it("prints like the devtools console", () => {
    expect(previewOf(inspectValue({ a: 1, b: "x", "c-d": [1, 2] }))).toBe("{a: 1, b: 'x', 'c-d': Array(2)}");
    expect(previewOf(inspectValue([1, 2, 3]))).toBe("(3) [1, 2, 3]");
    expect(previewOf(inspectValue(new Map([["k", { v: 1 }]])))).toBe(`Map(1) {"k" => {…}}`);
    expect(previewOf(inspectValue("top level"))).toBe("top level");
    expect(previewOf(inspectValue(new Date(0)))).toBe("1970-01-01T00:00:00.000Z");
    expect(previewOf(inspectValue(Array.from({ length: 60 }, (_, i) => i)))).toMatch(/…\]$/);
  });

  it("knows what can expand", () => {
    expect(expandable(inspectValue({ a: 1 }))).toBe(true);
    expect(expandable(inspectValue({}))).toBe(false);
    expect(expandable(inspectValue(1))).toBe(false);
  });
});

describe("parseStack", () => {
  it("finds workspace frames in V8 and JavaScriptCore stacks", () => {
    const lines = parseStack("TypeError: x is not a function\n    at area (js/shapes.js:4:10)\n    at js/main.js:12:3\n    at blob:http://localhost/abc:1:2");
    expect(lines[1]).toMatchObject({ path: "js/shapes.js", line: 4, column: 10 });
    expect(lines[2]).toMatchObject({ path: "js/main.js", line: 12, column: 3 });
    expect(lines[3].path).toBeUndefined();
    expect(parseStack("area@js/shapes.js:4:10")[0]).toMatchObject({ path: "js/shapes.js", line: 4 });
    expect(parseStack("at f (lib.js:1:1)", (p) => p !== "lib.js")[0].path).toBeUndefined();
  });
});

describe("source maps", () => {
  it("maps generated positions back", () => {
    // Generated line 1 col 0 → source line 3 col 2; line 2 col 4 → line 5 col 0.
    const map = { sources: ["src/a.ts"], mappings: "AAEE;IAEF" };
    const decoded = decodeMappings(map);
    expect(originalPosition(map, decoded, 1, 1)).toEqual({ source: "src/a.ts", line: 3, column: 3 });
    expect(originalPosition(map, decoded, 2, 7)).toEqual({ source: "src/a.ts", line: 5, column: 1 });
    expect(originalPosition(map, decoded, 9, 1)).toBeNull();
  });
});
