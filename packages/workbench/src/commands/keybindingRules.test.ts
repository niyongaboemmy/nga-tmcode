import { describe, expect, it } from "vitest";
import { compileRules, parseKeybindingsJson, resolveRules, rulesStartWith, toChord } from "./keybindingRules";

describe("keybindings.json", () => {
  it("reads VS Code's rules and reports bad ones", () => {
    const p = parseKeybindingsJson(`// mine
    [
      { "key": "ctrl+alt+t", "command": "workbench.action.terminal.new" },
      { "key": "cmd+k", "command": "-workbench.action.terminal.clear", "when": "terminalFocus" },
      { "command": "no.key" },
    ]`);
    expect(p.syntaxError).toBe(false);
    expect(p.rules.map((r) => r.command)).toEqual(["workbench.action.terminal.new", "-workbench.action.terminal.clear"]);
    expect(p.issues).toEqual([{ message: 'Rule 3 needs a "key".', index: 2 }]);
    expect(parseKeybindingsJson("[ {").syntaxError).toBe(true);
    expect(parseKeybindingsJson('{"key":"x"}').issues[0].message).toMatch(/must be a list/);
  });

  it("turns VS Code keys into this OS's chords", () => {
    expect(toChord("cmd+shift+p", "mac")).toBe("mod+shift+p");
    expect(toChord("ctrl+shift+p", "mac")).toBe("ctrl+shift+p");
    expect(toChord("ctrl+shift+p", "windows")).toBe("mod+shift+p");
    expect(toChord("cmd+k cmd+s", "mac")).toBe("mod+k mod+s");
    expect(toChord("cmd+s", "linux")).toBeNull();
    expect(toChord("alt+UpArrow", "linux")).toBe("alt+up");
    expect(toChord("shift+alt+f", "windows")).toBe("alt+shift+f");
  });

  it("the last matching rule wins; '-' removes a default; 'when' limits it", () => {
    const rules = compileRules(
      [
        { key: "ctrl+t", command: "a" },
        { key: "ctrl+t", command: "b", when: "editorTextFocus" },
        { key: "ctrl+k", command: "-workbench.action.terminal.clear", when: "terminalFocus" },
        { key: "ctrl+k ctrl+x", command: "c" },
      ],
      "linux",
    );
    const ctx = (focus: Record<string, unknown>) => (k: string) => focus[k];
    expect(resolveRules(rules, "mod+t", ctx({ editorTextFocus: true })).run?.command).toBe("b");
    expect(resolveRules(rules, "mod+t", ctx({})).run?.command).toBe("a");
    const k = resolveRules(rules, "mod+k", ctx({ terminalFocus: true }));
    expect(k.run).toBeNull();
    expect([...k.removed]).toEqual(["workbench.action.terminal.clear"]);
    expect(resolveRules(rules, "mod+k", ctx({})).removed.size).toBe(0);
    expect(rulesStartWith(rules, "mod+k")).toBe(true);
    expect(resolveRules(rules, "mod+k mod+x", ctx({})).run?.command).toBe("c");
  });
});
