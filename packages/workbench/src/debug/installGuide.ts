import { profileForPath } from "@tmcode/profiles";
import type { OsKind, Toolchain } from "../platform/types";
import { extname } from "../util/paths";

/**
 * "How to install" help per language, shown in the Run and Debug view when the
 * toolchain a file needs is missing (and on demand from the command palette).
 * Plain data so it is easy to review and test.
 */

export type GuideId = "python" | "node" | "java" | "c" | "cpp" | "go" | "rust" | "csharp";

export interface InstallStep {
  text: string;
  /** A command to copy into a terminal. */
  command?: string;
}

export interface InstallGuide {
  id: GuideId;
  /** "Python", "C/C++"… */
  language: string;
  /** Codicon for the card header. */
  icon: string;
  /** What gets installed, in one line. */
  summary: string;
  /** Tools (as the runner names them) that make it work; empty = TMCode can't run it yet. */
  tools: string[];
  steps: Record<OsKind, InstallStep[]>;
  /** How to check it worked. */
  verify: string;
  url: string;
  /** Debugger notes (debugpy, js-debug…), shown under the steps. */
  debugger?: string;
}

const PYTHON: InstallGuide = {
  id: "python",
  language: "Python",
  icon: "symbol-namespace",
  summary: "Python 3.10 or newer",
  tools: ["python"],
  steps: {
    windows: [
      { text: "Install Python 3 from the Microsoft Store, or with winget:", command: "winget install -e --id Python.Python.3.12" },
      { text: "With the python.org installer, tick “Add python.exe to PATH”." },
    ],
    mac: [
      { text: "Install Python 3 with Homebrew:", command: "brew install python" },
      { text: "Or download the macOS installer from python.org." },
    ],
    linux: [{ text: "Install Python 3 with your package manager:", command: "sudo apt install python3 python3-pip" }],
  },
  verify: "python3 --version",
  url: "https://www.python.org/downloads/",
  debugger: "Debugging also needs the debugpy package; TMCode offers to install it (pip install --user debugpy) the first time you press F5.",
};

const NODE: InstallGuide = {
  id: "node",
  language: "JavaScript / TypeScript",
  icon: "symbol-event",
  summary: "Node.js 22 LTS (runs .js, and .ts by stripping types)",
  tools: ["node"],
  steps: {
    windows: [{ text: "Install Node.js LTS with winget, or the installer from nodejs.org:", command: "winget install -e --id OpenJS.NodeJS.LTS" }],
    mac: [{ text: "Install Node.js with Homebrew, or the installer from nodejs.org:", command: "brew install node" }],
    linux: [{ text: "Install Node.js 22 from NodeSource or your package manager:", command: "sudo apt install nodejs" }],
  },
  verify: "node --version",
  url: "https://nodejs.org/en/download",
  debugger: "Debugging uses Microsoft's js-debug, which TMCode downloads once (about 1.2 MB) the first time you press F5.",
};

const JAVA: InstallGuide = {
  id: "java",
  language: "Java",
  icon: "coffee",
  summary: "A Java JDK, version 17 or newer (javac and java)",
  tools: ["javac", "java"],
  steps: {
    windows: [{ text: "Install the Eclipse Temurin JDK:", command: "winget install -e --id EclipseAdoptium.Temurin.21.JDK" }],
    mac: [{ text: "Install the Temurin JDK with Homebrew:", command: "brew install --cask temurin" }],
    linux: [{ text: "Install OpenJDK:", command: "sudo apt install openjdk-21-jdk" }],
  },
  verify: "javac -version",
  url: "https://adoptium.net/",
  debugger: "Java runs with Run Without Debugging (Ctrl+F5); stepping through Java is not available yet.",
};

const nativeSteps: Record<OsKind, InstallStep[]> = {
  windows: [
    { text: "Install LLVM (clang and lldb-dap):", command: "winget install -e --id LLVM.LLVM" },
    { text: "Or install MSYS2 and its GCC (pacman -S mingw-w64-ucrt-x86_64-gcc), then add it to PATH." },
  ],
  mac: [{ text: "Install the Xcode Command Line Tools (clang, clang++ and lldb-dap):", command: "xcode-select --install" }],
  linux: [{ text: "Install the compilers and a debugger:", command: "sudo apt install build-essential lldb" }],
};

const C: InstallGuide = {
  id: "c",
  language: "C",
  icon: "symbol-structure",
  summary: "A C compiler (clang or gcc) and lldb-dap or GDB 14+",
  tools: ["cc"],
  steps: nativeSteps,
  verify: "cc --version",
  url: "https://code.visualstudio.com/docs/languages/cpp",
  debugger: "TMCode builds with -g -O0 for debugging and uses lldb-dap (or GDB 14 or newer).",
};

const CPP: InstallGuide = { ...C, id: "cpp", language: "C++", summary: "A C++ compiler (clang++ or g++) and lldb-dap or GDB 14+", tools: ["cxx"], verify: "c++ --version" };

const GO: InstallGuide = {
  id: "go",
  language: "Go",
  icon: "symbol-interface",
  summary: "The Go toolchain",
  tools: [],
  steps: {
    windows: [{ text: "Install Go:", command: "winget install -e --id GoLang.Go" }],
    mac: [{ text: "Install Go with Homebrew:", command: "brew install go" }],
    linux: [{ text: "Install Go:", command: "sudo apt install golang-go" }],
  },
  verify: "go version",
  url: "https://go.dev/doc/install",
  debugger: "TMCode can edit Go files, but running and debugging Go is not built in yet: use the terminal (go run .).",
};

const RUST: InstallGuide = {
  id: "rust",
  language: "Rust",
  icon: "symbol-misc",
  summary: "rustup, cargo and rustc",
  tools: [],
  steps: {
    windows: [{ text: "Install rustup:", command: "winget install -e --id Rustlang.Rustup" }],
    mac: [{ text: "Install rustup:", command: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" }],
    linux: [{ text: "Install rustup:", command: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" }],
  },
  verify: "cargo --version",
  url: "https://www.rust-lang.org/tools/install",
  debugger: "TMCode can edit Rust files, but running and debugging Rust is not built in yet: use the terminal (cargo run).",
};

const CSHARP: InstallGuide = {
  id: "csharp",
  language: "C#",
  icon: "symbol-class",
  summary: "The .NET SDK",
  tools: [],
  steps: {
    windows: [{ text: "Install the .NET SDK:", command: "winget install -e --id Microsoft.DotNet.SDK.8" }],
    mac: [{ text: "Install the .NET SDK with Homebrew:", command: "brew install --cask dotnet-sdk" }],
    linux: [{ text: "Install the .NET SDK:", command: "sudo apt install dotnet-sdk-8.0" }],
  },
  verify: "dotnet --version",
  url: "https://dotnet.microsoft.com/download",
  debugger: "TMCode can edit C# files, but running and debugging C# is not built in yet: use the terminal (dotnet run).",
};

export const GUIDES: InstallGuide[] = [PYTHON, NODE, JAVA, C, CPP, GO, RUST, CSHARP];

const BY_EXT: Record<string, GuideId> = {
  py: "python",
  js: "node",
  mjs: "node",
  cjs: "node",
  ts: "node",
  mts: "node",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  go: "go",
  rs: "rust",
  cs: "csharp",
};

export function guideById(id: GuideId): InstallGuide {
  return GUIDES.find((g) => g.id === id)!;
}

export function guideForPath(path: string | null): InstallGuide | null {
  if (!path) return null;
  const id = BY_EXT[extname(path).toLowerCase()];
  return id ? guideById(id) : null;
}

/** Tools the file's language profile needs to build and run ("exe" is the built program, not a tool). */
export function toolsForPath(path: string): string[] {
  const local = profileForPath(path)?.local;
  if (!local) return [];
  return [...new Set([...local.build, local.run].map((s) => s.tool).filter((t) => t !== "exe"))];
}

/**
 * The guide to show for `path` given the detected toolchains: a language TMCode
 * runs whose tools are missing, or a language it can't run at all.
 */
export function missingToolchain(path: string | null, detected: Toolchain[] | null): { guide: InstallGuide; missing: string[] } | null {
  const guide = guideForPath(path);
  if (!guide || !path || !detected) return null;
  if (!guide.tools.length) return { guide, missing: [] };
  const have = new Set(detected.map((t) => t.tool));
  const missing = toolsForPath(path).filter((t) => !have.has(t));
  return missing.length ? { guide, missing } : null;
}
