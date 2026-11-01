import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "./log";
import { aiUseStatement, summariseAiUse } from "./aiStatement";

let id = 0;
const ev = (e: Partial<ActivityEvent>): ActivityEvent => ({ id: ++id, t: id, kind: "ai", action: "chat", text: "", actor: { type: "you" }, ...e });

describe("the AI-use statement (I4)", () => {
  it("none recorded", () => {
    expect(aiUseStatement(summariseAiUse([ev({ kind: "file", action: "save" })]))).toBe("AI use: none recorded in TMCode for this work.");
  });

  it("counts each kind of help and names the layers, as facts", () => {
    const u = summariseAiUse([
      ev({ action: "layer", data: { from: "industrial", to: "learning" } }),
      ev({ action: "chat", data: { layer: "learning" } }),
      ev({ action: "chat", data: { layer: "learning" } }),
      ev({ action: "filtered", data: { removed: 3 } }),
      ev({ action: "copy-blocked" }),
      ev({ action: "agent", data: { files: "a.js, b.js" } }),
      ev({ action: "suggestion" }),
      ev({ action: "explained" }),
      ev({ kind: "terminal", action: "terminal", ai: { by: "terminal: Claude Code", how: "ran" } }),
    ]);
    expect(u).toMatchObject({ questions: 2, suggestions: 1, agentChanges: 1, filesChangedByAi: 2, filtered: 3, copyBlocked: 1, explained: 1, aiTools: ["Claude Code"], layers: ["learning"] });
    expect(aiUseStatement(u)).toBe(
      "AI use (from the Activity log): 2 questions to TMCode AI; 1 suggestion accepted while typing; 1 agent request that changed 2 files; other AI tools: Claude Code. Also: the Learning filter removed 3 lines of code; 1 copy of code from the AI panel was blocked; 1 AI change explained by the student. Layers: Learning.",
    );
  });
});
