/** Languages (§13). Wave A is offered now; later waves are data with enabled: false. */
import type { Language } from "../schema";

const L = (key: string, label: string, family: Language["family"], wave: Language["wave"], extensions: string[], monaco_language: string): Language => ({
  key,
  label,
  family,
  wave,
  enabled: wave === "A" || OFFERED_LATER.has(key),
  extensions,
  monaco_language,
});

/**
 * Later-wave languages offered now: the runner installs them (services/judge/deploy/
 * install-languages.sh) and runs their single-file kinds on the isolate tier.
 */
const OFFERED_LATER = new Set(["php", "ruby", "bash", "kotlin", "csharp", "swift", "arduino"]);

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
  // Sketches for the Arduino Uno: compiled on the runner, simulated in the browser (avr8js) or flashed to a board.
  L("arduino", "Arduino", "systems", "B", ["ino"], "cpp"),
  L("dart", "Dart & Flutter", "mobile", "C", ["dart"], "dart"),
  // wave D (phase 7, the long tail; Monaco ids fall back to the language name where Monaco has none, as for Haskell)
  L("zig", "Zig", "systems", "D", ["zig"], "zig"),
  L("nim", "Nim", "systems", "D", ["nim", "nims"], "nim"),
  L("fortran", "Fortran", "systems", "D", ["f90", "f95", "f03", "f08", "f", "for"], "fortran"),
  L("pascal", "Pascal", "systems", "D", ["pas", "pp", "lpr"], "pascal"),
  L("cobol", "COBOL", "systems", "D", ["cob", "cbl", "cobol"], "cobol"),
  L("asm", "Assembly (x86-64, NASM)", "systems", "D", ["asm", "nasm"], "asm"),
  L("d", "D", "systems", "D", ["d"], "d"),
  L("crystal", "Crystal", "systems", "D", ["cr"], "crystal"),
  L("v", "V", "systems", "D", ["v"], "v"),
  L("ada", "Ada", "systems", "D", ["adb", "ads"], "ada"),
  L("objc", "Objective-C", "systems", "D", ["m"], "objective-c"),
  L("groovy", "Groovy", "jvm", "D", ["groovy", "gvy"], "groovy"),
  L("clojure", "Clojure", "jvm", "D", ["clj", "cljc", "bb"], "clojure"),
  L("fsharp", "F#", "dotnet", "D", ["fs", "fsx"], "fsharp"),
  L("vb", "Visual Basic .NET", "dotnet", "D", ["vb"], "vb"),
  L("pwsh", "PowerShell", "scripting", "D", ["ps1"], "powershell"),
  L("perl", "Perl", "scripting", "D", ["pl", "pm", "t"], "perl"),
  L("tcl", "Tcl", "scripting", "D", ["tcl"], "tcl"),
  L("octave", "GNU Octave", "data", "D", ["m"], "octave"),
  L("ocaml", "OCaml", "functional", "D", ["ml", "mli"], "ocaml"),
  L("erlang", "Erlang", "functional", "D", ["erl", "escript"], "erlang"),
  L("gleam", "Gleam", "functional", "D", ["gleam"], "gleam"),
  L("racket", "Racket", "functional", "D", ["rkt"], "scheme"),
  L("scheme", "Scheme (Guile)", "functional", "D", ["scm", "ss"], "scheme"),
  L("lisp", "Common Lisp", "functional", "D", ["lisp", "lsp", "cl"], "scheme"),
  L("prolog", "Prolog", "functional", "D", ["pl", "pro"], "prolog"),
  L("verilog", "Verilog", "other", "D", ["v", "sv"], "systemverilog"),
  L("vhdl", "VHDL", "other", "D", ["vhd", "vhdl"], "vhdl"),
];
