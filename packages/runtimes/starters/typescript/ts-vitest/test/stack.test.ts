import { describe, expect, it } from "vitest";

import { Stack } from "../src/stack";

describe("Stack", () => {
  it("pops the last item pushed", () => {
    const s = new Stack<number>();
    s.push(1);
    s.push(2);
    expect(s.pop()).toBe(2);
    expect(s.size).toBe(1);
  });

  it("is empty at first", () => {
    expect(new Stack<string>().pop()).toBeUndefined();
  });
});
