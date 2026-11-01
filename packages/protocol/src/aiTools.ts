/**
 * Third-party AI tools a student can start from a terminal (AI usage control plan §6.4): coding
 * agents and chat CLIs, and the packages that install them. The one catalogue: the workbench sends
 * it to the desktop app (`ai_tools_policy`), whose matcher (src-tauri/src/ai_tools.rs) mirrors
 * `matchAiTool` below. Values are the names people know the tools by.
 *
 * Best-effort only: a renamed binary, a student's own program calling an AI API, or a container
 * gets past it. The activity log is the backstop.
 */

export interface AiToolCatalog {
  /** Program names (no .exe/.cmd), lower case. */
  bins: Record<string, string>;
  /** `<program> <subcommand>` pairs ("gh copilot"). */
  subcommands: Record<string, Record<string, string>>;
  /** npm packages (npx, npm exec, npm install -g, node …/node_modules/<pkg>/…). */
  npm: Record<string, string>;
  /** PyPI packages (pip install, pipx, uvx). */
  pip: Record<string, string>;
  /** Python modules (python -m <module>). */
  modules: Record<string, string>;
  /** Homebrew formulae and casks (last path segment of tap names). */
  brew: Record<string, string>;
}

export const AI_TOOL_CATALOG: AiToolCatalog = {
  bins: {
    claude: "Claude Code",
    "claude-code": "Claude Code",
    codex: "Codex CLI",
    gemini: "Gemini CLI",
    agy: "Antigravity CLI",
    antigravity: "Antigravity CLI",
    copilot: "GitHub Copilot CLI",
    "github-copilot-cli": "GitHub Copilot CLI",
    aider: "Aider",
    opencode: "opencode",
    "cursor-agent": "Cursor Agent",
    qwen: "Qwen Code",
    amp: "Amp",
    goose: "Goose",
    cn: "Continue CLI",
    sgpt: "ShellGPT",
    llm: "LLM",
    ollama: "Ollama",
    crush: "Crush",
    plandex: "Plandex",
    pdx: "Plandex",
    aichat: "AIChat",
    mods: "Mods",
    tgpt: "tgpt",
    chatgpt: "ChatGPT CLI",
    interpreter: "Open Interpreter",
    droid: "Factory Droid",
    auggie: "Augment Auggie",
    kimi: "Kimi CLI",
    cline: "Cline CLI",
    kilocode: "Kilo Code CLI",
    qchat: "Amazon Q CLI",
    "kiro-cli": "Kiro CLI",
    grok: "Grok CLI",
  },
  subcommands: {
    gh: { copilot: "GitHub Copilot CLI" },
    q: { chat: "Amazon Q CLI" },
  },
  npm: {
    "@anthropic-ai/claude-code": "Claude Code",
    "@openai/codex": "Codex CLI",
    "@google/gemini-cli": "Gemini CLI",
    "@github/copilot": "GitHub Copilot CLI",
    "@githubnext/github-copilot-cli": "GitHub Copilot CLI",
    "opencode-ai": "opencode",
    "@qwen-code/qwen-code": "Qwen Code",
    "@sourcegraph/amp": "Amp",
    "@continuedev/cli": "Continue CLI",
    "@charmland/crush": "Crush",
    "@vibe-kit/grok-cli": "Grok CLI",
    "@augmentcode/auggie": "Augment Auggie",
    "@factory/cli": "Factory Droid",
    "@kilocode/cli": "Kilo Code CLI",
    cline: "Cline CLI",
    "@musistudio/claude-code-router": "Claude Code Router",
  },
  pip: {
    "aider-chat": "Aider",
    "aider-install": "Aider",
    "shell-gpt": "ShellGPT",
    llm: "LLM",
    "open-interpreter": "Open Interpreter",
    "kimi-cli": "Kimi CLI",
  },
  modules: {
    aider: "Aider",
    sgpt: "ShellGPT",
    llm: "LLM",
    interpreter: "Open Interpreter",
  },
  brew: {
    aider: "Aider",
    ollama: "Ollama",
    opencode: "opencode",
    codex: "Codex CLI",
    "gemini-cli": "Gemini CLI",
    "claude-code": "Claude Code",
    "copilot-cli": "GitHub Copilot CLI",
    crush: "Crush",
    llm: "LLM",
    aichat: "AIChat",
    mods: "Mods",
    "block-goose-cli": "Goose",
    goose: "Goose",
    plandex: "Plandex",
    "cursor-cli": "Cursor Agent",
  },
};

export interface AiToolHit {
  tool: string;
  /** "run": the tool itself; "install": a package manager fetching it. */
  kind: "run" | "install";
}

/** "C:\\x\\Claude.CMD" → "claude"; "/usr/bin/python3.12" → "python3.12". */
export function programName(arg: string): string {
  const base = arg.split(/[\\/]/).pop() ?? arg;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/** "@openai/codex@0.1" → "@openai/codex"; "aider-chat[all]==0.8" → "aider-chat"; "npm:x" → "x". */
export function packageName(spec: string): string {
  let s = spec.trim().toLowerCase().replace(/^npm:/, "");
  if (s.startsWith("@")) {
    const at = s.indexOf("@", 1);
    if (at > 0) s = s.slice(0, at);
  } else {
    s = s.split(/[@=<>!~;[\s]/)[0];
  }
  return s;
}

const isInterpreter = (p: string) => p === "node" || p === "nodejs" || p === "bun" || p === "deno" || p === "py" || /^pythonw?(\d+(\.\d+)*)?$/.test(p);
const isFlag = (a: string) => a.startsWith("-");

function lookupPackage(cat: AiToolCatalog, spec: string, maps: ("npm" | "pip" | "brew")[]): string | null {
  const name = packageName(spec);
  for (const m of maps) {
    const hit = cat[m][name] ?? (m === "brew" ? cat.brew[name.split("/").pop() ?? name] : undefined);
    if (hit) return hit;
  }
  return null;
}

function inNodeModules(cat: AiToolCatalog, arg: string): string | null {
  const a = arg.replace(/\\/g, "/").toLowerCase();
  const i = a.lastIndexOf("node_modules/");
  if (i < 0) return null;
  const rest = a.slice(i + "node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : rest[0];
  return cat.npm[name] ?? null;
}

/** The first package argument after `from` that is an AI tool (flags skipped). */
function firstPackage(cat: AiToolCatalog, args: string[], from: number, maps: ("npm" | "pip" | "brew")[], all: boolean): string | null {
  for (let i = from; i < args.length; i++) {
    const a = args[i];
    if (isFlag(a)) {
      // npx --package <pkg> / -p <pkg>
      if ((a === "-p" || a === "--package") && args[i + 1]) {
        const hit = lookupPackage(cat, args[i + 1], maps);
        if (hit) return hit;
        i++;
      } else if (a.startsWith("--package=")) {
        const hit = lookupPackage(cat, a.slice(10), maps);
        if (hit) return hit;
      }
      continue;
    }
    // npx <bin> runs a package by its program name too (npx opencode); installs need the package name.
    const hit = lookupPackage(cat, a, maps) ?? (!all && maps.includes("npm") ? (cat.bins[programName(packageName(a))] ?? null) : null);
    if (hit) return hit;
    if (!all) return null;
  }
  return null;
}

/**
 * Whether one process's argv is an AI tool, or a package manager installing one. Mirrors
 * `match_argv` in src-tauri/src/ai_tools.rs (keep the two in step; both have the same tests).
 */
export function matchAiTool(argv: string[], cat: AiToolCatalog = AI_TOOL_CATALOG): AiToolHit | null {
  if (!argv.length) return null;
  const exe = programName(argv[0]);
  const args = argv.slice(1);
  const run = (tool: string | null | undefined): AiToolHit | null => (tool ? { tool, kind: "run" } : null);
  const install = (tool: string | null | undefined): AiToolHit | null => (tool ? { tool, kind: "install" } : null);

  const direct = run(cat.bins[exe] ?? (args[0] ? cat.subcommands[exe]?.[args[0].toLowerCase()] : undefined));
  if (direct) return direct;
  for (const a of argv) {
    const hit = run(inNodeModules(cat, a));
    if (hit) return hit;
  }
  const sub = (args[0] ?? "").toLowerCase();
  const sub2 = (args[1] ?? "").toLowerCase();

  if (isInterpreter(exe)) {
    const m = args.indexOf("-m");
    if (m >= 0 && args[m + 1]) {
      const mod = args[m + 1].toLowerCase();
      if (mod === "pip" && (args[m + 2] ?? "").toLowerCase() === "install") return install(firstPackage(cat, args, m + 3, ["pip"], true));
      if (mod === "pipx" && /^(install|run)$/.test((args[m + 2] ?? "").toLowerCase())) return install(firstPackage(cat, args, m + 3, ["pip"], false));
      return run(cat.modules[mod]);
    }
    // node /usr/local/bin/claude, python ~/.local/bin/aider
    const script = args.find((a) => !isFlag(a));
    if (script && /[\\/]/.test(script)) return run(cat.bins[programName(script)]);
    return null;
  }
  switch (exe) {
    case "npx":
    case "pnpx":
    case "bunx":
      return run(firstPackage(cat, args, 0, ["npm"], false));
    case "uvx":
      return run(firstPackage(cat, args, 0, ["pip"], false) ?? cat.bins[programName(packageName(args.find((a) => !isFlag(a)) ?? ""))]);
    case "npm":
      if (sub === "exec" || sub === "x") return run(firstPackage(cat, args, 1, ["npm"], false));
      if (/^(install|i|add|in|isntall|update|up)$/.test(sub)) return install(firstPackage(cat, args, 1, ["npm"], true));
      return null;
    case "pnpm":
    case "yarn":
      if (sub === "dlx") return run(firstPackage(cat, args, 1, ["npm"], false));
      if (sub === "global" && sub2 === "add") return install(firstPackage(cat, args, 2, ["npm"], true));
      if (/^(add|install|i)$/.test(sub)) return install(firstPackage(cat, args, 1, ["npm"], true));
      return null;
    case "bun":
      if (sub === "x") return run(firstPackage(cat, args, 1, ["npm"], false));
      if (/^(add|install|i)$/.test(sub)) return install(firstPackage(cat, args, 1, ["npm"], true));
      return null;
    case "pipx":
      if (sub === "run") return run(firstPackage(cat, args, 1, ["pip"], false));
      if (sub === "install") return install(firstPackage(cat, args, 1, ["pip"], true));
      return null;
    case "uv":
      if (sub === "tool" && sub2 === "run") return run(firstPackage(cat, args, 2, ["pip"], false));
      if ((sub === "tool" || sub === "pip") && sub2 === "install") return install(firstPackage(cat, args, 2, ["pip"], true));
      if (sub === "add") return install(firstPackage(cat, args, 1, ["pip"], true));
      return null;
    case "brew":
      if (/^(install|reinstall|upgrade)$/.test(sub)) return install(firstPackage(cat, args, 1, ["brew"], true));
      return null;
    case "gh":
      if ((sub === "extension" || sub === "ext") && sub2 === "install" && args.slice(2).some((a) => /(^|\/)gh-copilot$/i.test(a))) return install("GitHub Copilot CLI");
      return null;
    default:
      if (/^pip\d*(\.\d+)?$/.test(exe) && sub === "install") return install(firstPackage(cat, args, 1, ["pip"], true));
      return null;
  }
}
