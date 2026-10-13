import { describe, expect, it } from "vitest";
import { WORKER_SOURCE } from "./jsConsole";

describe("the JavaScript Console worker", () => {
  // It's a string (started from a blob), so a slip in its escaping only shows when a student runs code.
  it("is valid JavaScript", () => {
    expect(() => new Function(WORKER_SOURCE)).not.toThrow();
  });

  it("draws console.table like Node", () => {
    const logs: unknown[][] = [];
    const scope = { postMessage: (m: { type: string; args?: { v: string }[] }) => m.type === "console" && logs.push(m.args!.map((a) => a.v)) };
    new Function("self", "postMessage", `${WORKER_SOURCE}\nself.console.table([{ a: 1, b: 'x' }, { a: 22 }]);`)(
      // A stand-in worker scope (no fetch or Response, so nothing global is patched).
      Object.assign(Object.create(globalThis), { addEventListener: () => undefined, fetch: undefined, Response: undefined }),
      scope.postMessage,
    );
    expect(logs[0][0]).toBe(
      ["┌─────────┬────┬─────┐", "│ (index) │ a  │  b  │", "├─────────┼────┼─────┤", "│    0    │ 1  │ 'x' │", "│    1    │ 22 │     │", "└─────────┴────┴─────┘"].join("\n"),
    );
  });
});
