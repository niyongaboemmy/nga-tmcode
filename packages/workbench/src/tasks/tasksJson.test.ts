import { describe, expect, it } from "vitest";
import { backgroundState, BUILTIN_MATCHERS, matchProblems, resolveMatcher, resolveMatchers } from "./problemMatchers";
import { defaultTaskOf, dependencyError, inputsUsed, parseTasksJson, relativeCwd, resolveVariables } from "./tasksJson";
import { commandLine } from "./runner";

describe("problem matchers", () => {
  it("$tsc, $gcc, $go, $javac, $msCompile", () => {
    expect(matchProblems("src/a.ts(12,5): error TS2322: Type 'string' is not assignable.", BUILTIN_MATCHERS.tsc)).toMatchObject([{ file: "src/a.ts", line: 12, column: 5, severity: "error", code: "2322", message: "Type 'string' is not assignable." }]);
    expect(matchProblems("main.c:3:9: warning: unused variable 'x'\nmain.c:7:1: error: expected ';'", BUILTIN_MATCHERS.gcc).map((p) => [p.line, p.severity])).toEqual([[3, "warning"], [7, "error"]]);
    expect(matchProblems("./main.go:5:2: undefined: x", BUILTIN_MATCHERS.go)[0]).toMatchObject({ file: "./main.go", line: 5, column: 2, severity: "error" });
    expect(matchProblems("Main.java:7: error: cannot find symbol", BUILTIN_MATCHERS.javac)[0]).toMatchObject({ line: 7, severity: "error" });
    expect(matchProblems("C:\\src\\P.cs(10,5): error CS0103: The name 'x' does not exist [C:\\src\\a.csproj]", BUILTIN_MATCHERS.msCompile)[0]).toMatchObject({ file: "C:\\src\\P.cs", line: 10, column: 5, code: "CS0103" });
  });

  it("$eslint-stylish: a file line, then each problem under it (loop)", () => {
    const out = "/p/src/a.js\n  3:10  error  'x' is not defined  no-undef\n  5:1   warning  Unexpected console  no-console\n\n/p/src/b.js\n  1:1  error  Parsing error\n";
    expect(matchProblems(out, BUILTIN_MATCHERS["eslint-stylish"]).map((p) => [p.file, p.line, p.severity, p.code])).toEqual([
      ["/p/src/a.js", 3, "error", "no-undef"],
      ["/p/src/a.js", 5, "warning", "no-console"],
      ["/p/src/b.js", 1, "error", undefined],
    ]);
  });

  it("custom matchers, `base`, location groups and colours stripped", () => {
    const m = resolveMatcher({ owner: "x", fileLocation: ["relative", "${workspaceFolder}"], pattern: { regexp: "^(.*)@(\\d+,\\d+): (.*)$", file: 1, location: 2, message: 3 }, severity: "warning" })!;
    expect(matchProblems("\x1b[31mlib/z.py@4,2: bad\x1b[0m", m)).toMatchObject([{ file: "lib/z.py", line: 4, column: 2, severity: "warning", message: "bad", fileLocation: "relative" }]);
    expect(resolveMatcher({ base: "$tsc", owner: "mine" })?.pattern).toBe(BUILTIN_MATCHERS.tsc.pattern);
    expect(resolveMatchers(["$gcc", "$nope", { pattern: { regexp: "(" } }])).toHaveLength(2);
    expect(matchProblems("anything", resolveMatcher({ pattern: { regexp: "(" } })!)).toEqual([]);
    // Shell integration's marks come right before the output on the same line.
    expect(matchProblems("\x1b]633;E;make\x07\x1b]633;C\x07main.c:3:5: error: oops", BUILTIN_MATCHERS.gcc)[0]).toMatchObject({ file: "main.c", line: 3 });
  });

  it("background: begins and ends", () => {
    const w = BUILTIN_MATCHERS["tsc-watch"];
    expect(backgroundState("Starting compilation in watch mode...", w)).toBe("begin");
    expect(backgroundState("Found 0 errors. Watching for file changes.", w)).toBe("end");
    expect(backgroundState("nothing yet", w)).toBeNull();
  });
});

describe("tasks.json", () => {
  const json = `{
    "version": "2.0.0",
    "options": { "cwd": "\${workspaceFolder}/app" },
    "tasks": [
      { "label": "install", "command": "npm", "args": ["install"] },
      { "label": "lint", "command": "npm run lint", "problemMatcher": "$eslint-stylish", "options": { "cwd": "\${workspaceFolder}" } },
      { "label": "build", "command": "tsc", "args": ["-p", "\${input:project}"], "dependsOn": ["install", "lint"], "dependsOrder": "sequence", "group": { "kind": "build", "isDefault": true }, "problemMatcher": ["$tsc"] },
      { "label": "watch", "command": "tsc -w", "isBackground": true, "problemMatcher": "$tsc-watch", "runOptions": { "runOn": "folderOpen" }, "presentation": { "reveal": "silent" } },
      { "label": "all", "dependsOn": ["build", "watch"] },
      { "label": "test", "command": "npm test", "group": "test" },
      { "label": "a", "command": "x", "dependsOn": "b" },
      { "label": "b", "command": "y", "dependsOn": ["a"] }
    ],
    "inputs": [{ "id": "project", "type": "pickString", "description": "Which project?", "options": ["tsconfig.json", "tsconfig.app.json"], "default": "tsconfig.json" }]
  }`;
  const tf = parseTasksJson(json, "linux");

  it("reads tasks, options, groups, dependencies, background and inputs", () => {
    const by = (l: string) => tf.tasks.find((t) => t.label === l)!;
    expect(by("install")).toMatchObject({ command: "npm install", cwd: "${workspaceFolder}/app" });
    expect(by("lint").cwd).toBe("${workspaceFolder}");
    expect(by("build")).toMatchObject({ dependsOn: ["install", "lint"], dependsOrder: "sequence", group: { kind: "build", isDefault: true } });
    expect(by("watch")).toMatchObject({ isBackground: true, runOn: "folderOpen", reveal: "silent" });
    expect(by("all")).toMatchObject({ command: "", dependsOn: ["build", "watch"], dependsOrder: "parallel" });
    expect(tf.inputs).toEqual([{ id: "project", type: "pickString", description: "Which project?", default: "tsconfig.json", options: ["tsconfig.json", "tsconfig.app.json"], password: false }]);
    expect(defaultTaskOf(tf.tasks, "build")?.label).toBe("build");
    expect(defaultTaskOf(tf.tasks, "test")?.label).toBe("test");
  });

  it("finds missing dependencies and loops", () => {
    expect(dependencyError(tf.tasks, "all")).toBeNull();
    expect(dependencyError(tf.tasks, "a")).toBe("The tasks depend on each other in a loop: a → b → a.");
    expect(dependencyError([{ ...tf.tasks[0], label: "x", dependsOn: ["ghost"] }], "x")).toBe("The task 'ghost' is not defined in tasks.json.");
  });

  it("resolves variables and inputs; keeps the folder inside the project", () => {
    const ctx = { workspaceFolder: "/home/ada/proj", file: "src/app/main.py", env: (n: string) => (n === "HOME" ? "/home/ada" : undefined), inputs: { project: "tsconfig.app.json" } };
    expect(resolveVariables("${file} ${relativeFile} ${fileBasename} ${fileBasenameNoExtension} ${fileDirname} ${fileExtname} ${env:HOME} ${input:project} ${unknown}", ctx)).toBe(
      "/home/ada/proj/src/app/main.py src/app/main.py main.py main /home/ada/proj/src/app .py /home/ada tsconfig.app.json ${unknown}",
    );
    expect(inputsUsed("tsc -p ${input:project}", "${input:project} ${input:other}")).toEqual(["project", "other"]);
    expect(relativeCwd("/home/ada/proj/app", "/home/ada/proj")).toBe("app");
    expect(relativeCwd("/home/ada/proj", "/home/ada/proj")).toBe("");
    expect(relativeCwd("/tmp", "/home/ada/proj")).toBeNull();
    expect(relativeCwd("C:\\Users\\a\\p\\web", "C:\\Users\\a\\p")).toBe("web");
  });

  it("ends the shell with the command's exit code, per shell", () => {
    expect(commandLine("make", "zsh")).toBe("make; exit $?");
    expect(commandLine("make", "PowerShell")).toBe("make; exit $LASTEXITCODE");
    expect(commandLine("make", "Command Prompt")).toBe("make & exit /b %errorlevel%");
  });
});
