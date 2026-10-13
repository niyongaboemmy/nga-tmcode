import assert from "node:assert/strict";
import { test } from "node:test";

import { average, isPrime } from "../src/math.js";

test("average of marks", () => {
  assert.equal(average([70, 80]), 75);
  assert.equal(average([]), 0);
});

test("primes", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9, 11].filter(isPrime), [2, 3, 5, 11]);
});
