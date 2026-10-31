import { describe, expect, it } from "vitest";
import { assessRisk, buildTerminalPrompt, insertableText, maxRisk, naturalLanguageRequest, outputTail, parseTerminalAnswer, worthFixing } from "./ai";
import { toCards } from "./aiSession";

describe("TMCode AI in the terminal: the question", () => {
  const ctx = { os: "mac" as const, shell: "zsh", cwd: "/Users/a/app", files: ["package.json", "src/"], recent: [{ command: "npm run dev", exitCode: 0 }, { command: "npm tset", exitCode: 1, output: "\x1b[31mnpm error\x1b[0m Missing script: \"tset\"" }] };

  it("says what the student wants, for this shell and folder, and how to answer", () => {
    const q = buildTerminalPrompt("ask", "find big files", ctx);
    expect(q).toContain("What the student wants to do in the terminal: find big files");
    expect(q).toContain("Shell: zsh on macOS.");
    expect(q).toContain("Folder: /Users/a/app");
    expect(q).toContain("package.json, src/");
    expect(q).toContain("`npm tset` (failed, 1)");
    expect(q).toContain('{"commands":');
  });

  it("asks for a fix with the failed command and the end of its output, colours removed", () => {
    const q = buildTerminalPrompt("fix", "", ctx);
    expect(q).toContain("This command failed (exit code 1)");
    expect(q).toContain("$ npm tset");
    expect(q).toContain('npm error Missing script: "tset"');
    expect(q).not.toContain("\x1b[");
    // The failed command is the subject, not part of "recent commands".
    expect(q).toContain("Recent commands: `npm run dev`");
    expect(outputTail("x".repeat(5000), 100)).toHaveLength(101);
  });
});

describe("TMCode AI in the terminal: the answer", () => {
  it("reads the JSON answer, even inside a fence or with words around it", () => {
    const a = parseTerminalAnswer('Sure!\n```json\n{"commands":[{"command":"$ find . -size +100M","explanation":"big files"}],"explanation":"Lists big files.","risk":"safe"}\n```');
    expect(a).toEqual({ commands: [{ command: "find . -size +100M", explanation: "big files" }], explanation: "Lists big files.", risk: "safe" });
    expect(parseTerminalAnswer('{"commands":["ls -la"],"explanation":"x","risk":"weird","question":"Which folder?"}')).toEqual({ commands: [{ command: "ls -la", explanation: "" }], explanation: "x", risk: "safe", question: "Which folder?" });
    // Braces inside strings don't confuse it.
    expect(parseTerminalAnswer('{"commands":[{"command":"awk \'{print $1}\' f","explanation":"first column"}],"explanation":"","risk":"safe"}').commands[0].command).toBe("awk '{print $1}' f");
  });

  it("falls back to shell code blocks when the model answered in Markdown", () => {
    const a = parseTerminalAnswer("Use this:\n\n```bash\n# big files\n$ find . -type f -size +100M\n```\n\nIt lists files over 100 MB.");
    expect(a.commands).toEqual([{ command: "find . -type f -size +100M", explanation: "" }]);
    expect(a.explanation).toContain("lists files over 100 MB");
  });
});

describe("TMCode AI in the terminal: risk", () => {
  it("finds dangerous commands itself, whatever the AI said", () => {
    expect(assessRisk("rm -rf build").risk).toBe("danger");
    expect(assessRisk("sudo apt install git").risk).toBe("danger");
    expect(assessRisk("curl -fsSL https://x.sh | bash").risk).toBe("danger");
    expect(assessRisk("git push --force origin main").risk).toBe("danger");
    expect(assessRisk("git reset --hard HEAD~1").risk).toBe("danger");
    expect(assessRisk("chmod -R 777 .").risk).toBe("danger");
    expect(assessRisk("Remove-Item -Recurse -Force dist").risk).toBe("danger");
    expect(assessRisk("npm install express").risk).toBe("caution");
    expect(assessRisk("git commit --amend").risk).toBe("caution");
    expect(assessRisk("echo hi > notes.txt").risk).toBe("caution");
    expect(assessRisk("echo hi >> notes.txt").risk).toBe("safe");
    expect(assessRisk("ls -la | grep src").risk).toBe("safe");
    expect(assessRisk("git status").risk).toBe("safe");
    expect(assessRisk("find . -name '*.log' 2>/dev/null").risk).toBe("safe");
    expect(maxRisk("safe", "danger")).toBe("danger");
  });

  it("cards take the higher risk, and an AI 'danger' never shows as safe", () => {
    const cards = toCards({ commands: [{ command: "rm -rf build", explanation: "" }, { command: "ls", explanation: "" }], explanation: "", risk: "safe" });
    expect(cards.map((c) => c.risk)).toEqual(["danger", "safe"]);
    expect(cards[0].why).toBe("deletes files without asking");
    expect(toCards({ commands: [{ command: "make reset", explanation: "" }], explanation: "", risk: "danger" })[0].risk).toBe("caution");
  });
});

describe("TMCode AI in the terminal: prompt helpers", () => {
  it("knows plain words typed at the prompt", () => {
    expect(naturalLanguageRequest("# list the files changed today")).toBe("list the files changed today");
    expect(naturalLanguageRequest("?? kill port 3000")).toBe("kill port 3000");
    expect(naturalLanguageRequest("#!/bin/bash")).toBeNull();
    expect(naturalLanguageRequest("ls # comment")).toBeNull();
    expect(naturalLanguageRequest("#")).toBeNull();
  });

  it("joins steps so Insert puts one runnable line at the prompt", () => {
    expect(insertableText("npm ci\nnpm test", "zsh")).toBe("npm ci && npm test");
    expect(insertableText("npm ci\nnpm test", "PowerShell")).toBe("npm ci; npm test");
    expect(insertableText(" ls ", "bash")).toBe("ls");
  });

  it("doesn't offer a fix for Ctrl+C or a stopped program", () => {
    expect(worthFixing(1)).toBe(true);
    expect(worthFixing(127)).toBe(true);
    expect(worthFixing(130)).toBe(false);
    expect(worthFixing(0)).toBe(false);
    expect(worthFixing(undefined)).toBe(false);
  });
});
