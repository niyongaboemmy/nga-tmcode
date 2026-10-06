import { describe, expect, it } from "vitest";
import { activationEventsOf, matchesActivationEvent, unsupportedEvents, workspaceContainsPatterns } from "./activation";

describe("activation events", () => {
  it("adds the implicit events of contributed commands and languages", () => {
    const events = activationEventsOf({
      activationEvents: ["onStartupFinished", "workspaceContains:**/.prettierrc"],
      contributes: { commands: [{ command: "x.format" }], languages: [{ id: "owl" }] },
    });
    expect(events).toEqual(["onStartupFinished", "workspaceContains:**/.prettierrc", "onCommand:x.format", "onLanguage:owl"]);
  });

  it("matches fired events", () => {
    expect(matchesActivationEvent(["onLanguage:python"], "onLanguage:python")).toBe(true);
    expect(matchesActivationEvent(["onLanguage:python"], "onLanguage:javascript")).toBe(false);
    expect(matchesActivationEvent(["onLanguage"], "onLanguage:javascript")).toBe(true);
    expect(matchesActivationEvent(["*"], "*")).toBe(true);
    expect(matchesActivationEvent(["*"], "onStartupFinished")).toBe(false);
    expect(matchesActivationEvent(["onCommand:a.b"], "onCommand:a.b")).toBe(true);
  });

  it("lists workspaceContains globs and the events TMCode never fires", () => {
    const ev = ["workspaceContains:package.json", "onView:x", "onDebug", "onUri", "*", "onCommand:y"];
    expect(workspaceContainsPatterns(ev)).toEqual(["package.json"]);
    expect(unsupportedEvents(ev)).toEqual(["onView:x", "onDebug", "onUri"]);
  });
});
