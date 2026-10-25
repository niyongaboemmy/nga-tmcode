/**
 * Which extensions are AI tools, so whatever they do (an edit, a file write, a terminal command,
 * a suggestion accepted) is recorded as AI use and named. Known AI extensions by id, then the
 * marketplace category ("AI", "Chat") and the words their listing uses.
 */

const KNOWN: Record<string, string> = {
  "anthropic.claude-code": "Claude Code",
  "google.geminicodeassist": "Gemini Code Assist",
  "google.gemini-cli-vscode-ide-companion": "Gemini CLI",
  "blackboxapp.blackboxagent": "Blackbox AI",
  "blackboxapp.blackbox": "Blackbox AI",
  "codeium.codeium": "Windsurf (Codeium)",
  "continue.continue": "Continue",
  "saoudrizwan.claude-dev": "Cline",
  "rooveterinaryinc.roo-cline": "Roo Code",
  "kilocode.kilo-code": "Kilo Code",
  "tabnine.tabnine-vscode": "Tabnine",
  "sourcegraph.cody-ai": "Cody",
  "github.copilot": "GitHub Copilot",
  "github.copilot-chat": "GitHub Copilot Chat",
  "amazonwebservices.amazon-q-vscode": "Amazon Q",
  "qodo.qodo-gen": "Qodo",
  "codium.codium": "Qodo",
  "robertpiosik.gemini-coder": "Code Web Chat",
  "openai.chatgpt": "Codex (ChatGPT)",
};

const WORDS = /\b(ai|a\.i\.|copilot|gpt|llm|chatgpt|openai|claude|gemini|anthropic|code assist(ant)?|coding agent|ai agent|autocomplete with ai|deepseek|ollama|mistral|codex)\b/i;

interface ManifestLike {
  displayName?: string;
  description?: string;
  categories?: string[];
}

export function isAiExtension(id: string, m?: ManifestLike | null): boolean {
  if (KNOWN[id.toLowerCase()]) return true;
  if (!m) return false;
  if ((m.categories ?? []).some((c) => /^(ai|chat)$/i.test(c))) return true;
  return WORDS.test(`${m.displayName ?? ""} ${m.description ?? ""}`);
}

/** The name people know an AI extension by. */
export function aiExtensionName(id: string, m?: ManifestLike | null): string {
  return KNOWN[id.toLowerCase()] ?? m?.displayName ?? id;
}
