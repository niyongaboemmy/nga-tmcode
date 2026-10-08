import { profileForPath } from "@tmcode/profiles";
import type { OsKind, Toolchain } from "../platform/types";
import { extname } from "../util/paths";

/**
 * "How to install" help per language, shown in the Run and Debug view when the
 * toolchain a file needs is missing (and on demand from the command palette).
 * Plain data so it is easy to review and test.
 */

export type GuideId = "python" | "node" | "java" | "c" | "cpp" | "go" | "rust" | "csharp" | "dart" | "flutter" | "php" | "ruby" | "swift" | "kotlin";

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
  /** TMCode runs it in a terminal (Run Project, ▶) rather than in the Run panel. */
  terminal?: boolean;
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
  terminal: true,
  debugger: "Run Project runs `go run .`; ▶ runs the file. F5 debugs with Delve: install it once with `go install github.com/go-delve/delve/cmd/dlv@latest`.",
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
  terminal: true,
  debugger: "Run Project runs `cargo run`; ▶ compiles and runs a single file. F5 debugs with LLDB (the C/C++ debugger).",
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
  terminal: true,
  debugger: "Run Project runs `dotnet run` (web projects: `dotnet watch run`). Debugging C# isn't built in yet.",
};


const guide = (g: Omit<InstallGuide, "tools" | "terminal">): InstallGuide => ({ ...g, tools: [], terminal: true });

const DART = guide({
  id: "dart",
  language: "Dart",
  icon: "symbol-method",
  summary: "the Dart SDK (or Flutter, which includes it)",
  steps: {
    windows: [{ text: "Install Dart with winget, or install Flutter (which includes Dart):", command: "winget install -e --id Google.DartSDK" }],
    mac: [{ text: "Install Dart with Homebrew:", command: "brew tap dart-lang/dart && brew install dart" }],
    linux: [{ text: "Follow the apt instructions on dart.dev, or install Flutter (which includes Dart)." }],
  },
  verify: "dart --version",
  url: "https://dart.dev/get-dart",
  debugger: "F5 debugs Dart with the SDK's own debugger (dart debug_adapter); nothing else to install.",
});

const FLUTTER = guide({
  id: "flutter",
  language: "Flutter",
  icon: "device-mobile",
  summary: "the Flutter SDK",
  steps: {
    windows: [
      { text: "Install Flutter with winget:", command: "winget install -e --id Google.Flutter" },
      { text: "Then check what else is needed (Android Studio, Visual Studio for desktop apps):", command: "flutter doctor" },
    ],
    mac: [
      { text: "Install Flutter with Homebrew:", command: "brew install --cask flutter" },
      { text: "Then check what else is needed (Xcode for iOS/macOS, Android Studio for Android):", command: "flutter doctor" },
    ],
    linux: [
      { text: "Install Flutter with snap:", command: "sudo snap install flutter --classic" },
      { text: "Then check what else is needed:", command: "flutter doctor" },
    ],
  },
  verify: "flutter --version",
  url: "https://docs.flutter.dev/get-started/install",
  debugger: "Run Project serves the web app in the built-in browser (hot reload: press r in its terminal). F5 debugs with Flutter's own debugger.",
});

const PHP = guide({
  id: "php",
  language: "PHP",
  icon: "server",
  summary: "PHP 8 (and Composer for Laravel)",
  steps: {
    windows: [
      { text: "Install PHP and Composer with winget:", command: "winget install -e --id PHP.PHP.8.3" },
      { text: "Then Composer:", command: "winget install -e --id Composer.Composer" },
    ],
    mac: [{ text: "Install PHP and Composer with Homebrew:", command: "brew install php composer" }],
    linux: [{ text: "Install PHP and Composer:", command: "sudo apt install php-cli php-mbstring php-xml php-sqlite3 composer" }],
  },
  verify: "php --version",
  url: "https://www.php.net/downloads",
  debugger: "Run Project starts PHP's built-in server (Laravel: artisan serve); ▶ runs a .php file in a terminal.",
});

const RUBY = guide({
  id: "ruby",
  language: "Ruby",
  icon: "ruby",
  summary: "Ruby 3 (and Bundler)",
  steps: {
    windows: [{ text: "Install Ruby with the RubyInstaller (with DevKit):", command: "winget install -e --id RubyInstallerTeam.RubyWithDevKit.3.3" }],
    mac: [{ text: "Install a current Ruby with Homebrew:", command: "brew install ruby" }],
    linux: [{ text: "Install Ruby:", command: "sudo apt install ruby-full" }],
  },
  verify: "ruby --version",
  url: "https://www.ruby-lang.org/en/documentation/installation/",
  debugger: "Run Project starts Rails or Sinatra servers; ▶ runs a .rb file in a terminal; Run Task… has irb.",
});

const SWIFT = guide({
  id: "swift",
  language: "Swift",
  icon: "symbol-method",
  summary: "the Swift toolchain",
  steps: {
    windows: [{ text: "Install Swift with winget:", command: "winget install -e --id Swift.Toolchain" }],
    mac: [{ text: "Install the Xcode Command Line Tools (they include Swift):", command: "xcode-select --install" }],
    linux: [{ text: "Download the toolchain for your distribution from swift.org." }],
  },
  verify: "swift --version",
  url: "https://www.swift.org/install/",
  debugger: "Run Project runs `swift run`; ▶ runs a .swift file.",
});

const KOTLIN = guide({
  id: "kotlin",
  language: "Kotlin",
  icon: "symbol-method",
  summary: "the Kotlin compiler (and a JDK)",
  steps: {
    windows: [{ text: "Install Kotlin with Scoop (or use Gradle/IntelliJ projects):", command: "scoop install kotlin" }],
    mac: [{ text: "Install Kotlin with Homebrew:", command: "brew install kotlin" }],
    linux: [{ text: "Install Kotlin with SDKMAN:", command: "sdk install kotlin" }],
  },
  verify: "kotlinc -version",
  url: "https://kotlinlang.org/docs/command-line.html",
  debugger: "▶ compiles a .kt file with kotlinc and runs it; Gradle projects run with Run Project.",
});

export const GUIDES: InstallGuide[] = [PYTHON, NODE, JAVA, C, CPP, GO, RUST, CSHARP, DART, FLUTTER, PHP, RUBY, SWIFT, KOTLIN];

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
  dart: "dart",
  php: "php",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
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
