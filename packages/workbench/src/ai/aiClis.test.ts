import { describe, expect, it } from "vitest";
import { CLIS, GEMINI_MOVED, cliAgentCommand, cliError, cliModeLabel, cliModelOf, cliOf, cliPrompt, installCommand, isCliMode, isCliProvider, shellArg, withCliPath } from "./aiClis";
import { modeLabel } from "./service";

const ev = (o: unknown) => JSON.stringify(o);

describe("AI CLI modes", () => {
  it("knows which CLI and model a mode is for (only safe model names pass)", () => {
    expect(cliOf("cli:claude")).toBe("claude");
    expect(cliOf("cli:codex/gpt-5")).toBe("codex");
    expect(cliOf("cli:gemini/flash-lite")).toBe("gemini");
    expect(cliOf("cli:agy/gemini-3.8-flash-medium")).toBe("agy");
    expect(cliModelOf("cli:agy/gemini-3.1-pro-high")).toBe("gemini-3.1-pro-high");
    expect(cliModeLabel("cli:agy/gemini-3.1-pro-high")).toBe("Gemini (Antigravity) · Gemini 3.1 Pro");
    expect(isCliProvider("Gemini (Antigravity)")).toBe(true);
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
    expect(CLIS.agy.headless(null)).toBe("agy --output-format stream-json --mode plan --disable-slash-commands");
    expect(CLIS.agy.headless("gemini-3.8-flash-low")).toBe("agy --output-format stream-json --mode plan --disable-slash-commands --model gemini-3.8-flash-low");
    expect(CLIS.agy.headless(null)).not.toMatch(/ -p\b| --print\b/);
    for (const id of ["claude", "codex", "agy", "gemini"] as const) expect(CLIS[id].headless("m")).toMatch(words);
  });

  it("finds agy where its installer put it, and installs it the right way for the OS", () => {
    expect(withCliPath("agy", "agy --version", false)).toBe('export PATH="$PATH:$HOME/.local/bin"; agy --version');
    expect(withCliPath("agy", "agy models", true)).toBe('set "PATH=%PATH%;%LOCALAPPDATA%\\agy\\bin" && agy models');
    expect(withCliPath("claude", "claude --version", false)).toBe("claude --version");
    expect(installCommand("agy", false)).toBe("curl -fsSL https://antigravity.google/cli/install.sh | bash");
    expect(installCommand("agy", true)).toBe("irm https://antigravity.google/cli/install.ps1 | iex");
    expect(installCommand("gemini", true)).toBe("npm install -g @google/gemini-cli");
    expect(CLIS.agy.statusCommand(false)).toBe("agy models");
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

  it("Antigravity CLI: model from init, the agent's text deltas (not tools or the question), result (agy 1.4.12 lines)", () => {
    const p = CLIS.agy.parse;
    expect(p(ev({ event: "init", conversation_id: "c", init: { model: "gemini-3.8-flash", cwd: "/x", tools: [], permission_mode: "request-review" } }))).toEqual({ kind: "model", model: "gemini-3.8-flash" });
    expect(p(ev({ event: "init", conversation_id: "c", init: { cwd: "/x", tools: [] } }))).toBeNull();
    expect(p(ev({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } }))).toBeNull();
    expect(p(ev({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Use ls" } }))).toEqual({ kind: "delta", text: "Use ls" });
    expect(p(ev({ event: "step_update", step_update: { step_type: "tool", tool_name: "view_file", text_delta: "file text" } }))).toBeNull();
    expect(p(ev({ event: "result", result: { status: "SUCCESS", response: "Use ls -la.", num_turns: 1 } }))).toEqual({ kind: "result", text: "Use ls -la.", error: false });
    // Signed out (verified with agy 1.4.12): exit 1, this result line, "authentication required" on stderr.
    const out = p(ev({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out", finished_reason: "error" } }));
    expect(out).toEqual({ kind: "result", text: "authentication failed or timed out", error: true });
    expect(p(ev({ event: "result", result: { status: "CANCELED", response: "" } }))).toMatchObject({ error: true });
    expect(p('{"event":"step_upd')).toBeNull();
  });

  it("reads who is signed in", () => {
    expect(CLIS.claude.accountOf(ev({ loggedIn: true, email: "a@b.rw", subscriptionType: "max" }))).toBe("a@b.rw · Max");
    expect(CLIS.codex.accountOf("Logged in using ChatGPT\n")).toBe("ChatGPT account");
    expect(CLIS.codex.accountOf("Logged in using an API key - sk-proj-***\n")).toBe("OpenAI API key");
    expect(CLIS.gemini.accountOf("Gemini API key\n")).toBe("Gemini API key");
    expect(CLIS.gemini.accountOf("Google account\n")).toBe("Google account");
  });
});

describe("failures", () => {
  it("turns each CLI's failure into an error the widgets can act on, naming the CLI", () => {
    expect(cliError("claude", "zsh: command not found: claude", 127)).toMatchObject({ code: "CLI_MISSING", reason: "claude" });
    expect(cliError("codex", "'codex' is not recognized as an internal or external command").code).toBe("CLI_MISSING");
    expect(cliError("claude", "Not logged in · Please run /login").code).toBe("CLI_SIGNED_OUT");
    expect(cliError("codex", "not logged in")).toMatchObject({ code: "CLI_SIGNED_OUT", message: expect.stringContaining("ChatGPT account") });
    expect(cliError("agy", "Error: authentication required. Run 'agy' to log in, then retry.", 1)).toMatchObject({ code: "CLI_SIGNED_OUT", reason: "agy", message: expect.stringContaining("Google account") });
    expect(cliError("agy", "authentication failed or timed out").code).toBe("CLI_SIGNED_OUT");
    expect(cliError("agy", "RESOURCE_EXHAUSTED: quota exceeded").code).toBe("CLI_LIMIT");
    expect(cliError("agy", "zsh:1: command not found: agy", 127).code).toBe("CLI_MISSING");
    expect(cliError("agy", 'invalid model selection (--model "x"): model x is not recognized as a known model or custom model in settings').message).toContain("agy models");
    expect(cliError("claude", "Claude usage limit reached. Your limit will reset at 5pm.").code).toBe("CLI_LIMIT");
    expect(cliError("gemini", "RESOURCE_EXHAUSTED: Quota exceeded").code).toBe("CLI_LIMIT");
    expect(cliError("codex", "Third-party AI tools are off: your school turned them off").code).toBe("AI_DISABLED");
    expect(cliError("gemini", "something odd")).toMatchObject({ code: "CLI_FAILED", message: "Gemini CLI couldn't answer: something odd" });
  });

  it("Gemini CLI's account failures say Google moved personal accounts to agy (an API key still works)", () => {
    const moved = { code: "CLI_MOVED", reason: "gemini", message: GEMINI_MOVED };
    expect(GEMINI_MOVED).toBe("Google moved personal and AI Pro accounts from Gemini CLI to Antigravity CLI (agy). Install agy or add a Gemini API key.");
    // Gemini CLI 0.66.0, verified: no auth method → exit 41; an expired Google sign-in headless → exit 42.
    expect(cliError("gemini", "Please set an Auth method in your /Users/a/.gemini/settings.json or specify one of the following environment variables", 41)).toMatchObject(moved);
    expect(cliError("gemini", "", 41)).toMatchObject(moved);
    expect(cliError("gemini", "Opening authentication page in your browser. Do you want to continue? [Y/n]\nError authenticating: FatalCancellationError: Authentication cancelled by user.", 42)).toMatchObject(moved);
    expect(cliError("gemini", "not logged in", 41)).toMatchObject(moved);
    expect(cliError("gemini", "This Google account is no longer supported in Gemini CLI. Use Antigravity CLI.")).toMatchObject(moved);
    expect(cliError("gemini", "API key not valid. Please pass a valid API key.")).toMatchObject({ code: "CLI_SIGNED_OUT", message: expect.stringContaining("GEMINI_API_KEY") });
    expect(cliError("gemini", "RESOURCE_EXHAUSTED: Quota exceeded").code).toBe("CLI_LIMIT");
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
    expect(cliAgentCommand("cli:agy", "fix it", "manual", false)).toBe("agy -i 'fix it'");
    expect(cliAgentCommand("cli:agy/gemini-3.1-pro-high", "fix it", "edit", false)).toBe("agy --mode accept-edits --model gemini-3.1-pro-high -i 'fix it'");
    expect(cliAgentCommand("cli:agy", "x", "plan", false)).toBe("agy --mode plan -i 'x'");
    expect(cliAgentCommand("cli:agy", "x", "auto", false)).toBe("agy --mode accept-edits -i 'x'");
    expect(cliAgentCommand("cli:agy", "", "plan", false)).toBe("agy --mode plan");
  });

  it("quotes the task as one argument the shell can't break out of", () => {
    expect(shellArg("it's $(rm -rf ~) `x`", false)).toBe(`'it'\\''s $(rm -rf ~) \`x\`'`);
    expect(shellArg("it's $(whoami)", true)).toBe("'it''s $(whoami)'");
    expect(shellArg("line one\nline\ttwo\r\n", false)).toBe("'line one line two'");
    expect(shellArg("a".repeat(5000), false).length).toBe(2002);
  });
});
