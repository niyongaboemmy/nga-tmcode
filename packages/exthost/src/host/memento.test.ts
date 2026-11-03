import { describe, expect, it } from "vitest";
import { Memento } from "./extHost";

describe("extension state (globalState / workspaceState)", () => {
  it("get() returns the stored value itself, as VS Code does; update() stores a copy", () => {
    const m = new Memento({}, () => {});
    const list = [1];
    void m.update("dates", list);
    list.push(99);
    expect(m.get("dates")).toEqual([1]);
    const got = m.get<number[]>("dates")!;
    got.push(2);
    expect(m.get("dates")).toBe(got);
    expect(m.get("dates")).toEqual([1, 2]);
  });

  it("Gemini Code Assist's survey asks once, not on every telemetry event", async () => {
    // Its SurveyActivationManager, cut down: asking sends a metric, and every metric records activity.
    const DAY = 86_400_000;
    const m = new Memento({ dates: [0, 2 * DAY] }, () => {});
    let asks = 0;
    const record = async (t: number): Promise<void> => {
      const dates = m.get<number[]>("dates", [])!;
      if (dates.length && t - dates[dates.length - 1] <= DAY) return;
      dates.push(t);
      if (dates.length < 3) await m.update("dates", dates);
      else if (++asks < 50) await record(t); // ask(): sendSurveyStart → eventEmitter → recordActivity
    };
    await record(10 * DAY);
    expect(asks).toBe(1);
  });
});
