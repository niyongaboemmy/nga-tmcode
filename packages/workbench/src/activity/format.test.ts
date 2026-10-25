import { describe, expect, it } from "vitest";
import { ansiCommand, commandOf, detailRows, formatDuration, plural, runStatusOf, runStatusWords, runSubject, summarize, tokenizeCommand, type CommandTokenKind } from "./format";

const kinds = (line: string) => tokenizeCommand(line).filter((t) => t.kind !== "space").map((t) => [t.kind, t.text] as [CommandTokenKind, string]);

describe("tokenizeCommand", () => {
  it("joins back to the line it came from", () => {
    for (const line of ['ls -la "my dir" --color=auto', "npm run dev -- --port 5173", "cd src && python -u main.py < in.txt > out.txt 2>&1", "  echo  'a  b'  ", "FOO=1 BAR=x node app.js | grep -v x; echo $HOME"]) {
      expect(tokenizeCommand(line).map((t) => t.text).join("")).toBe(line);
    }
  });

  it("colours the program, flags, quoted strings, paths and numbers", () => {
    expect(kinds('ls -la "my dir" --color=auto')).toEqual([
      ["program", "ls"],
      ["flag", "-la"],
      ["string", '"my dir"'],
      ["flag", "--color"],
      ["operator", "="],
      ["text", "auto"],
    ]);
    expect(kinds("python -u src/main.py 42")).toEqual([
      ["program", "python"],
      ["flag", "-u"],
      ["path", "src/main.py"],
      ["number", "42"],
    ]);
  });

  it("starts a new program after && || | and ;, but not after a redirection", () => {
    expect(kinds("cd web && npm test | tee log.txt; make").filter(([k]) => k === "program").map(([, t]) => t)).toEqual(["cd", "npm", "tee", "make"]);
    expect(kinds("node a.js > out.txt")).toEqual([
      ["program", "node"],
      ["path", "a.js"],
      ["operator", ">"],
      ["path", "out.txt"],
    ]);
  });

  it("knows variables and leading assignments", () => {
    expect(kinds("NODE_ENV=test node $ENTRY")).toEqual([
      ["env", "NODE_ENV=test"],
      ["program", "node"],
      ["variable", "$ENTRY"],
    ]);
  });

  it("keeps an unterminated quote in one token", () => {
    expect(kinds('echo "oops')).toEqual([
      ["program", "echo"],
      ["string", '"oops'],
    ]);
  });

  it("is empty for an empty line", () => {
    expect(tokenizeCommand("")).toEqual([]);
  });

  it("writes ANSI colours for the Run console that strip back to the command", () => {
    const out = ansiCommand('gcc -o main "main file.c"');
    expect(out).toContain("\x1b[1mgcc\x1b[0m");
    expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe('gcc -o main "main file.c"');
  });
});

describe("run status chips", () => {
  it("says exit 0 with the duration in green, other codes in red", () => {
    expect(runStatusOf({ data: { exit: 0, duration_ms: 1234, status: "ok" } })).toEqual({ tone: "ok", label: "exit 0", duration: "1.2 s" });
    expect(runStatusOf({ data: { exit: 1, duration_ms: 9 } })).toEqual({ tone: "fail", label: "exit 1", duration: "9 ms" });
  });

  it("says stopped, timed out and running in words", () => {
    expect(runStatusOf({ data: { status: "stopped", exit: 130, duration_ms: 2000 } })).toEqual({ tone: "stopped", label: "stopped", duration: "2.0 s" });
    expect(runStatusOf({ data: { status: "timed-out", duration_ms: 5000 } })?.label).toBe("timed out");
    expect(runStatusOf({ data: { status: "running" } })).toEqual({ tone: "running", label: "running" });
  });

  it("has nothing to say for a terminal command (the shell doesn't report exits)", () => {
    expect(runStatusOf({ data: { command: "ls" } })).toBeNull();
    expect(runStatusOf({})).toBeNull();
  });

  it("reads as words for screen readers", () => {
    expect(runStatusWords({ tone: "ok", label: "exit 0", duration: "1.2 s" })).toBe("exited with code 0 in 1.2 s");
    expect(runStatusWords({ tone: "stopped", label: "stopped" })).toBe("stopped");
  });
});

describe("words", () => {
  it("pluralises", () => {
    expect(plural(1, "action")).toBe("1 action");
    expect(plural(0, "action")).toBe("0 actions");
    expect(plural(2, "file change")).toBe("2 file changes");
    expect(plural(3, "paste")).toBe("3 pastes");
  });

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1000)).toBe("1.0 s");
    expect(formatDuration(12_400)).toBe("12 s");
    expect(formatDuration(200_000)).toBe("3 min 20 s");
    expect(formatDuration(3_600_000)).toBe("1 h");
    expect(formatDuration(-1)).toBe("");
  });

  it("never says 'Ran Run'", () => {
    expect(runSubject("Run main.cpp")).toBe("main.cpp");
    expect(runSubject("Run hello.js with Node.js")).toBe("hello.js with Node.js");
    expect(runSubject("index.html - web (Live Preview)")).toBe("index.html - web (Live Preview)");
  });

  it("finds the command of an entry", () => {
    expect(commandOf({ data: { command: "  npm test " } })).toBe("npm test");
    expect(commandOf({ data: { files: 2 } })).toBeNull();
  });
});

describe("detail rows", () => {
  it("uses plain labels and formatted values, and hides internal keys", () => {
    const rows = detailRows({ data: { kind: "runFile", exit: 1, duration_ms: 1500, status: "error", origin: "outside", seconds: 200, ai: true, chars: 12000 } });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, `${r.label}: ${r.value}`]));
    expect(byKey.kind).toBeUndefined();
    expect(byKey.ai).toBeUndefined();
    expect(byKey.exit).toBeUndefined();
    expect(byKey.status).toBe("Result: exited with code 1");
    expect(byKey.duration_ms).toBe("Duration: 1.5 s");
    expect(byKey.origin).toBe("Came from: From outside TMCode");
    expect(byKey.seconds).toBe("Time away: 3 min 20 s");
    expect(byKey.chars).toMatch(/^Characters: 12.000$/);
  });

  it("shows the exit code when there is no result, and humanises unknown keys", () => {
    const rows = detailRows({ data: { exit: 0, someThing_else: "x", empty: "", none: null } });
    expect(rows.map((r) => `${r.label}: ${r.value}`)).toEqual(["Exit code: 0", "Some thing else: x"]);
  });
});

describe("day summary", () => {
  it("counts actions, AI use and its tools, files, pastes from outside, runs that failed and time away", () => {
    const s = summarize([
      { kind: "file", action: "create" },
      { kind: "file", action: "save" },
      { kind: "clipboard", action: "paste", data: { origin: "outside" } },
      { kind: "clipboard", action: "paste", data: { origin: "inside" } },
      { kind: "run", action: "run", data: { exit: 1 } },
      { kind: "run", action: "run", data: { exit: 0 } },
      { kind: "ai", action: "suggestion", ai: { by: "TMCode AI", how: "x" } },
      { kind: "file", action: "create", ai: { by: "Claude Code", how: "y" } },
      { kind: "editor", action: "away", data: { seconds: 90 } },
    ]);
    expect(s).toEqual({ actions: 9, ai: 2, aiTools: ["TMCode AI", "Claude Code"], files: 3, pastes: 2, outsidePastes: 1, runs: 2, failedRuns: 1, awayMs: 90_000 });
  });
});
