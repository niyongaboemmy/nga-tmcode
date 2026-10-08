import { describe, expect, it } from "vitest";
import { profileById } from "@tmcode/profiles";
import { TEMPLATES, selfHostedConfig, adapterKindFor, adapterKindForProfile, addConfiguration, automaticConfig, newLaunchJson, parseLaunchJson, stripJsonc, substitute, toWorkspacePath } from "./launchJson";

const VSCODE_STYLE = `{
    // Use IntelliSense to learn about possible attributes.
    // For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Python Debugger: Current File", // trailing comment
            "type": "debugpy",
            "request": "launch",
            "program": "\${file}",
            /* block
               comment */
            "args": ["--url", "http://example.com/a//b", "say \\"hi\\" // not a comment"],
            "console": "integratedTerminal",
        },
        {
            "type": "node",
            "request": "launch",
            "name": "Launch Program",
            "skipFiles": ["<node_internals>/**"],
            "program": "\${workspaceFolder}/main.js",
        },
    ],
}
`;

describe("launch.json (JSON with comments)", () => {
  it("strips comments and trailing commas but leaves strings alone", () => {
    const out = stripJsonc('{"a": "x // y", /* c */ "b": [1, 2,], // z\n "c": "/* keep */",}');
    expect(JSON.parse(out)).toEqual({ a: "x // y", b: [1, 2], c: "/* keep */" });
  });

  it("keeps escaped quotes and commas inside strings", () => {
    const out = stripJsonc('{"a": "he said \\"x,}\\"", }');
    expect(JSON.parse(out)).toEqual({ a: 'he said "x,}"' });
  });

  it("parses VS Code's launch.json format", () => {
    const { configurations, error } = parseLaunchJson(VSCODE_STYLE);
    expect(error).toBeNull();
    expect(configurations.map((c) => c.name)).toEqual(["Python Debugger: Current File", "Launch Program"]);
    expect(configurations[0].args).toEqual(["--url", "http://example.com/a//b", 'say "hi" // not a comment']);
    expect(configurations[1].skipFiles).toEqual(["<node_internals>/**"]);
  });

  it("ignores entries without a type or name, and empty files", () => {
    expect(parseLaunchJson('{"configurations": [{"type": "node"}, {"name": "x"}, 3, null]}').configurations).toEqual([]);
    expect(parseLaunchJson("")).toEqual({ configurations: [], error: null });
    expect(parseLaunchJson("{}")).toEqual({ configurations: [], error: null });
  });

  it("reports a syntax error instead of throwing", () => {
    const r = parseLaunchJson('{"configurations": [ { "name": "a", "type": "node" ');
    expect(r.configurations).toEqual([]);
    expect(r.error).toMatch(/^launch\.json: /);
  });

  it("creates a launch.json for every template that parses back", () => {
    for (const t of TEMPLATES) {
      const text = newLaunchJson([t.config]);
      expect(text).toContain('"version": "0.2.0"');
      expect(parseLaunchJson(text).configurations).toEqual([t.config]);
    }
  });

  it("has Python, Node, C/C++, Java, Go, Dart/Flutter, Ruby, C#, PHP and Swift templates", () => {
    const kinds = new Set(TEMPLATES.map((t) => adapterKindFor(t.config.type)));
    expect(kinds).toEqual(new Set(["python", "node", "native", "java", "go", "dart", "ruby", "dotnet", "php"]));
  });

  it("Go and Dart files get an automatic configuration (their debuggers build the program)", () => {
    expect(selfHostedConfig("cmd/main.go")).toMatchObject({ type: "go", mode: "debug", program: "${fileDirname}" });
    expect(selfHostedConfig("bin/app.dart")).toMatchObject({ type: "dart", program: "${file}" });
    expect(selfHostedConfig("main.py")).toBeNull();
    expect(selfHostedConfig("lib/app.rb")).toMatchObject({ type: "rdbg", script: "${file}" });
    expect(selfHostedConfig("Sources/App/main.swift")).toMatchObject({ type: "swift", request: "launch" });
    expect(adapterKindFor("rdbg")).toBe("ruby");
    expect(adapterKindFor("swift")).toBe("native");
    expect(adapterKindFor("coreclr")).toBe("dotnet");
    expect(adapterKindFor("php")).toBe("php");
    expect(selfHostedConfig("src/Program.cs")).toMatchObject({ type: "coreclr", request: "launch" });
    expect(selfHostedConfig("public/index.php")).toMatchObject({ type: "php", program: "${file}", port: 0, env: { XDEBUG_CONFIG: "client_port=${port}" } });
  });

  it("adds a configuration at the top, keeping comments and the others", () => {
    const added = addConfiguration(VSCODE_STYLE, { name: "(lldb) Launch", type: "lldb", request: "launch", program: "${file}" });
    expect(added).toContain("// Use IntelliSense");
    expect(added).toContain("// trailing comment");
    expect(parseLaunchJson(added).configurations.map((c) => c.name)).toEqual(["(lldb) Launch", "Python Debugger: Current File", "Launch Program"]);
    const fromEmptyList = addConfiguration('{ "version": "0.2.0", "configurations": [] }', { name: "a", type: "node", request: "launch" });
    expect(parseLaunchJson(fromEmptyList).configurations.map((c) => c.name)).toEqual(["a"]);
    expect(parseLaunchJson(addConfiguration("", { name: "b", type: "node", request: "launch" })).configurations).toHaveLength(1);
  });

  it("maps debug types and profiles to adapters", () => {
    expect(adapterKindFor("debugpy")).toBe("python");
    expect(adapterKindFor("python")).toBe("python");
    expect(adapterKindFor("pwa-node")).toBe("node");
    expect(adapterKindFor("cppdbg")).toBe("native");
    expect(adapterKindFor("lldb")).toBe("native");
    expect(adapterKindFor("chrome")).toBeNull();
    expect(adapterKindForProfile("python-3")).toBe("python");
    expect(adapterKindForProfile("typescript")).toBe("node");
    expect(adapterKindForProfile("cpp17")).toBe("native");
    expect(adapterKindForProfile("web")).toBeNull();
  });

  it("builds the automatic configuration for the active file", () => {
    expect(automaticConfig(profileById("python-3")!, "src/main.py")).toMatchObject({ type: "debugpy", program: "${file}" });
    expect(automaticConfig(profileById("c17")!, "main.c")?.name).toBe("C: Debug Active File");
    expect(automaticConfig(profileById("web")!, "index.html")).toBeNull();
  });

  it("substitutes VS Code variables, including ${command:pickArgs}", () => {
    const cfg = { name: "x", type: "debugpy", request: "launch" as const, program: "${file}", cwd: "${fileDirname}", args: ["-v", "${command:pickArgs}"], env: { HOME_DIR: "${workspaceFolder}", X: "${env:HOME}", Y: "${unknown}" } };
    const out = substitute(cfg, { root: "/home/s/proj", file: "src/app/main.py", line: 7, args: ["a b", "c"] });
    expect(out.program).toBe("/home/s/proj/src/app/main.py");
    expect(out.cwd).toBe("/home/s/proj/src/app");
    expect(out.args).toEqual(["-v", "a b", "c"]);
    expect(out.env).toEqual({ HOME_DIR: "/home/s/proj", X: "", Y: "${unknown}" });
    expect(substitute("${fileBasenameNoExtension}${fileExtname}:${lineNumber} ${relativeFileDirname}", { root: "/r", file: "a/b.test.py", line: 3 })).toBe("b.test.py:3 a");
  });

  it("maps adapter paths back into the folder", () => {
    expect(toWorkspacePath("/home/s/proj/src/main.py", "/home/s/proj")).toBe("src/main.py");
    expect(toWorkspacePath("/home/s/proj", "/home/s/proj/")).toBe("");
    expect(toWorkspacePath("/usr/lib/python3.12/os.py", "/home/s/proj")).toBeNull();
    expect(toWorkspacePath("/home/s/project2/x.py", "/home/s/proj")).toBeNull();
    // macOS reports /private/var for /var.
    expect(toWorkspacePath("/private/var/folders/x/main.c", "/var/folders/x")).toBe("main.c");
    expect(toWorkspacePath("C:\\Users\\S\\Proj\\main.py", "c:\\users\\s\\proj", true)).toBe("main.py");
  });
});

describe("command-line arguments", async () => {
  const { splitArgs } = await import("./debugService");
  it("splits on spaces and honours quotes", () => {
    expect(splitArgs(`a "b c" 'd e' f\\ g "h \\"i\\""`)).toEqual(["a", "b c", "d e", "f\\", "g", 'h "i"']);
    expect(splitArgs("   ")).toEqual([]);
  });
});

describe("swiftProduct", () => {
  it("picks the executable target, else the product, else the package name", async () => {
    const { swiftProduct } = await import("./debugService");
    expect(swiftProduct(`let package = Package(name: "Pkg", targets: [.target(name: "Lib"), .executableTarget(name: "Hello", dependencies: ["Lib"])])`)).toBe("Hello");
    expect(swiftProduct(`Package(name: "Pkg", products: [.executable(name: "tool", targets: ["Tool"])])`)).toBe("tool");
    expect(swiftProduct(`let package = Package(\n  name: "Only"\n)`)).toBe("Only");
    expect(swiftProduct("// nothing")).toBeNull();
  });
});

describe("kotlinMainClass", () => {
  it("names the file class like kotlinc", async () => {
    const { kotlinMainClass } = await import("./debugService");
    expect(kotlinMainClass("src/com/example/main.kt", "package com.example\n\nfun main() {}")).toBe("com.example.MainKt");
    expect(kotlinMainClass("hello-world.kt", "fun main() {}")).toBe("Hello_worldKt");
  });
});
