import { describe, expect, it } from "vitest";
import { equivalences, evaluate, parseExpr, parseFile, show, truthTable } from "./logic";

describe("logic expressions", () => {
  it("parses the common notations with the usual precedence", () => {
    expect(show(parseExpr("A and B or not C"))).toBe("A ∧ B ∨ ¬C");
    expect(show(parseExpr("!(A && B) || C"))).toBe("¬(A ∧ B) ∨ C");
    expect(show(parseExpr("A ∧ (B ∨ C)"))).toBe("A ∧ (B ∨ C)");
    expect(show(parseExpr("p -> q -> r"))).toBe("p → q → r");
    expect(evaluate(parseExpr("p -> q -> r"), { p: true, q: false, r: false })).toBe(true); // p → (q → r)
    expect(show(parseExpr("A xor B <-> C"))).toBe("A ⊕ B ↔ C");
    expect(evaluate(parseExpr("1 & T & true"), {})).toBe(true);
  });

  it("explains syntax errors with a column", () => {
    expect(() => parseExpr("A and")).toThrow(/ends too early/);
    expect(() => parseExpr("(A or B")).toThrow(/Missing \)/);
    expect(() => parseExpr("A $ B")).toThrow(/Unexpected "\$"/);
  });

  it("builds truth tables with steps, minterms and canonical forms", () => {
    const t = truthTable(parseExpr("A -> B"));
    expect(t.vars).toEqual(["A", "B"]);
    expect(t.values.map((r) => r[r.length - 1])).toEqual([true, true, false, true]);
    expect(t.kind).toBe("contingency");
    expect(t.minterms).toEqual([0, 1, 3]);
    expect(t.maxterms).toEqual([2]);
    expect(t.pos).toBe("(¬A ∨ B)");
    const steps = truthTable(parseExpr("not (A and B) or C"));
    expect(steps.columns.map((c) => c.label)).toEqual(["A ∧ B", "¬(A ∧ B)", "¬(A ∧ B) ∨ C"]);
  });

  it("recognises tautologies and contradictions", () => {
    expect(truthTable(parseExpr("p or not p")).kind).toBe("tautology");
    expect(truthTable(parseExpr("p and not p")).kind).toBe("contradiction");
  });

  it("reads files with names, comments and errors, and finds equivalent lines (De Morgan)", () => {
    const lines = parseFile("# De Morgan\nF = not (A and B)\nG = !A | !B\nH := A nand B\nbad = A or\n");
    expect(lines.map((l) => [l.line, l.name])).toEqual([
      [2, "F"],
      [3, "G"],
      [4, "H"],
      [5, "bad"],
    ]);
    expect(lines[3].error?.message).toMatch(/ends too early/);
    expect(equivalences(lines)).toEqual([[2, 3, 4]]);
  });
});
