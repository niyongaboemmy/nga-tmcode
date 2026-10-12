import { describe, expect, it } from "vitest";
import { keptActions, pruneHistory, type HistoryEntry } from "./notificationCenter";

const day = 86_400_000;
const entry = (id: number, time: number): HistoryEntry => ({ id, severity: "info", message: `m${id}`, time });

describe("notification history (N8)", () => {
  it("keeps 30 days and at most 200 entries", () => {
    const now = 100 * day;
    const list = [entry(1, now), entry(2, now - 29 * day), entry(3, now - 31 * day)];
    expect(pruneHistory(list, now).map((h) => h.id)).toEqual([1, 2]);
    const many = Array.from({ length: 250 }, (_, i) => entry(i, now));
    expect(pruneHistory(many, now)).toHaveLength(200);
  });
  it("has no kept buttons for entries it never saw", () => {
    expect(keptActions(123456)).toEqual([]);
  });
});
