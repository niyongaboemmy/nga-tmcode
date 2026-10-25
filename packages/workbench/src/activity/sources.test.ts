import { describe, expect, it } from "vitest";
import { AWAY_MIN_MS, awayText, createAwayTracker } from "./sources";

describe("time away from TMCode", () => {
  it("records a stretch in another app when the window comes back, if it lasted long enough", () => {
    let t = 1_000_000;
    const seen: { ms: number; from: number; at: number }[] = [];
    const focus = createAwayTracker((a) => seen.push(a), () => t);
    focus(false);
    t += 5_000;
    focus(true); // a glance away: not recorded
    expect(seen).toEqual([]);
    focus(false);
    t += 20_000;
    focus(false); // a second blur keeps the first time
    t += AWAY_MIN_MS;
    focus(true);
    expect(seen).toEqual([{ ms: 20_000 + AWAY_MIN_MS, from: 1_005_000, at: t }]);
    focus(true); // focus without a blur: nothing
    expect(seen).toHaveLength(1);
  });

  it("says how long in words", () => {
    expect(awayText(45_000)).toBe("45 s");
    expect(awayText(180_000)).toBe("3 min");
    expect(awayText(200_000)).toBe("3 min 20 s");
    expect(awayText(3 * 3_600_000 + 5 * 60_000)).toBe("3 h 5 min");
  });
});
