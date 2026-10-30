// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * vendor/nga-webrun is an exact copy of nga_central_mis/packages/webrun/src/index.ts (the MIS Code
 * Playground's runner core), written by that package's sync.mjs with the sha256 of its body.
 * A hand edit here breaks the hash: change the package, then sync again.
 */
describe("vendored nga-webrun", () => {
  const vendored = readFileSync(new URL("../vendor/nga-webrun/index.ts", import.meta.url), "utf8");
  const [first, second, shaLine, ...rest] = vendored.split("\n");
  const body = rest.join("\n");

  it("has the provenance header", () => {
    expect(first).toBe("// VENDORED from nga_central_mis/packages/webrun/src/index.ts -- do not edit.");
    expect(second).toMatch(/^\/\/ Re-sync with: node nga_central_mis\/packages\/webrun\/sync\.mjs/);
  });

  it("matches its provenance hash (no hand edits)", () => {
    expect(shaLine).toBe(`// sha256:${createHash("sha256").update(body).digest("hex")}`);
  });
});
