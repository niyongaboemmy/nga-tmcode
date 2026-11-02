import { describe, expect, it } from "vitest";
import { matchAiTool, packageName, programName } from "./aiTools";

const tool = (cmd: string | string[]) => matchAiTool(Array.isArray(cmd) ? cmd : cmd.split(" "));

describe("AI tool matcher", () => {
  it("names programs and packages", () => {
    expect(programName("C:\\Users\\a\\AppData\\Roaming\\npm\\Claude.CMD")).toBe("claude");
    expect(programName("/usr/bin/python3.12")).toBe("python3.12");
    expect(packageName("@openai/codex@0.1.2")).toBe("@openai/codex");
    expect(packageName("aider-chat[playwright]==0.86")).toBe("aider-chat");
    expect(packageName("opencode-ai@latest")).toBe("opencode-ai");
  });

  it("finds the tools themselves", () => {
    expect(tool("claude -p hi")).toEqual({ tool: "Claude Code", kind: "run" });
    expect(tool("/opt/homebrew/bin/codex")?.tool).toBe("Codex CLI");
    expect(tool(["C:\\Users\\a\\AppData\\Roaming\\npm\\gemini.cmd"])?.tool).toBe("Gemini CLI");
    expect(tool(["/Users/a/.local/bin/agy", "-p=hi"])?.tool).toBe("Antigravity CLI");
    expect(tool(["C:\\Users\\a\\AppData\\Local\\agy\\bin\\agy.exe"])?.tool).toBe("Antigravity CLI");
    expect(tool(["C:\\tools\\aider.exe", "--model", "x"])?.tool).toBe("Aider");
    expect(tool("gh copilot suggest")?.tool).toBe("GitHub Copilot CLI");
    expect(tool("cursor-agent")?.tool).toBe("Cursor Agent");
  });

  it("finds tools run through node, python, npx and friends", () => {
    expect(tool("node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js")?.tool).toBe("Claude Code");
    expect(tool(["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js"])?.tool).toBe("Gemini CLI");
    expect(tool("node /Users/a/.npm-global/bin/claude")?.tool).toBe("Claude Code");
    expect(tool("python3 -m aider --yes")?.tool).toBe("Aider");
    expect(tool("npx @anthropic-ai/claude-code")?.tool).toBe("Claude Code");
    expect(tool("npx -y @openai/codex@latest")?.tool).toBe("Codex CLI");
    expect(tool("npx opencode")?.tool).toBe("opencode");
    expect(tool("pnpm dlx @qwen-code/qwen-code")?.tool).toBe("Qwen Code");
    expect(tool("npm exec @google/gemini-cli")?.tool).toBe("Gemini CLI");
    expect(tool("uvx --from aider-chat aider")?.tool).toBe("Aider");
    expect(tool("pipx run shell-gpt")?.tool).toBe("ShellGPT");
  });

  it("finds installs", () => {
    expect(tool("npm install -g @anthropic-ai/claude-code")).toEqual({ tool: "Claude Code", kind: "install" });
    expect(tool("npm i -g express @openai/codex")?.tool).toBe("Codex CLI");
    expect(tool("pip install aider-chat")).toEqual({ tool: "Aider", kind: "install" });
    expect(tool("pip3 install --user shell-gpt==1.4")?.tool).toBe("ShellGPT");
    expect(tool("python -m pip install aider-install")?.tool).toBe("Aider");
    expect(tool("pipx install llm")?.tool).toBe("LLM");
    expect(tool("uv tool install aider-chat")?.tool).toBe("Aider");
    expect(tool("brew install ollama")?.tool).toBe("Ollama");
    expect(tool("brew install charmbracelet/tap/crush")?.tool).toBe("Crush");
    expect(tool("yarn global add @google/gemini-cli")?.tool).toBe("Gemini CLI");
    expect(tool("gh extension install github/gh-copilot")?.tool).toBe("GitHub Copilot CLI");
  });

  it("leaves ordinary work alone", () => {
    expect(tool("npm install")).toBeNull();
    expect(tool("npm install express react")).toBeNull();
    expect(tool("npm i mods")).toBeNull(); // a program name is not a package name
    expect(tool("node server.js")).toBeNull();
    expect(tool("python3 main.py")).toBeNull();
    expect(tool("python -m http.server")).toBeNull();
    expect(tool("pip install requests openai")).toBeNull();
    expect(tool("git commit -m claude")).toBeNull();
    expect(tool("gh pr list")).toBeNull();
    expect(tool("brew install git")).toBeNull();
    expect(tool("/bin/zsh -l")).toBeNull();
    expect(matchAiTool([])).toBeNull();
  });
});
