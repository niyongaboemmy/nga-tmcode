import { describe, expect, it } from "vitest";
import { adapterKindFor, TEMPLATES, usesPickProcess, withProcessId } from "./launchJson";

describe("Attach to Process", () => {
  it("finds ${command:pickProcess} in any spelling and puts the picked id in", () => {
    const cfg = { type: "node", request: "attach", name: "Attach", processId: "${command:PickProcess}", args: ["--pid=${command:pickProcess}"] };
    expect(usesPickProcess(cfg)).toBe(true);
    expect(usesPickProcess({ type: "node", request: "attach", port: 9229 })).toBe(false);
    expect(withProcessId(cfg, 4242)).toEqual({ ...cfg, processId: 4242, args: ["--pid=4242"] });
  });

  it("offers attach templates for Node.js and Python", () => {
    const attach = TEMPLATES.filter((t) => t.config.request === "attach").map((t) => [t.label, adapterKindFor(t.config.type)]);
    expect(attach).toEqual(
      expect.arrayContaining([
        ["Node.js: Attach", "node"],
        ["Node.js: Attach to Process", "node"],
        ["Python Debugger: Attach", "python"],
        ["Python Debugger: Attach using Process Id", "python"],
      ]),
    );
  });
});
