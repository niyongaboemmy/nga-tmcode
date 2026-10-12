/** Languages (§13). Wave A is offered now; later waves are data with enabled: false. */
import type { Language } from "../schema";

const L = (key: string, label: string, family: Language["family"], wave: Language["wave"], extensions: string[], monaco_language: string): Language => ({
  key,
  label,
  family,
  wave,
  enabled: wave === "A",
  extensions,
  monaco_language,
});

export const LANGUAGES: Language[] = [
  // wave A
  L("c", "C", "systems", "A", ["c", "h"], "c"),
  L("cpp", "C++", "systems", "A", ["cpp", "cc", "cxx", "hpp", "hh", "h"], "cpp"),
  L("java", "Java", "jvm", "A", ["java"], "java"),
  L("python", "Python", "scripting", "A", ["py"], "python"),
  L("javascript", "JavaScript", "scripting", "A", ["js", "mjs", "cjs", "jsx"], "javascript"),
  L("typescript", "TypeScript", "scripting", "A", ["ts", "mts", "cts", "tsx"], "typescript"),
  L("go", "Go", "systems", "A", ["go"], "go"),
  L("rust", "Rust", "systems", "A", ["rs"], "rust"),
  L("sql", "SQL", "data", "A", ["sql"], "sql"),
  L("web", "HTML, CSS & JavaScript", "web", "A", ["html", "htm", "css", "js", "jsx"], "html"),
  L("logic", "Logic (truth tables)", "other", "A", ["logic"], "plaintext"),
  // wave B
  L("kotlin", "Kotlin", "jvm", "B", ["kt", "kts"], "kotlin"),
  L("php", "PHP", "scripting", "B", ["php"], "php"),
  L("ruby", "Ruby", "scripting", "B", ["rb"], "ruby"),
  L("lua", "Lua", "scripting", "B", ["lua"], "lua"),
  L("bash", "Bash", "scripting", "B", ["sh", "bash"], "shell"),
  L("r", "R", "data", "B", ["r", "R"], "r"),
  // wave C
  L("scala", "Scala", "jvm", "C", ["scala", "sc"], "scala"),
  L("csharp", "C#", "dotnet", "C", ["cs"], "csharp"),
  L("julia", "Julia", "data", "C", ["jl"], "julia"),
  L("haskell", "Haskell", "functional", "C", ["hs"], "haskell"),
  L("elixir", "Elixir", "functional", "C", ["ex", "exs"], "elixir"),
  L("swift", "Swift", "mobile", "C", ["swift"], "swift"),
  L("dart", "Dart & Flutter", "mobile", "C", ["dart"], "dart"),
];
