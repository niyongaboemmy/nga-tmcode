import { describe, expect, it } from "vitest";
import { splitName } from "./SqlDiagram";
import { exportScale, pdfWithJpeg } from "./sqlDiagramExport";
import { layoutDiagram, placeInOrder, type LayoutNode } from "./sqlDiagramLayout";

const overlaps = (nodes: LayoutNode[], pos: Record<string, { x: number; y: number }>) => {
  const hits: string[] = [];
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = { ...pos[nodes[i].id], ...nodes[i] };
      const b = { ...pos[nodes[j].id], ...nodes[j] };
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hits.push(`${a.id}/${b.id}`);
    }
  return hits;
};

describe("diagram layout", () => {
  it("puts referenced tables left of the tables referencing them, without overlaps", () => {
    const nodes = ["users", "posts", "comments", "tags", "post_tags", "settings"].map((id, i) => ({ id, w: 200 + i * 10, h: 80 + i * 20 }));
    const edges = [
      { from: "posts", to: "users" },
      { from: "comments", to: "posts" },
      { from: "comments", to: "users" },
      { from: "post_tags", to: "posts" },
      { from: "post_tags", to: "tags" },
    ];
    const pos = layoutDiagram(nodes, edges);
    expect(Object.keys(pos).sort()).toEqual(nodes.map((n) => n.id).sort());
    expect(overlaps(nodes, pos)).toEqual([]);
    expect(pos.users.x).toBeLessThan(pos.posts.x);
    expect(pos.posts.x).toBeLessThan(pos.comments.x);
    expect(pos.tags.x).toBeLessThan(pos.post_tags.x);
    // The same input lays out the same way.
    expect(layoutDiagram(nodes, edges)).toEqual(pos);
  });

  it("survives cycles and self-references, and wraps a table referenced by many into several columns", () => {
    const nodes: LayoutNode[] = [{ id: "hub", w: 220, h: 200 }, ...Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, w: 240, h: 120 + (i % 5) * 40 }))];
    const edges = [...nodes.slice(1).map((n) => ({ from: n.id, to: "hub" })), { from: "hub", to: "t0" }, { from: "t3", to: "t3" }];
    const pos = layoutDiagram(nodes, edges);
    expect(overlaps(nodes, pos)).toEqual([]);
    const columns = new Set(nodes.slice(1).map((n) => pos[n.id].x));
    expect(columns.size).toBeGreaterThan(3);
    const ys = nodes.map((n) => pos[n.id].y + n.h);
    const xs = nodes.map((n) => pos[n.id].x + n.w);
    // Roughly as wide as tall rather than one endless column.
    expect(Math.max(...ys) / Math.max(...xs)).toBeLessThan(2.5);
  });

  it("keeps items in order, apart, and as near as possible to where they want to be", () => {
    expect(placeInOrder([10, 10, 10], (h) => h, () => 0)).toEqual([-46, 0, 46]);
    expect(placeInOrder([10, 10], (h) => h, (h) => h * 50)).toEqual([477, 523]);
    const far = placeInOrder([20, 20], (h) => h, () => 100);
    expect(far[1] - far[0]).toBe(56);
  });
});

describe("export", () => {
  it("scales up for sharpness within the canvas limits", () => {
    expect(exportScale(1000, 800)).toBe(2);
    expect(exportScale(8000, 6000)).toBeCloseTo(Math.sqrt(16_000_000 / 48_000_000));
    expect(exportScale(40_000, 100)).toBe(0.4);
  });

  it("writes a one-page PDF around a JPEG with a correct cross-reference table", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const pdf = pdfWithJpeg(jpeg, 300, 200, 225, 150, "schema (v2)");
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 225 150]");
    expect(text).toContain("/Width 300 /Height 200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length 9");
    expect(text).toContain("/Title (schema \\(v2\\))");
    // Every xref entry points at its "n 0 obj".
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const offsets = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(6);
    offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // The image bytes are embedded untouched.
    const at = pdf.findIndex((_, i) => pdf[i] === 0xff && pdf[i + 1] === 0xd8 && pdf[i + 2] === 0xff);
    expect([...pdf.slice(at, at + jpeg.length)]).toEqual([...jpeg]);
  });

  it("caps a huge page at PDF's 14 400 units", () => {
    const text = new TextDecoder("latin1").decode(pdfWithJpeg(new Uint8Array([0xff, 0xd8]), 10, 10, 28_800, 7_200));
    expect(text).toContain("/MediaBox [0 0 14400 3600]");
  });
});

describe("zoomed-out names", () => {
  it("splits long names in two at a word boundary", () => {
    expect(splitName("User")).toEqual(["User"]);
    expect(splitName("SchoolSystemAssignment")).toEqual(["SchoolSystem", "Assignment"]);
    expect(splitName("LO_LearningOutcomeActivity")).toEqual(["LO_Learning", "OutcomeActivity"]);
    expect(splitName("student_subject_enrollment")).toEqual(["student_subject_", "enrollment"]);
    expect(splitName("averyverylongname")).toEqual(["averyverylongname"]);
  });
});
