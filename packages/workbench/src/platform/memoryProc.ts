import type { FileSystem, ProcHost } from "./types";

/**
 * Dev server / e2e only: a pretend `pytest` for the Testing view's framework
 * runs. It finds `def test_…` functions in test_*.py files and fails the ones
 * whose body has `assert False` or compares two different numbers
 * (`assert 4 == 5`), then writes the JUnit report pytest would. Any other
 * command answers "not found" like a shell would.
 *
 * Also the AI companies' CLIs (ai/aiClis.ts) when localStorage `tmcode:mock-clis`
 * names them, e.g. {"claude":"ready","codex":"signed-out","gemini":"limit"}
 * (a CLI it doesn't name is not installed). Headless questions stream each
 * CLI's real JSON lines; the last prompt (stdin) and command are kept in
 * `window.__tmcodeCli` for tests.
 */
function mockClis(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem("tmcode:mock-clis") ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** The pretend `claude`, `codex` and `gemini` (false: not one of them). */
function simulateCli(command: string, stdin: string | undefined, onEvent: Parameters<ProcHost["run"]>[2]): boolean {
  const statusCheck = /\.gemini|GEMINI_API_KEY/.test(command);
  const cli = statusCheck ? "gemini" : /^(claude|codex|gemini)\b/.exec(command)?.[1];
  if (!cli) return false;
  const state = mockClis()[cli];
  const out = (o: unknown) => onEvent({ type: "stdout", data: `${JSON.stringify(o)}\n` });
  const exit = (code: number) => onEvent({ type: "exit", code });
  if (!state) {
    onEvent({ type: "stderr", data: `zsh: command not found: ${cli}\n` });
    exit(127);
    return true;
  }
  const signedOut = state === "signed-out";
  if (statusCheck) return exit(signedOut ? 1 : 0), true;
  if (/ --version$/.test(command)) {
    onEvent({ type: "stdout", data: { claude: "2.1.310 (Claude Code)\n", codex: "codex-cli 0.166.0\n", gemini: "0.66.0\n" }[cli]! });
    return exit(0), true;
  }
  if (cli === "claude" && /auth status/.test(command)) return out({ loggedIn: !signedOut, authMethod: "claude.ai", email: "student@nga.ac.rw", subscriptionType: "pro" }), exit(signedOut ? 1 : 0), true;
  if (cli === "codex" && /login status/.test(command)) {
    onEvent({ type: "stdout", data: signedOut ? "Not logged in\n" : "Logged in using ChatGPT\n" });
    return exit(signedOut ? 1 : 0), true;
  }
  const headless = cli === "claude" ? / -p\b/.test(command) : cli === "codex" ? /^codex exec\b/.test(command) : / -p ""/.test(command);
  if (!headless) return exit(0), true;
  (window as unknown as { __tmcodeCli?: { command: string; stdin: string } }).__tmcodeCli = { command, stdin: stdin ?? "" };
  const model = /--model (\S+)/.exec(command)?.[1];
  const text = cliAnswer(cli, stdin ?? "");
  const failure = signedOut ? { claude: "Not logged in · Please run /login", codex: "401 Unauthorized: Missing bearer or basic authentication in header", gemini: "Please set an Auth method" }[cli]! : state === "limit" ? "Usage limit reached for your plan. Try again at 5pm." : null;
  if (cli === "claude") {
    out({ type: "system", subtype: "init", tools: [] });
    if (failure) out({ type: "result", subtype: "success", is_error: true, result: failure });
    else {
      out({ type: "stream_event", event: { type: "message_start", message: { model: `claude-${model ?? "sonnet"}-5-5` } } });
      for (let i = 0; i < text.length; i += 16) out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 16) } } });
      out({ type: "result", subtype: "success", is_error: false, result: text });
    }
  } else if (cli === "codex") {
    out({ type: "thread.started", thread_id: "t1" });
    out({ type: "turn.started" });
    if (signedOut) out({ type: "error", message: `Reconnecting... 1/5 (${failure})` });
    else if (failure) out({ type: "turn.failed", error: { message: failure } });
    else {
      out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Thinking about it" } });
      out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
      out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 20 } });
    }
  } else {
    if (signedOut) {
      onEvent({ type: "stderr", data: `${failure} in your settings.json\n` });
      return exit(41), true;
    }
    out({ type: "init", session_id: "s1", model: model ? `gemini-${model}` : "gemini-2.5-pro" });
    out({ type: "message", role: "user", content: "…" });
    if (failure) out({ type: "result", status: "error", error: { type: "QuotaError", message: failure } });
    else {
      for (let i = 0; i < text.length; i += 16) out({ type: "message", role: "assistant", content: text.slice(i, i + 16), delta: true });
      out({ type: "result", status: "success", stats: {} });
    }
  }
  exit(failure ? 1 : 0);
  return true;
}

/** The pretend CLIs' answers: terminal JSON for terminal questions, else a short Markdown answer naming the CLI. */
function cliAnswer(cli: string, prompt: string): string {
  const name = { claude: "Claude Code", codex: "ChatGPT", gemini: "Gemini" }[cli];
  const message = prompt.slice(prompt.lastIndexOf("message:\n") + "message:\n".length);
  if (/ONE JSON object/.test(prompt)) {
    if (/port/i.test(message)) return JSON.stringify({ commands: [{ command: "lsof -ti :3000 | xargs kill", explanation: "Finds what listens on port 3000 (-t: ids only) and stops it." }], explanation: `${name}: this stops the program using port 3000.`, risk: "caution" });
    return JSON.stringify({ commands: [{ command: "ls -la", explanation: "Lists every file (-a) with details (-l)." }], explanation: `${name}: this lists the folder.`, risk: "safe" });
  }
  return `${name} here. You asked: _${message.trim().slice(0, 80)}_`;
}

export function createSimulatedProc(fs: FileSystem): ProcHost {
  let next = 0;
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await fs.readDir(dir).catch(() => []);
    const out: string[] = [];
    for (const e of entries) {
      const p = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === "dir" && !e.name.startsWith(".")) out.push(...(await walk(p)));
      else if (e.kind === "file" && /^test_.*\.py$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  return {
    async run(command, cwd, onEvent, opts) {
      const id = ++next;
      setTimeout(async () => {
        if (simulateCli(command, opts?.stdin, onEvent)) return;
        // The Testing view asks whether pytest is installed (else it uses unittest): it is, here.
        if (/-c "import pytest"/.test(command)) {
          onEvent({ type: "exit", code: 0 });
          return;
        }
        if (!/pytest/.test(command)) {
          onEvent({ type: "stderr", data: `zsh: command not found: ${command.split(" ")[0]}\n` });
          onEvent({ type: "exit", code: 127 });
          return;
        }
        const join = (p: string) => (cwd ? `${cwd}/${p}` : p);
        const report = /--junitxml=(\S+)/.exec(command)?.[1];
        const only = /-k (\S+)/.exec(command)?.[1]?.replace(/^"|"$/g, "");
        const fileArg = command.split(" ").find((a) => /\.py$/.test(a));
        const files = fileArg ? [join(fileArg)] : await walk(cwd);
        const cases: string[] = [];
        let failed = 0;
        let total = 0;
        for (const file of files) {
          const lines = (await fs.readFile(file).catch(() => "")).split("\n");
          const mod = file.replace(/^.*\//, "").replace(/\.py$/, "");
          lines.forEach((l, i) => {
            const m = /^def (test\w*)\s*\(/.exec(l);
            if (!m || (only && m[1] !== only)) return;
            total++;
            let bad: { line: number; text: string } | null = null;
            for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || !lines[j]); j++) {
              const a = /assert (\d+) == (\d+)/.exec(lines[j]);
              if (/assert False/.test(lines[j]) || (a && a[1] !== a[2])) bad = { line: j + 1, text: lines[j].trim() };
              if (bad) break;
            }
            const rel = cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
            if (bad) {
              failed++;
              const msg = `AssertionError: ${bad.text}`;
              cases.push(`<testcase classname="${mod}" name="${m[1]}" time="0.001"><failure message="${esc(msg)}">${esc(`${rel}:${bad.line}: in ${m[1]}\n    ${bad.text}\nE   ${msg}`)}</failure></testcase>`);
              onEvent({ type: "stdout", data: "F" });
            } else {
              cases.push(`<testcase classname="${mod}" name="${m[1]}" time="0.001" />`);
              onEvent({ type: "stdout", data: "." });
            }
          });
        }
        if (report) {
          const path = join(report).split("/").reduce<string[]>((acc, part) => (part === ".." ? acc.slice(0, -1) : part === "." ? acc : [...acc, part]), []).join("/");
          const parts = path.split("/");
          for (let i = 1; i < parts.length; i++) await fs.createDir(parts.slice(0, i).join("/")).catch(() => {});
          await fs.writeFile(path, `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" tests="${total}" failures="${failed}">${cases.join("")}</testsuite></testsuites>`);
        }
        onEvent({ type: "stdout", data: `\n${total - failed} passed${failed ? `, ${failed} failed` : ""}\n` });
        onEvent({ type: "exit", code: total === 0 ? 5 : failed ? 1 : 0 });
      }, 50);
      return id;
    },
    async kill() {},
  };
}
