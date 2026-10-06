import { ProfileSchema, type Limits, type Profile } from "@tmcode/protocol";

/**
 * Built-in language profiles (plan §7.2). In practice mode TMCode uses these;
 * in an exam the package from Task Mentor carries the authoritative copies.
 */

const LIMITS: Limits = { cpu_s: 5, wall_s: 10, memory_mb: 256, output_kb: 256 };
const COMPILED: Limits = { cpu_s: 5, wall_s: 15, memory_mb: 256, output_kb: 256 };

const raw: Profile[] = [
  {
    id: "python-3",
    version: 1,
    label: "Python 3",
    monaco_language: "python",
    extensions: ["py"],
    entry_point: "main.py",
    template: [{ path: "main.py", content: 'name = input("What is your name? ")\nprint(f"Hello, {name}!")\n' }],
    local: { build: [], run: { tool: "python", args: ["-u", "{entry}"] }, fallback: "pyodide" },
    judge: { engine: "piston", language: "python", version: "3.12.*" },
    preview: null,
    test_kinds: ["io", "unit-pytest"],
    limits: LIMITS,
  },
  {
    id: "node-22",
    version: 1,
    label: "JavaScript (Node.js)",
    monaco_language: "javascript",
    extensions: ["js", "mjs", "cjs"],
    entry_point: "main.js",
    template: [{ path: "main.js", content: 'console.log("Hello, NGA!");\n' }],
    local: { build: [], run: { tool: "node", args: ["{entry}"] }, fallback: "js-worker" },
    judge: { engine: "piston", language: "javascript", version: "22.*" },
    preview: null,
    test_kinds: ["io", "unit-node"],
    limits: LIMITS,
  },
  {
    id: "typescript",
    version: 1,
    label: "TypeScript (Node.js)",
    monaco_language: "typescript",
    extensions: ["ts", "mts"],
    entry_point: "main.ts",
    template: [{ path: "main.ts", content: 'const greet = (name: string): string => `Hello, ${name}!`;\nconsole.log(greet("NGA"));\n' }],
    // Node 22.6+ runs TypeScript by stripping types; no compiler needed.
    local: { build: [], run: { tool: "node", args: ["--experimental-strip-types", "--no-warnings", "{entry}"] } },
    judge: { engine: "piston", language: "typescript", version: "5.*" },
    preview: null,
    test_kinds: ["io", "unit-node"],
    limits: LIMITS,
  },
  {
    id: "web",
    version: 1,
    label: "HTML/CSS/JavaScript",
    monaco_language: "html",
    extensions: ["html", "htm", "css"],
    entry_point: "index.html",
    template: [
      {
        path: "index.html",
        content:
          '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>My page</title>\n    <link rel="stylesheet" href="style.css" />\n  </head>\n  <body>\n    <h1>Hello, NGA!</h1>\n    <script src="script.js"></script>\n  </body>\n</html>\n',
      },
      { path: "style.css", content: "body {\n  font-family: system-ui, sans-serif;\n  margin: 2rem;\n}\n" },
      { path: "script.js", content: 'console.log("Page loaded");\n' },
    ],
    local: null,
    judge: { engine: "webgrader", language: "web", version: "1" },
    preview: "static",
    test_kinds: ["web"],
    limits: LIMITS,
  },
  {
    id: "react",
    version: 1,
    label: "React",
    monaco_language: "javascript",
    extensions: ["jsx", "tsx"],
    entry_point: "src/main.jsx",
    template: [
      {
        path: "index.html",
        content: '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>React app</title>\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n',
      },
      {
        path: "src/main.jsx",
        content:
          'import { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n',
      },
      {
        path: "src/App.jsx",
        content:
          'import { useState } from "react";\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>;\n}\n',
      },
    ],
    local: null,
    judge: { engine: "webgrader", language: "react", version: "19" },
    preview: "bundle-react",
    test_kinds: ["web"],
    limits: LIMITS,
  },
  {
    id: "c17",
    version: 1,
    label: "C (C17)",
    monaco_language: "c",
    extensions: ["c", "h"],
    entry_point: "main.c",
    template: [{ path: "main.c", content: '#include <stdio.h>\n\nint main(void) {\n    printf("Hello, NGA!\\n");\n    return 0;\n}\n' }],
    local: {
      build: [{ tool: "cc", args: ["-std=c17", "-Wall", "-O0", "-g", "{sources:c}", "-o", "{out}/main", "-lm"] }],
      run: { tool: "exe", args: ["{out}/main"] },
      fallback: "server",
    },
    judge: { engine: "piston", language: "c", version: "*" },
    preview: null,
    test_kinds: ["io"],
    limits: COMPILED,
  },
  {
    id: "cpp17",
    version: 1,
    label: "C++ (C++17)",
    monaco_language: "cpp",
    extensions: ["cpp", "cc", "cxx", "hpp", "hh"],
    entry_point: "main.cpp",
    template: [{ path: "main.cpp", content: '#include <iostream>\n\nint main() {\n    std::cout << "Hello, NGA!" << std::endl;\n    return 0;\n}\n' }],
    local: {
      build: [{ tool: "cxx", args: ["-std=c++17", "-Wall", "-O0", "-g", "{sources:cpp}", "-o", "{out}/main"] }],
      run: { tool: "exe", args: ["{out}/main"] },
      fallback: "server",
    },
    judge: { engine: "piston", language: "c++", version: "*" },
    preview: null,
    test_kinds: ["io"],
    limits: COMPILED,
  },
  {
    id: "java-21",
    version: 1,
    label: "Java 21",
    monaco_language: "java",
    extensions: ["java"],
    entry_point: "Main.java",
    template: [
      {
        path: "Main.java",
        content: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, NGA!");\n    }\n}\n',
      },
    ],
    local: {
      build: [{ tool: "javac", args: ["-d", "{out}", "-encoding", "UTF-8", "{sources:java}"] }],
      run: { tool: "java", args: ["-cp", "{out}", "{entry_stem}"] },
      fallback: "server",
    },
    judge: { engine: "piston", language: "java", version: "21.*" },
    preview: null,
    test_kinds: ["io", "unit-junit"],
    limits: COMPILED,
  },
  // ── Run hub: Go and Rust compile and run in the Run panel (desktop) ──
  {
    id: "go",
    version: 1,
    label: "Go",
    monaco_language: "go",
    extensions: ["go"],
    entry_point: "main.go",
    template: [{ path: "main.go", content: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, NGA!")\n}\n' }],
    local: {
      build: [{ tool: "go", args: ["build", "-o", "{out}/main", "{entry}"] }],
      run: { tool: "exe", args: ["{out}/main"] },
      fallback: "server",
    },
    judge: { engine: "piston", language: "go", version: "*" },
    preview: null,
    test_kinds: ["io"],
    limits: COMPILED,
  },
  {
    id: "rust",
    version: 1,
    label: "Rust",
    monaco_language: "rust",
    extensions: ["rs"],
    entry_point: "main.rs",
    template: [{ path: "main.rs", content: 'fn main() {\n    println!("Hello, NGA!");\n}\n' }],
    local: {
      build: [{ tool: "rustc", args: ["--edition", "2021", "-g", "{entry}", "-o", "{out}/main"] }],
      run: { tool: "exe", args: ["{out}/main"] },
      fallback: "server",
    },
    judge: { engine: "piston", language: "rust", version: "*" },
    preview: null,
    test_kinds: ["io"],
    limits: COMPILED,
  },
];

export const PROFILES: Profile[] = raw.map((p) => ProfileSchema.parse(p));

export function profileById(id: string): Profile | undefined {
  return PROFILES.find((p) => p.id === id);
}

/** The profile that owns a file, by extension (".js" in a React project is still React when it has JSX files). */
export function profileForPath(path: string, profiles: Profile[] = PROFILES): Profile | undefined {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return profiles.find((p) => p.extensions.includes(ext));
}
