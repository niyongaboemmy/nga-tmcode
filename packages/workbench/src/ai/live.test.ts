import { describe, expect, it } from "vitest";
import type { TmStreamEvent } from "../platform/types";
import { createAiLive, EVENTS_PATH } from "./live";

/** A fake account.stream and clock: the test pushes events and runs timers by hand. */
function harness() {
  const lines: { path: string; push: (e: TmStreamEvent) => void; cancelled: boolean }[] = [];
  const refreshes: number[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const live = createAiLive({
    stream: async (path, on) => {
      const line = { path, push: on, cancelled: false };
      lines.push(line);
      return { cancel: () => void (line.cancelled = true) };
    },
    refresh: (ms) => refreshes.push(ms),
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t as never);
      if (i >= 0) timers.splice(i, 1);
    },
    random: () => 0.5,
  });
  const tick = () => {
    const t = timers.shift();
    t?.fn();
    return t?.ms;
  };
  const sse = (name: string, data: unknown) => ({ type: "data" as const, data: `event: ${name}\ndata: ${JSON.stringify(data)}\n\n` });
  return { live, lines, refreshes, timers, tick, sse };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("TMCode AI live line (GET /api/tmcode/ai/events)", () => {
  it("opens the events path; hello asks at once, changed asks within the spread", async () => {
    const h = harness();
    h.live.start();
    await settle();
    expect(h.lines.map((l) => l.path)).toEqual([EVENTS_PATH]);
    h.lines[0].push({ type: "status", status: 200 });
    h.lines[0].push(h.sse("hello", { v: 3 }));
    h.lines[0].push(h.sse("changed", { cause: "item", kind: "quiz", id: 9 }));
    expect(h.refreshes).toEqual([0, 750]);
    expect(h.live.open).toBe(true);
  });

  it("reconnects after a drop, backing off 2 s → 4 s, and a hello resets the back-off", async () => {
    const h = harness();
    h.live.start();
    await settle();
    h.lines[0].push({ type: "end" });
    expect(h.tick()).toBe(2000);
    await settle();
    h.lines[1].push({ type: "error", message: "offline" });
    expect(h.tick()).toBe(4000);
    await settle();
    h.lines[2].push(h.sse("hello", { v: 1 }));
    h.lines[2].push({ type: "end" });
    expect(h.tick()).toBe(2000);
  });

  it("an older Task Mentor (404) is not asked again", async () => {
    const h = harness();
    h.live.start();
    await settle();
    h.lines[0].push({ type: "status", status: 404 });
    h.lines[0].push({ type: "end" });
    expect(h.timers).toHaveLength(0);
    expect(h.live.unsupported).toBe(true);
  });

  it("stop (signed out) closes the line, cancels the retry and ignores late events", async () => {
    const h = harness();
    h.live.start();
    await settle();
    const first = h.lines[0];
    h.live.stop();
    expect(first.cancelled).toBe(true);
    first.push(h.sse("changed", { cause: "policy" }));
    first.push({ type: "end" });
    expect(h.refreshes).toEqual([]);
    expect(h.timers).toHaveLength(0);
  });
});
