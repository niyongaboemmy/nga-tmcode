import { describe, expect, it } from "vitest";
import { journeyReport, markJourney, startJourney, stopJourney } from "./journey";

describe("journey counter", () => {
  it("does nothing until a journey starts", () => {
    stopJourney();
    markJourney("home-shown");
    expect(journeyReport().marks).toEqual([]);
  });
  it("counts clicks between milestones, each milestone once", () => {
    startJourney();
    window.dispatchEvent(new MouseEvent("click"));
    window.dispatchEvent(new MouseEvent("click"));
    markJourney("first-start");
    window.dispatchEvent(new MouseEvent("click"));
    markJourney("first-start");
    markJourney("submitted");
    const r = journeyReport();
    expect(r.clicks).toBe(3);
    expect(r.marks.map((m) => [m.name, m.clicks])).toEqual([
      ["first-start", 2],
      ["submitted", 3],
    ]);
    // A restart begins again from zero.
    startJourney();
    expect(journeyReport()).toMatchObject({ clicks: 0, marks: [] });
    stopJourney();
  });
});
