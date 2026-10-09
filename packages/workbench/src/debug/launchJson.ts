import type { Profile } from "@tmcode/protocol";
import type { DebugAdapterKind } from "../platform/types";
import { basename, dirname, extname } from "../util/paths";

/** `.vscode/launch.json`, VS Code's format. */
export const LAUNCH_FILE = ".vscode/launch.json";

export interface LaunchConfig {
  type: string;
  request: "launch" | "attach";
  name: string;
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  console?: "internalConsole" | "integratedTerminal" | "externalTerminal";
  [key: string]: unknown;
}

/** Strips // and /* *\/ comments and trailing commas (JSON with Comments, as VS Code reads it). */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas before } or ] (outside strings: strings were copied verbatim, so re-scan carefully).
  let result = "";
  inString = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (inString) {
      result += c;
      if (c === "\\") result += out[++j] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === "}" || out[k] === "]") continue;
    }
    result += c;
  }
  return result;
}

export function parseLaunchJson(text: string): { configurations: LaunchConfig[]; error: string | null } {
  if (!text.trim()) return { configurations: [], error: null };
  try {
    const json = JSON.parse(stripJsonc(text)) as { configurations?: unknown };
    const list = Array.isArray(json.configurations) ? json.configurations : [];
    const configurations = list.filter((c): c is LaunchConfig => !!c && typeof c === "object" && typeof (c as LaunchConfig).type === "string" && typeof (c as LaunchConfig).name === "string");
    return { configurations, error: null };
  } catch (e) {
    return { configurations: [], error: `launch.json: ${String((e as Error).message)}` };
  }
}

/** Which TMCode adapter serves a launch.json `type`. */
export function adapterKindFor(type: string): DebugAdapterKind | null {
  switch (type) {
    case "python":
    case "debugpy":
      return "python";
    case "node":
    case "pwa-node":
    case "node-terminal":
      return "node";
    case "cppdbg":
    case "lldb":
    case "lldb-dap":
    case "cppvsdbg":
    case "gdb":
      return "native";
    case "java":
      return "java";
    case "go":
      return "go";
    case "dart":
      return "dart";
    case "flutter":
      return "flutter";
    case "rdbg":
    case "ruby":
      return "ruby";
    case "swift":
      return "native";
    case "coreclr":
    case "netcoredbg":
      return "dotnet";
    case "php":
      return "php";
    case "kotlin":
      return "java";
    default:
      return null;
  }
}

/** Languages whose debugger builds and runs the program itself (no TMCode profile): Go (Delve), Dart and Flutter. */
export function selfHostedKindForPath(path: string): DebugAdapterKind | null {
  const ext = extname(path);
  if (ext === "go") return "go";
  if (ext === "dart") return "dart";
  if (ext === "rb") return "ruby";
  if (ext === "swift") return "native";
  if (ext === "cs" || ext === "fs") return "dotnet";
  if (ext === "php") return "php";
  if (ext === "kt") return "java";
  return null;
}

/** VS Code PHP Debug's "Launch currently open script" (Xdebug 3 connects back on a free port). */
const PHP_SCRIPT: LaunchConfig = {
  type: "php",
  request: "launch",
  name: "PHP: Launch current script",
  program: "${file}",
  cwd: "${fileDirname}",
  port: 0,
  runtimeArgs: ["-dxdebug.start_with_request=yes"],
  env: { XDEBUG_MODE: "debug,develop", XDEBUG_CONFIG: "client_port=${port}" },
};

/** The automatic configuration for those files (VS Code's Go and Dart extensions use the same shape). */
export function selfHostedConfig(file: string): LaunchConfig | null {
  const kind = selfHostedKindForPath(file);
  if (kind === "go") return { type: "go", request: "launch", name: "Go: Launch Package", mode: "debug", program: "${fileDirname}" };
  if (kind === "dart") return { type: "dart", request: "launch", name: `Dart: ${basename(file)}`, program: "${file}" };
  if (extname(file) === "swift") return { type: "swift", request: "launch", name: "Swift: Debug Package", cwd: "${workspaceFolder}", args: [] };
  if (kind === "php") return PHP_SCRIPT;
  if (extname(file) === "kt") return { type: "kotlin", request: "launch", name: "Kotlin: Current File", program: "${file}" };
  if (kind === "dotnet") return { type: "coreclr", request: "launch", name: "C#: Debug Project", args: [] };
  if (kind === "ruby") return { type: "rdbg", request: "launch", name: "Ruby: Debug current file", script: "${file}", args: [] };
  return null;
}

/** Debug adapter for a language profile (null = this profile can't be debugged). */
export function adapterKindForProfile(profileId: string): DebugAdapterKind | null {
  if (profileId.startsWith("python")) return "python";
  if (profileId.startsWith("node") || profileId === "typescript") return "node";
  if (profileId.startsWith("c17") || profileId.startsWith("cpp")) return "native";
  if (profileId.startsWith("java")) return "java";
  return null;
}

export function languageNoun(kind: DebugAdapterKind, ext = ""): string {
  if (kind === "python") return "Python";
  if (kind === "node") return ext === "ts" || ext === "mts" ? "TypeScript" : "JavaScript";
  if (kind === "native") return ext === "c" || ext === "h" ? "C" : "C++";
  if (kind === "go") return "Go";
  if (kind === "dart") return "Dart";
  if (kind === "flutter") return "Flutter";
  if (kind === "ruby") return "Ruby";
  if (kind === "dotnet") return "C#";
  if (kind === "php") return "PHP";
  return "Java";
}

/** VS Code's "automatic" configuration for the active file. */
export function automaticConfig(profile: Profile, file: string): LaunchConfig | null {
  const kind = adapterKindForProfile(profile.id);
  if (!kind || !profile.local) return null;
  if (kind === "python") return { type: "debugpy", request: "launch", name: "Python Debugger: Current File", program: "${file}", console: "integratedTerminal" };
  if (kind === "node") return { type: "node", request: "launch", name: `Node.js: ${basename(file)}`, program: "${file}", console: "integratedTerminal" };
  if (kind === "native") return { type: "lldb", request: "launch", name: `${extname(file) === "c" ? "C" : "C++"}: Debug Active File`, program: "${file}" };
  return { type: "java", request: "launch", name: "Java: Current File", program: "${file}", console: "integratedTerminal" };
}

export interface ConfigTemplate {
  label: string;
  description: string;
  config: LaunchConfig;
}

/** "Add Configuration…" snippets (VS Code wording). */
export const TEMPLATES: ConfigTemplate[] = [
  {
    label: "Python Debugger: Python File",
    description: "Debug the currently active Python file",
    config: { name: "Python Debugger: Current File", type: "debugpy", request: "launch", program: "${file}", console: "integratedTerminal" },
  },
  {
    label: "Python Debugger: Python File with Arguments",
    description: "Debug the currently active Python file with arguments",
    config: { name: "Python Debugger: Current File with Arguments", type: "debugpy", request: "launch", program: "${file}", console: "integratedTerminal", args: ["${command:pickArgs}"] },
  },
  {
    label: "Node.js: Launch Program",
    description: "Debug a Node.js program",
    config: { type: "node", request: "launch", name: "Launch Program", skipFiles: ["<node_internals>/**"], program: "${workspaceFolder}/main.js" },
  },
  {
    label: "Node.js: Launch Current File",
    description: "Debug the currently active JavaScript or TypeScript file",
    config: { type: "node", request: "launch", name: "Launch Current File", skipFiles: ["<node_internals>/**"], program: "${file}", console: "integratedTerminal" },
  },
  {
    label: "C/C++: (lldb) Launch",
    description: "Build and debug the active C or C++ file with lldb-dap",
    config: { name: "(lldb) Launch", type: "lldb", request: "launch", program: "${file}", args: [], cwd: "${fileDirname}", stopOnEntry: false },
  },
  {
    label: "Ruby: Debug current file",
    description: "Debug the active Ruby file with rdbg (Ruby 3.1+)",
    config: { name: "Ruby: Debug current file", type: "rdbg", request: "launch", script: "${file}", args: [] },
  },
  {
    label: "Swift: Debug Package",
    description: "swift build, then debug the package's executable with lldb-dap",
    config: { name: "Swift: Debug Package", type: "swift", request: "launch", cwd: "${workspaceFolder}", args: [] },
  },
  {
    label: "C#: Debug Project",
    description: "dotnet build the project of the active file, then debug it with netcoredbg",
    config: { name: "C#: Debug Project", type: "coreclr", request: "launch", args: [] },
  },
  {
    label: "PHP: Launch current script",
    description: "Debug the active PHP file with Xdebug",
    config: { ...PHP_SCRIPT },
  },
  {
    label: "PHP: Listen for Xdebug",
    description: "Laravel / web requests: Xdebug connects to port 9003 (xdebug.start_with_request=yes)",
    config: { name: "PHP: Listen for Xdebug", type: "php", request: "launch", port: 9003 },
  },
  {
    label: "Kotlin: Current File",
    description: "Compile the active .kt file with kotlinc and debug it (TMCode's Java debugger)",
    config: { name: "Kotlin: Current File", type: "kotlin", request: "launch", program: "${file}" },
  },
  {
    label: "Java: Current File",
    description: "Compile the active Java file with javac -g and debug it",
    config: { name: "Java: Current File", type: "java", request: "launch", program: "${file}", console: "integratedTerminal" },
  },
  {
    label: "Java: Attach to JVM (port 5005)",
    description: "Spring Boot / Maven: start with -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005",
    config: { name: "Java: Attach (5005)", type: "java", request: "attach", hostName: "127.0.0.1", port: 5005 },
  },
  {
    label: "Go: Launch Package",
    description: "Debug the Go package of the active file with Delve",
    config: { name: "Go: Launch Package", type: "go", request: "launch", mode: "debug", program: "${fileDirname}" },
  },
  {
    label: "Dart: Launch Current File",
    description: "Debug the active Dart file",
    config: { name: "Dart: Current File", type: "dart", request: "launch", program: "${file}" },
  },
  {
    label: "Flutter: Launch",
    description: "Debug the Flutter app (lib/main.dart) with hot reload",
    config: { name: "Flutter", type: "dart", request: "launch", program: "lib/main.dart" },
  },
  {
    label: "C/C++: (gdb) Launch",
    description: "Build and debug the active C or C++ file with GDB 14+",
    config: { name: "(gdb) Launch", type: "cppdbg", MIMode: "gdb", request: "launch", program: "${file}", args: [], cwd: "${fileDirname}", stopOnEntry: false },
  },
];

export function newLaunchJson(configs: LaunchConfig[]): string {
  const body = configs.map((c) => indent(JSON.stringify(c, null, 4), 8)).join(",\n");
  return `{\n    // Use IntelliSense to learn about possible attributes.\n    // Hover to view descriptions of existing attributes.\n    // For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387\n    "version": "0.2.0",\n    "configurations": [\n${body}\n    ]\n}\n`;
}

function indent(text: string, n: number) {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

/** Inserts a configuration at the top of `configurations`, keeping the rest of the file (and its comments) as written. */
export function addConfiguration(text: string, config: LaunchConfig): string {
  if (!text.trim()) return newLaunchJson([config]);
  const m = /"configurations"\s*:\s*\[/.exec(text);
  if (!m) return newLaunchJson([...parseLaunchJson(text).configurations, config]);
  const at = m.index + m[0].length;
  const rest = text.slice(at);
  const empty = /^\s*\]/.test(rest);
  return `${text.slice(0, at)}\n${indent(JSON.stringify(config, null, 4), 8)}${empty ? "\n    " : ","}${rest}`;
}

export interface SubstitutionContext {
  /** Workspace root as a path (absolute on the desktop). */
  root: string;
  /** Workspace-relative path of the active file. */
  file: string | null;
  line?: number;
  args?: string[];
}

/** Replaces ${workspaceFolder}, ${file}, … in every string of a configuration. */
export function substitute<T>(value: T, ctx: SubstitutionContext): T {
  const join = (rel: string) => (rel ? `${ctx.root.replace(/[\\/]$/, "")}/${rel}` : ctx.root);
  const file = ctx.file;
  const vars: Record<string, () => string> = {
    workspaceFolder: () => ctx.root,
    workspaceRoot: () => ctx.root,
    workspaceFolderBasename: () => basename(ctx.root),
    cwd: () => ctx.root,
    file: () => (file ? join(file) : ""),
    relativeFile: () => file ?? "",
    relativeFileDirname: () => (file ? dirname(file) : ""),
    fileBasename: () => (file ? basename(file) : ""),
    fileBasenameNoExtension: () => (file ? basename(file).replace(/\.[^.]*$/, "") : ""),
    fileDirname: () => (file ? join(dirname(file)) : ctx.root),
    fileExtname: () => (file && extname(file) ? `.${extname(file)}` : ""),
    lineNumber: () => String(ctx.line ?? 1),
    pathSeparator: () => "/",
    "/": () => "/",
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(/\$\{([^}]+)\}/g, (all, name: string) => (vars[name] ? vars[name]() : name.startsWith("env:") ? "" : all));
    if (Array.isArray(v)) {
      // "${command:pickArgs}" expands to the chosen arguments, in place.
      return v.flatMap((x) => (x === "${command:pickArgs}" ? (ctx.args ?? []) : [walk(x)]));
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Maps an adapter path back to a workspace-relative one (null when it is outside the folder). */
export function toWorkspacePath(abs: string, root: string, caseInsensitive = false): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  let a = norm(abs);
  let r = norm(root);
  // macOS reports /private/var/... for /var/... (and /private/tmp for /tmp).
  const unprivate = (p: string) => p.replace(/^\/private(\/(?:var|tmp|etc)\/)/, "$1");
  a = unprivate(a);
  r = unprivate(r);
  const cmp = (x: string) => (caseInsensitive ? x.toLowerCase() : x);
  if (cmp(a) === cmp(r)) return "";
  if (!cmp(a).startsWith(`${cmp(r)}/`)) return null;
  return a.slice(r.length + 1);
}
