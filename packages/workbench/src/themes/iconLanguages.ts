/**
 * The VS Code language id a file has, for icon themes' `languageIds`
 * (Seti keys most of its icons by language: "python", "json", "dockerfile"…).
 * TMCode's Monaco ids mostly match VS Code's; this covers the files VS Code
 * gives a language Monaco doesn't have (`.gitignore` → "ignore", `.env` →
 * "dotenv") and the few ids that differ ("shell" → "shellscript"). Pure.
 */

/** Monaco id → VS Code id where they differ. */
const MONACO_TO_VSCODE: Record<string, string> = {
  shell: "shellscript",
  sh: "shellscript",
  "objective-c": "objective-c",
};

const BY_EXTENSION: Record<string, string> = {
  jsx: "javascriptreact",
  tsx: "typescriptreact",
  gradle: "gradle",
  groovy: "groovy",
  ignore: "ignore",
  env: "dotenv",
  mk: "makefile",
  mak: "makefile",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  jsonc: "jsonc",
  jsonl: "jsonl",
  tf: "terraform",
};

const BY_NAME: Record<string, string> = {
  ".gitignore": "ignore",
  ".gitattributes": "ignore",
  ".dockerignore": "ignore",
  ".npmignore": "ignore",
  ".eslintignore": "ignore",
  ".prettierignore": "ignore",
  ".env": "dotenv",
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "docker-compose.yml": "dockercompose",
  "docker-compose.yaml": "dockercompose",
  "compose.yml": "dockercompose",
  "compose.yaml": "dockercompose",
  ".bashrc": "shellscript",
  ".zshrc": "shellscript",
  ".bash_profile": "shellscript",
  "tsconfig.json": "jsonc",
  "jsconfig.json": "jsonc",
  ".eslintrc.json": "jsonc",
  ".babelrc": "json",
  ".prettierrc": "json",
  commit_editmsg: "git-commit",
};

/** The language VS Code would give `path` (for file icons), from Monaco's guess `monacoId`. */
export function iconLanguageId(path: string, monacoId: string | undefined): string | undefined {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const named = BY_NAME[name];
  if (named) return named;
  // ".env.local", ".env.production": dotenv; "Dockerfile.dev": dockerfile.
  if (name.startsWith(".env.")) return "dotenv";
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (ext && BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  if (!monacoId || monacoId === "plaintext") return monacoId;
  return MONACO_TO_VSCODE[monacoId] ?? monacoId;
}
