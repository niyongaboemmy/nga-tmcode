import { describe, expect, it } from "vitest";
import evals from "./learningLeaks.json";
import { filterLearningText, identifiersOf, looksLikeCode, referenceLines } from "./learningFilter";

// The same eval set as Task Mentor's learning.test.ts: the two filters must agree.
const opts = { identifiers: identifiersOf(evals.student_file), reference: referenceLines([evals.reference.join("\n")]) };
const leaked = (text: string) => text.split("\n").filter((l) => l.trim() && !l.includes("TMCode removed") && (looksLikeCode(l, opts.identifiers) || /```|~~~/.test(l)));

describe("the client's Learning filter (signed-out and local paths)", () => {
  it.each(evals.leak)("removes the code in $id", ({ text }) => {
    const r = filterLearningText(text, opts);
    expect(r.removed).toBeGreaterThan(0);
    expect(leaked(r.text)).toEqual([]);
  });
  it.each(evals.keep)("keeps honest tutoring: $id", ({ text }) => {
    expect(filterLearningText(text, opts)).toEqual({ text, removed: 0 });
  });
});
