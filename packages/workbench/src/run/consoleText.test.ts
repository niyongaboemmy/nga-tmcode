import { describe, expect, it } from "vitest";
import { renderConsoleEvent } from "./consoleText";

const plain = (s: string | null) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

describe("Run console lines", () => {
  it("echoes the command as a $ prompt, with the sandbox note dimmed after it", () => {
    const out = renderConsoleEvent({ type: "step", phase: "run", command: "node sum.js (browser sandbox)" }, false) as string;
    expect(plain(out)).toBe("$ node sum.js (browser sandbox)\r\n");
    expect(out).toContain("\x1b[1mnode\x1b[0m");
    expect(plain(renderConsoleEvent({ type: "step", phase: "build", command: "gcc -o main main.c" }, false))).toBe("build $ gcc -o main main.c\r\n");
  });

  it("says how the program ended in one status line", () => {
    const exit = { type: "exit" as const, phase: "run" as const, timed_out: false, truncated: false, killed: false, duration_ms: 1234 };
    expect(plain(renderConsoleEvent({ ...exit, code: 0 }, false))).toBe("\r\n✓ Process exited with code 0 in 1.2 s\r\n");
    expect(renderConsoleEvent({ ...exit, code: 0 }, false)).toContain("\x1b[32m");
    expect(plain(renderConsoleEvent({ ...exit, code: 1, duration_ms: 9 }, false))).toBe("\r\n✗ Process exited with code 1 in 9 ms\r\n");
    expect(renderConsoleEvent({ ...exit, code: 1 }, false)).toContain("\x1b[31m");
    expect(plain(renderConsoleEvent({ ...exit, code: null, killed: true }, false))).toBe("\r\n■ Process stopped after 1.2 s\r\n");
    expect(plain(renderConsoleEvent({ ...exit, code: null, timed_out: true, duration_ms: 5000 }, false))).toContain("timed out after 5.0 s");
    expect(renderConsoleEvent({ ...exit, phase: "build", code: 0 }, false)).toBe("");
    // Output that didn't end its line still gets a blank line before the status.
    expect(plain(renderConsoleEvent({ ...exit, code: 0 }, false, false))).toBe("\r\n\r\n✓ Process exited with code 0 in 1.2 s\r\n");
    expect(plain(renderConsoleEvent({ ...exit, phase: "build", code: 2 }, false))).toContain("Build failed (exit code 2)");
  });

  it("keeps program output as it is, stderr red, and pipe newlines for xterm", () => {
    expect(renderConsoleEvent({ type: "stdout", data: "a\nb" }, false)).toBe("a\r\nb");
    expect(renderConsoleEvent({ type: "stdout", data: "a\nb" }, true)).toBe("a\nb");
    expect(renderConsoleEvent({ type: "stderr", data: "oops" }, false)).toBe("\x1b[31moops\x1b[0m");
    expect(renderConsoleEvent({ type: "clear" }, false)).toBe("clear");
    expect(plain(renderConsoleEvent({ type: "info", text: "▶ Running sum.js." }, false))).toBe("▶ Running sum.js.\r\n");
  });
});
