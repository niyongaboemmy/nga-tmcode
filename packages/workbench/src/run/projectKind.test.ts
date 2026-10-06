import { describe, expect, it } from "vitest";
import {
  actionAvailable,
  chooseTarget,
  detectProject,
  detectProjects,
  fileActions,
  formatElapsed,
  preferredJsRunner,
  shellLine,
  unavailableReason,
  type FolderSnapshot,
  type TargetContext,
} from "./projectKind";

const folder = (files: Record<string, string>, opts: { dir?: string; dirs?: string[] } = {}): FolderSnapshot => ({
  dir: opts.dir ?? "",
  files: Object.keys(files),
  dirs: opts.dirs ?? [],
  read: files,
});
const pkg = (p: object) => JSON.stringify(p);
const DESKTOP: TargetContext = { practice: true, terminal: true, runner: true, debugger: true, previewOrigin: true };
const BROWSER: TargetContext = { practice: true, terminal: false, runner: true, debugger: false, previewOrigin: false };
const EXAM: TargetContext = { practice: false, terminal: false, runner: true, debugger: false, previewOrigin: true };

describe("project detection", () => {
  it("a folder with index.html and no package.json is a static website", () => {
    const p = detectProject(folder({ "index.html": "<h1>", "style.css": "" }))!;
    expect(p.kind).toBe("static-site");
    expect(p.actions[0]).toMatchObject({ kind: "livePreview", label: "index.html (Live Preview)", root: "", entry: "index.html", preview: "static" });
    expect(p.actions[1]).toMatchObject({ kind: "openBrowser", needs: "preview-origin" });
  });

  it("a page loading JSX is a React app TMCode bundles itself", () => {
    const p = detectProject(folder({ "index.html": '<script type="module" src="/src/main.jsx"></script>' }, { dir: "react-app", dirs: ["src"] }))!;
    expect(p).toMatchObject({ kind: "react", actions: [{ kind: "livePreview", preview: "bundle-react", root: "react-app" }] });
  });

  it("falls back to any .html page", () => {
    expect(detectProject(folder({ "about.html": "" }))!.actions[0].entry).toBe("about.html");
  });

  it.each([
    [{ dependencies: { react: "19", "react-dom": "19" }, devDependencies: { vite: "6" }, scripts: { dev: "vite", build: "vite build" } }, "react", "Vite + React", 5173],
    [{ dependencies: { vue: "3" }, devDependencies: { vite: "6" }, scripts: { dev: "vite" } }, "vue", "Vite + Vue", 5173],
    [{ devDependencies: { "@sveltejs/kit": "2", svelte: "5" }, scripts: { dev: "vite dev" } }, "svelte", "SvelteKit", 5173],
    [{ dependencies: { "@angular/core": "19" }, scripts: { start: "ng serve" } }, "angular", "Angular", 4200],
    [{ dependencies: { next: "15", react: "19" }, scripts: { dev: "next dev" } }, "next", "Next.js", 3000],
    [{ devDependencies: { vite: "6" }, scripts: { dev: "vite" } }, "vite", "Vite", 5173],
    [{ dependencies: { "react-scripts": "5", react: "18" }, scripts: { start: "react-scripts start" } }, "react", "Create React App", 3000],
    [{ dependencies: { express: "5" }, scripts: { start: "node server.js" } }, "node", "Node.js (Express)", 3000],
  ])("detects %j", (manifest, kind, label, port) => {
    const p = detectProject(folder({ "package.json": pkg(manifest) }, { dirs: ["node_modules"] }))!;
    expect(p.kind).toBe(kind);
    expect(p.label).toBe(label);
    expect(p.actions[0]).toMatchObject({ kind: "devServer", port, practiceOnly: true, needs: "terminal" });
    expect(p.actions[0].prelude).toBeUndefined();
  });

  it("uses the project's package manager and installs missing dependencies first", () => {
    const p = detectProject(folder({ "package.json": pkg({ dependencies: { vite: "6" }, scripts: { dev: "vite", build: "vite build", test: "vitest" } }), "pnpm-lock.yaml": "" }))!;
    expect(p.actions.map((a) => a.label)).toEqual(["pnpm: dev", "pnpm: build", "pnpm: test", "pnpm: install"]);
    expect(p.actions[0]).toMatchObject({ command: "pnpm dev", prelude: "pnpm install" });
  });

  it("a Node.js app without a dev script runs its main file", () => {
    const p = detectProject(folder({ "package.json": pkg({ name: "cli", main: "src/cli.js" }) }, { dir: "tool" }))!;
    expect(p.kind).toBe("node");
    expect(p.actions[0]).toMatchObject({ kind: "runFile", entry: "tool/src/cli.js", needs: "runner" });
  });

  it("a plain npm start is a task, not a server", () => {
    expect(detectProject(folder({ "package.json": pkg({ scripts: { start: "node index.js" } }) }))!.actions[0]).toMatchObject({ kind: "task", command: "npm start" });
  });

  it("React/Vite projects with index.html also get TMCode's own bundled preview", () => {
    const p = detectProject(folder({ "package.json": pkg({ dependencies: { react: "19" }, devDependencies: { vite: "6" }, scripts: { dev: "vite" } }), "index.html": "" }, { dir: "web", dirs: ["src"] }))!;
    expect(p.actions.find((a) => a.kind === "livePreview")).toMatchObject({ root: "web", entry: "index.html", preview: "bundle-react", practiceOnly: false });
    expect(p.actions[0].label).toBe("npm: dev - web");
  });

  it("detects Python scripts, Flask, Django and FastAPI", () => {
    const script = detectProject(folder({ "main.py": "print(1)" }))!;
    expect(script.kind).toBe("python");
    expect(script.actions.map((a) => a.kind)).toEqual(["runFile", "repl"]);

    const flask = detectProject(folder({ "app.py": "from flask import Flask\napp = Flask(__name__)", "requirements.txt": "flask" }))!;
    expect(flask.kind).toBe("flask");
    expect(flask.actions[0]).toMatchObject({ kind: "devServer", command: "python -m flask --app app run --debug", port: 5000 });

    const django = detectProject(folder({ "manage.py": "" }))!;
    expect(django.kind).toBe("django");
    expect(django.actions[0]).toMatchObject({ command: "python manage.py runserver", port: 8000 });

    const fast = detectProject(folder({ "main.py": "from fastapi import FastAPI\napp = FastAPI()" }))!;
    expect(fast.kind).toBe("fastapi");
    expect(fast.actions[0]).toMatchObject({ command: "python -m uvicorn main:app --reload", port: 8000 });
  });

  it("detects Maven, Gradle and Spring Boot", () => {
    expect(detectProject(folder({ "pom.xml": "<project/>" }))!.kind).toBe("maven");
    const boot = detectProject(folder({ "pom.xml": "<artifactId>spring-boot-starter-web</artifactId>", mvnw: "" }))!;
    expect(boot.kind).toBe("spring-boot");
    expect(boot.actions[0]).toMatchObject({ kind: "devServer", command: "./mvnw spring-boot:run", port: 8080 });
    const gradle = detectProject(folder({ "build.gradle.kts": "plugins { application }" }))!;
    expect(gradle.kind).toBe("gradle");
    expect(gradle.actions[0].command).toBe("gradle run");
    expect(detectProject(folder({ "build.gradle": "id 'org.springframework.boot'" }))!.actions[0].command).toBe("gradle bootRun");
  });

  it("detects C/C++ (Makefile, CMake, single file), Go, Rust and .NET", () => {
    const make = detectProject(folder({ Makefile: "all: app\nrun: app\n\t./app\nclean:\n", "main.c": "" }))!;
    expect(make.kind).toBe("make");
    expect(make.actions.map((a) => a.command)).toEqual(["make run", "make", "make clean"]);
    expect(detectProject(folder({ "CMakeLists.txt": "" }))!.kind).toBe("cmake");
    expect(detectProject(folder({ "main.cpp": "" }))!).toMatchObject({ kind: "cpp", actions: [{ kind: "runFile", entry: "main.cpp" }] });
    expect(detectProject(folder({ "main.c": "" }, { dir: "lab1" }))!.actions[0].entry).toBe("lab1/main.c");

    const go = detectProject(folder({ "go.mod": "module x", "main.go": 'import "net/http"' }))!;
    expect(go).toMatchObject({ kind: "go", label: "Go (web server)" });
    expect(go.actions[0]).toMatchObject({ kind: "devServer", command: "go run .", port: 8080 });
    expect(detectProject(folder({ "go.mod": "module x", "main.go": 'import "fmt"' }))!.actions[0].kind).toBe("task");
    expect(detectProject(folder({ "main.go": "package main" }))!.actions[0]).toMatchObject({ kind: "runFile", entry: "main.go" });

    expect(detectProject(folder({ "Cargo.toml": '[dependencies]\nserde = "1"' }))!.actions[0]).toMatchObject({ kind: "task", command: "cargo run" });
    expect(detectProject(folder({ "Cargo.toml": '[dependencies]\naxum = "0.7"' }))!.actions[0].kind).toBe("devServer");

    const dotnet = detectProject(folder({ "Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web">' }))!;
    expect(dotnet).toMatchObject({ kind: "dotnet", label: ".NET (ASP.NET Core)" });
    expect(dotnet.actions[0].command).toBe("dotnet watch run");
  });

  it("detects Markdown docs", () => {
    const p = detectProject(folder({ "notes.md": "", "README.md": "" }))!;
    expect(p.kind).toBe("markdown");
    expect(p.actions[0]).toMatchObject({ kind: "markdownPreview", entry: "README.md" });
  });

  it("returns null for an empty folder", () => {
    expect(detectProject(folder({}))).toBeNull();
  });

  it("orders the root first and a lone README last", () => {
    const list = detectProjects([folder({ "README.md": "" }), folder({ "index.html": "" }, { dir: "web" }), folder({ "main.py": "" }, { dir: "py" })]);
    expect(list.map((p) => `${p.kind}@${p.dir}`)).toEqual(["python@py", "static-site@web", "markdown@"]);
  });
});

describe("active file actions", () => {
  it("HTML gets Live Preview and Open in Browser", () => {
    expect(fileActions("web/about.html", { webRoot: "web" }).map((a) => a.kind)).toEqual(["livePreview", "openBrowser"]);
  });

  it("a script of a page previews the page", () => {
    const a = fileActions("web/app.js", { webRoot: "web" });
    expect(a[0]).toMatchObject({ kind: "livePreview", root: "web", entry: "index.html" });
    expect(a[1].kind).toBe("jsConsole");
  });

  it("JSX in a React project previews the bundle", () => {
    expect(fileActions("react-app/src/App.jsx", { webRoot: "react-app" })[0]).toMatchObject({ preview: "bundle-react", root: "react-app" });
  });

  it("a lone JS file prefers the JavaScript Console unless it reads input", () => {
    expect(fileActions("js/a.js", { webRoot: null, source: "console.log({a:1})" }).map((a) => a.kind)).toEqual(["jsConsole", "runFile", "repl"]);
    expect(fileActions("js/sum.js", { webRoot: null, source: 'require("fs").readFileSync(0, "utf8")', debuggable: true }).map((a) => a.kind)).toEqual([
      "runFile",
      "jsConsole",
      "debug",
      "repl",
    ]);
  });

  it("Python, compiled languages and Markdown", () => {
    expect(fileActions("main.py", { webRoot: null, debuggable: true }).map((a) => a.kind)).toEqual(["runFile", "debug", "repl"]);
    expect(fileActions("src/Main.java", { webRoot: null })[0]).toMatchObject({ kind: "runFile", description: "Compile and run (Java)" });
    expect(fileActions("main.rs", { webRoot: null })[0].kind).toBe("runFile");
    expect(fileActions("README.md", { webRoot: null })[0].kind).toBe("markdownPreview");
    expect(fileActions("data.csv", { webRoot: null })).toEqual([]);
  });

  it("preferredJsRunner", () => {
    expect(preferredJsRunner("const x = [1,2]; console.table(x)")).toBe("console");
    expect(preferredJsRunner('const rl = require("readline")')).toBe("node");
    expect(preferredJsRunner('import http from "node:http"')).toBe("node");
    expect(preferredJsRunner("process.stdin.on('data', f)")).toBe("node");
  });
});

describe("the run target", () => {
  const vite = detectProject(folder({ "package.json": pkg({ devDependencies: { vite: "6" }, scripts: { dev: "vite", build: "vite build" } }) }, { dirs: ["node_modules"] }))!;
  const site = detectProject(folder({ "index.html": "" }, { dir: "web" }))!;
  const file = fileActions("main.py", { webRoot: null });

  it("defaults to the first project's main action", () => {
    expect(chooseTarget([vite, site], file, null, DESKTOP)?.label).toBe("npm: dev");
  });

  it("remembers the user's choice while it exists", () => {
    expect(chooseTarget([vite, site], file, "task::build", DESKTOP)?.label).toBe("npm: build");
    expect(chooseTarget([vite, site], file, "gone", DESKTOP)?.label).toBe("npm: dev");
  });

  it("skips what the host or the exam forbids", () => {
    // No terminal (browser build): the dev server can't run; the static site can.
    expect(chooseTarget([vite, site], file, "devServer::dev", BROWSER)?.label).toBe("index.html - web (Live Preview)");
    expect(chooseTarget([vite], file, null, EXAM)?.label).toBe("Run main.py");
    expect(chooseTarget([], [], null, EXAM)).toBeNull();
    // The browser build runs JavaScript only.
    const jsOnly = { ...BROWSER, runner: (entry: string) => entry.endsWith(".js") };
    expect(chooseTarget([detectProject(folder({ "main.py": "" }))!, site], file, null, jsOnly)?.kind).toBe("livePreview");
  });

  it("explains unavailable actions", () => {
    expect(actionAvailable(vite.actions[0], EXAM)).toBe(false);
    expect(unavailableReason(vite.actions[0], EXAM)).toBe("Not available during an exam");
    expect(unavailableReason(vite.actions[0], BROWSER)).toMatch(/terminal/);
    expect(unavailableReason(site.actions[0], BROWSER)).toBeNull();
  });

  it("builds shell lines per OS", () => {
    expect(shellLine("npm run dev", { prelude: "npm install", os: "mac", exitAfter: true })).toBe("npm install && npm run dev; exit");
    expect(shellLine("npm run dev", { prelude: "npm install", os: "windows", exitAfter: true })).toBe("npm install; if ($?) { npm run dev }; exit $LASTEXITCODE");
    expect(shellLine("python manage.py runserver", { os: "linux" })).toBe("python3 manage.py runserver");
    expect(shellLine("python", { os: "windows" })).toBe("python");
  });
});

describe("formatElapsed", () => {
  it("formats like a stopwatch", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_400)).toBe("0:07");
    expect(formatElapsed(750_000)).toBe("12:30");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });
});
