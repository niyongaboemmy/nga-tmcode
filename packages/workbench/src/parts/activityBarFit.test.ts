import { describe, expect, it } from "vitest";
import { splitBar, type BarItem } from "./activityBarFit";

const view = (id: string): BarItem => ({ key: id, view: { id: id as never, icon: id, label: id, command: `workbench.view.${id}` } });
const ids = (items: BarItem[]) => items.map((i) => i.key);

describe("the activity bar shows every view while they fit", () => {
  const items = ["assignments", "explorer", "search", "debug", "testing", "extensions"].map(view);

  it("shows all of a few views, with no More", () => {
    const r = splitBar(items, 12, null);
    expect(ids(r.shown)).toEqual(["assignments", "explorer", "search", "debug", "testing", "extensions"]);
    expect(r.overflow).toEqual([]);
  });

  it("when the window is short, keeps room for More and puts the rest there", () => {
    const r = splitBar(items, 4, null);
    expect(ids(r.shown)).toEqual(["assignments", "explorer", "search"]);
    expect(ids(r.overflow)).toEqual(["debug", "testing", "extensions"]);
  });

  it("never hides the open view", () => {
    const r = splitBar(items, 4, "extensions");
    expect(ids(r.shown)).toEqual(["assignments", "explorer", "extensions"]);
    expect(ids(r.overflow)).toEqual(["search", "debug", "testing"]);
  });

  it("lists each view once, even if it was given twice", () => {
    const r = splitBar([...items, view("extensions")], 3, null);
    expect(ids([...r.shown, ...r.overflow]).filter((k) => k === "extensions")).toHaveLength(1);
  });
});
