import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { attachShellIntegration, decode633, neighbourCommand, parse633, stickyCommand, stateOf, type TerminalCommand } from "./shellIntegration";

const osc = (s: string) => `\x1b]633;${s}\x07`;
const write = (term: Terminal, data: string) => new Promise<void>((r) => term.write(data, r));

describe("OSC 633", () => {
  it("decodes escaped text", () => {
    expect(decode633("echo hi\\x3b ls \\\\n")).toBe("echo hi; ls \\n");
    expect(decode633("a\\x0ab")).toBe("a\nb");
  });

  it("parses each mark", () => {
    expect(parse633("A")).toEqual({ kind: "A" });
    expect(parse633("D;2")).toEqual({ kind: "D", exitCode: 2 });
    expect(parse633("D")).toEqual({ kind: "D", exitCode: undefined });
    expect(parse633("E;git status\\x3b ls;nonce")).toEqual({ kind: "E", command: "git status; ls" });
    expect(parse633("P;Cwd=/tmp/a\\x3bb")).toEqual({ kind: "P", key: "Cwd", value: "/tmp/a;b" });
    expect(parse633("Z")).toEqual({ kind: "unknown" });
  });
});

describe("attachShellIntegration", () => {
  const session = async () => {
    const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
    const drawn: string[] = [];
    // The headless terminal has no decorations: record what would be drawn.
    const si = attachShellIntegration(term as never, (c) => drawn.push(`${c.command}:${stateOf(c)}`));
    const prompt = (cwd: string) => `${osc(`P;Cwd=${cwd}`)}${osc("A")}~/p $ ${osc("B")}`;
    await write(term, prompt("/p"));
    return { term, si, drawn, prompt };
  };

  it("follows commands, their exit codes, output and cwd", async () => {
    const { term, si, drawn, prompt } = await session();
    expect(si.active).toBe(true);
    expect(si.cwd).toBe("/p");
    await write(term, `echo hi\r\n${osc("E;echo hi")}${osc("C")}hi\r\n${osc("D;0")}${prompt("/p")}`);
    await write(term, `false\r\n${osc("E;false")}${osc("C")}${osc("D;1")}${prompt("/tmp")}`);
    expect(si.commands.map((c) => [c.command, c.exitCode])).toEqual([
      ["echo hi", 0],
      ["false", 1],
    ]);
    expect(si.outputOf(si.commands[0])).toBe("hi");
    expect(si.cwd).toBe("/tmp");
    expect(drawn).toEqual(["echo hi:running", "echo hi:success", "false:running", "false:error"]);
  });

  it("reads the typed command when the shell sends no E", async () => {
    const { term, si } = await session();
    await write(term, `ls -la\r\n${osc("C")}a b\r\n${osc("D;0")}`);
    expect(si.commands[0].command).toBe("ls -la");
  });

  it("knows the running command", async () => {
    const { term, si } = await session();
    await write(term, `sleep 9\r\n${osc("E;sleep 9")}${osc("C")}`);
    expect(si.current?.command).toBe("sleep 9");
    expect(stateOf(si.current!)).toBe("running");
  });
});

describe("navigation", () => {
  const at = (line: number, end?: number) => ({ prompt: { line, isDisposed: false }, end: end === undefined ? undefined : { line: end, isDisposed: false }, command: `c${line}` }) as unknown as TerminalCommand;
  const cmds = [at(0, 3), at(3, 10), at(10)];

  it("finds the command above or below a line", () => {
    expect(neighbourCommand(cmds, 10, -1)?.command).toBe("c3");
    expect(neighbourCommand(cmds, 3, 1)?.command).toBe("c10");
    expect(neighbourCommand(cmds, 0, -1)).toBeUndefined();
  });

  it("pins the command whose output fills the top of the screen", () => {
    expect(stickyCommand(cmds, 5)?.command).toBe("c3");
    expect(stickyCommand(cmds, 9)).toBeUndefined(); // its output ends right below the pin
    expect(stickyCommand(cmds, 3)).toBeUndefined(); // the next prompt is on the top line
  });
});
