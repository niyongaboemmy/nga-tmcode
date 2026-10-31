import { describe, expect, it } from "vitest";
import { CLIS, cliAgentCommand, cliError, cliModeLabel, cliModelOf, cliOf, cliPrompt, isCliMode, isCliProvider, shellArg } from "./aiClis";
import { modeLabel } from "./service";

const ev = (o: unknown) => JSON.stringify(o);

describe("AI CLI modes", () => {
  it("knows which CLI and model a mode is for (only safe model names pass)", () => {
    expect(cliOf("cli:claude")).toBe("claude");
    expect(cliOf("cli:codex/gpt-5")).toBe("codex");
    expect(cliOf("cli:gemini/flash-lite")).toBe("gemini");
    expect(cliOf("cli:aider")).toBeNull();
    expect(isCliMode("byok:anthropic/claude-sonnet-5-5")).toBe(false);
    expect(cliModelOf("cli:claude/haiku")).toBe("haiku");
    expect(cliModelOf("cli:codex")).toBeNull();
    expect(cliModelOf("cli:codex/$(rm -rf ~)")).toBeNull();
    expect(cliModelOf("cli:gemini/pro; curl x|sh")).toBeNull();
    expect(cliModeLabel("cli:claude/opus")).toBe("Claude Code · Opus");
    expect(cliModeLabel("cli:codex/gpt-5.5")).toBe("ChatGPT (Codex) · gpt-5.5");
    expect(modeLabel("cli:gemini/flash", null)).toBe("Gemini CLI · Flash");
    expect(isCliProvider("Gemini CLI")).toBe(true);
    expect(isCliProvider("Groq")).toBe(false);
  });

  it("keeps the question off the command line: fixed words and a checked model only, read-only", () => {
    const words = /^[\w\s",./:=-]+$/;
    expect(CLIS.claude.headless("sonnet")).toMatch(/^claude -p --output-format stream-json .*--tools "" .*--model sonnet$/);
    expect(CLIS.codex.headless(null)).toBe("codex exec --json --skip-git-repo-check --ephemeral --color never --sandbox read-only -");
    expect(CLIS.gemini.headless("flash")).toBe('gemini -p "" --output-format stream-json --skip-trust --approval-mode plan --model flash');
    for (const id of ["claude", "codex", "gemini"] as const) expect(CLIS[id].headless("m")).toMatch(words);
  });
});

describe("each CLI's stream", () => {
  it("Claude Code: model, text as it comes, result", () => {
    const p = CLIS.claude.parse;
    expect(p(ev({ type: "stream_event", event: { type: "message_start", message: { model: "claude-haiku-5-5" } } }))).toEqual({ kind: "model", model: "claude-haiku-5-5" });
    expect(p(ev({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ls" } } }))).toEqual({ kind: "delta", text: "ls" });
    expect(p(ev({ type: "result", subtype: "success", is_error: false, result: "done" }))).toEqual({ kind: "result", text: "done", error: false });
    expect(p(ev({ type: "result", subtype: "error_max_turns", result: "" }))).toEqual({ kind: "result", text: "", error: true });
    expect(p(ev({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hm" } } }))).toBeNull();
    expect(p('{"type":"stream_ev')).toBeNull();
  });

  it("Codex: the agent's message (not its reasoning), the end, failures and a missing sign-in", () => {
    const p = CLIS.codex.parse;
    expect(p(ev({ type: "item.completed", item: { type: "reasoning", text: "hm" } }))).toBeNull();
    expect(p(ev({ type: "item.completed", item: { type: "agent_message", text: "Use ls." } }))).toEqual({ kind: "delta", text: "Use ls." });
    expect(p(ev({ type: "turn.completed", usage: {} }))).toEqual({ kind: "result", text: "", error: false });
    expect(p(ev({ type: "turn.failed", error: { message: "Usage limit reached" } }))).toEqual({ kind: "result", text: "Usage limit reached", error: true });
    expect(p(ev({ type: "error", message: "Reconnecting... 1/5 (unexpected status 401 Unauthorized: Missing bearer)" }))).toEqual({ kind: "result", text: "not logged in", error: true });
    expect(p(ev({ type: "error", message: "Reconnecting... 1/5 (stream disconnected)" }))).toBeNull();
  });

  it("Gemini CLI: model, the assistant's deltas (not the echoed question), result", () => {
    const p = CLIS.gemini.parse;
    expect(p(ev({ type: "init", model: "gemini-2.5-pro" }))).toEqual({ kind: "model", model: "gemini-2.5-pro" });
    expect(p(ev({ type: "message", role: "user", content: "q" }))).toBeNull();
    expect(p(ev({ type: "message", role: "assistant", content: "ls", delta: true }))).toEqual({ kind: "delta", text: "ls" });
    expect(p(ev({ type: "result", status: "success", stats: {} }))).toEqual({ kind: "result", text: "", error: false });
    expect(p(ev({ type: "result", status: "error", error: { message: "Quota exceeded" } }))).toEqual({ kind: "result", text: "Quota exceeded", error: true });
  });

  it("reads who is signed in", () => {
    expect(CLIS.claude.accountOf(ev({ loggedIn: true, email: "a@b.rw", subscriptionType: "max" }))).toBe("a@b.rw · Max");
    expect(CLIS.codex.accountOf("Logged in using ChatGPT\n")).toBe("ChatGPT account");
    expect(CLIS.codex.accountOf("Logged in using an API key - sk-proj-***\n")).toBe("OpenAI API key");
  });
});

describe("failures", () => {
  it("turns each CLI's failure into an error the widgets can act on, naming the CLI", () => {
    expect(cliError("claude", "zsh: command not found: claude", 127)).toMatchObject({ code: "CLI_MISSING", reason: "claude" });
    expect(cliError("codex", "'codex' is not recognized as an internal or external command").code).toBe("CLI_MISSING");
    expect(cliError("claude", "Not logged in · Please run /login").code).toBe("CLI_SIGNED_OUT");
    expect(cliError("codex", "not logged in")).toMatchObject({ code: "CLI_SIGNED_OUT", message: expect.stringContaining("ChatGPT account") });
    expect(cliError("gemini", "Please set an Auth method in your settings.json", 41).code).toBe("CLI_SIGNED_OUT");
    expect(cliError("gemini", "", 41).code).toBe("CLI_SIGNED_OUT");
    expect(cliError("claude", "Claude usage limit reached. Your limit will reset at 5pm.").code).toBe("CLI_LIMIT");
    expect(cliError("gemini", "RESOURCE_EXHAUSTED: Quota exceeded").code).toBe("CLI_LIMIT");
    expect(cliError("codex", "Third-party AI tools are off: your school turned them off").code).toBe("AI_DISABLED");
    expect(cliError("gemini", "something odd")).toMatchObject({ code: "CLI_FAILED", message: "Gemini CLI couldn't answer: something odd" });
  });
});

describe("the prompt", () => {
  it("gives terminal questions the terminal rules and the JSON format", () => {
    const p = cliPrompt([{ role: "user", content: "find big files" }], { purpose: "terminal" });
    expect(p).toContain("integrated terminal of TMCode");
    expect(p).toContain("ONE JSON object");
    expect(p.endsWith("The message:\nfind big files")).toBe(true);
  });

  it("gives chat questions the editor's context and the earlier turns", () => {
    const p = cliPrompt(
      [
        { role: "user", content: "what does this do?" },
        { role: "assistant", content: "It prints." },
        { role: "user", content: [{ type: "text", text: "and faster?" }] },
      ],
      { file: "src/a.js", language: "javascript", selection: "console.log(1)", problems: ["a.js:1 unused"] },
    );
    expect(p).toContain("coding assistant inside TMCode");
    expect(p).not.toContain("ONE JSON object");
    expect(p).toContain("Open file: src/a.js (javascript)");
    expect(p).toContain("```javascript\nconsole.log(1)\n```");
    expect(p).toContain("- a.js:1 unused");
    expect(p).toContain("User: what does this do?\n\nYou: It prints.");
    expect(p.endsWith("The new message:\nand faster?")).toBe(true);
  });
});

describe("agent modes (the CLI in the terminal)", () => {
  it("maps TMCode's modes to each CLI's own permission modes", () => {
    expect(cliAgentCommand("cli:claude", "fix it", "manual", false)).toBe("claude --permission-mode manual 'fix it'");
    expect(cliAgentCommand("cli:claude/sonnet", "fix it", "edit", false)).toBe("claude --permission-mode acceptEdits --model sonnet 'fix it'");
    expect(cliAgentCommand("cli:claude", "", "plan", false)).toBe("claude --permission-mode plan");
    expect(cliAgentCommand("cli:codex", "fix it", "manual", false)).toBe("codex --sandbox read-only --ask-for-approval on-request 'fix it'");
    expect(cliAgentCommand("cli:codex", "fix it", "auto", false)).toBe("codex --sandbox workspace-write --ask-for-approval on-request 'fix it'");
    expect(cliAgentCommand("cli:codex", "fix it", "plan", false)).toBe("codex --sandbox read-only --ask-for-approval on-request 'Plan only, don'\\''t change files yet: fix it'");
    expect(cliAgentCommand("cli:gemini/pro", "fix it", "edit", false)).toBe("gemini --approval-mode auto_edit --model pro -i 'fix it'");
    expect(cliAgentCommand("cli:gemini", "fix it", "manual", false)).toBe("gemini --approval-mode default -i 'fix it'");
    expect(cliAgentCommand("cli:gemini", "x", "plan", false)).toContain("--approval-mode plan");
  });

  it("quotes the task as one argument the shell can't break out of", () => {
    expect(shellArg("it's $(rm -rf ~) `x`", false)).toBe(`'it'\\''s $(rm -rf ~) \`x\`'`);
    expect(shellArg("it's $(whoami)", true)).toBe("'it''s $(whoami)'");
    expect(shellArg("line one\nline\ttwo\r\n", false)).toBe("'line one line two'");
    expect(shellArg("a".repeat(5000), false).length).toBe(2002);
  });
});
