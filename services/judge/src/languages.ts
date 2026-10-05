/**
 * Languages tm-judge can run, keyed by TMCode profile id (packages/profiles).
 * Commands run inside the sandbox with the submission in the working folder;
 * programs are resolved to absolute host paths at startup.
 */
export interface Language {
  id: string;
  /** Host programs this language needs (resolved on PATH at startup). */
  programs: string[];
  /** How to print a version line, for /v1/health. */
  version: string[];
  compile?: (ctx: Ctx) => string[];
  run: (ctx: Ctx) => string[];
  /** Overrides of the default sandbox limits. */
  processes?: number;
  memoryMb?: number;
  env?: Record<string, string>;
  /** TypeScript: transpiled to JavaScript by the judge (esbuild, outside the box) before running. */
  transpile?: "typescript";
}

export interface Ctx {
  entry: string;
  entryStem: string;
  /** Submission files with this extension (for compilers). */
  sources: (ext: string) => string[];
  bin: (program: string) => string;
}

export const LANGUAGES: Language[] = [
  {
    id: "python-3",
    programs: ["python3"],
    version: ["python3", "--version"],
    run: (c) => [c.bin("python3"), "-u", c.entry],
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
  },
  {
    id: "node-22",
    programs: ["node"],
    version: ["node", "--version"],
    run: (c) => [c.bin("node"), c.entry],
    processes: 32, // libuv thread pool
  },
  {
    id: "typescript",
    programs: ["node"],
    version: ["node", "--version"],
    transpile: "typescript",
    // Runs the transpiled entry (main.ts → main.js); works on Node builds without type stripping.
    run: (c) => [c.bin("node"), c.entry.replace(/\.(c|m)?ts$/, ".$1js")],
    processes: 32,
  },
  {
    id: "c17",
    programs: ["gcc"],
    version: ["gcc", "--version"],
    compile: (c) => [c.bin("gcc"), "-std=c17", "-O2", "-Wall", ...c.sources("c"), "-o", "main", "-lm"],
    run: () => ["./main"],
  },
  {
    id: "cpp17",
    programs: ["g++"],
    version: ["g++", "--version"],
    compile: (c) => [c.bin("g++"), "-std=c++17", "-O2", "-Wall", ...c.sources("cpp"), "-o", "main"],
    run: () => ["./main"],
  },
  {
    id: "java-21",
    programs: ["javac", "java"],
    version: ["java", "-version"],
    compile: (c) => [c.bin("javac"), "-d", ".", "-encoding", "UTF-8", ...c.sources("java")],
    run: (c) => [c.bin("java"), "-Xmx256m", "-Xss64m", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-cp", ".", c.entryStem],
    // The JVM needs threads and headroom above its heap.
    processes: 64,
    memoryMb: 512,
  },
];

export function languageById(id: string) {
  return LANGUAGES.find((l) => l.id === id);
}
