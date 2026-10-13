import { describe, expect, it } from "vitest";
import {
  actionAvailable,
  chooseTarget,
  detectProject,
  detectProjects,
  fileActions,
  formatElapsed,
  preferredJsRunner,
  resolveRun,
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

describe("more technologies", () => {
  it("Flutter: web dev server when web/ exists, else a task to add it; desktop, tests, analyze", () => {
    const pub = "name: app\ndependencies:\n  flutter:\n    sdk: flutter\nflutter:\n  uses-material-design: true\n";
    const web = detectProject(folder({ "pubspec.yaml": pub }, { dirs: ["lib", "web", ".dart_tool"] }))!;
    expect(web.kind).toBe("flutter");
    expect(web.actions[0]).toMatchObject({ kind: "devServer", port: 8686 });
    expect(web.actions[0].command).toContain("flutter run -d web-server");
    expect(web.actions.map((a) => a.label)).toEqual(expect.arrayContaining(["flutter: test", "flutter: run on this computer"]));
    const noWeb = detectProject(folder({ "pubspec.yaml": pub }, { dirs: ["lib"] }))!;
    expect(noWeb.actions[0]).toMatchObject({ kind: "task", command: "flutter create . --platforms=web" });
    expect(noWeb.actions[1].prelude).toBe("flutter pub get");
  });

  it("Dart console apps run with dart run", () => {
    const p = detectProject(folder({ "pubspec.yaml": "name: x\ndev_dependencies:\n  test: ^1.0.0\n" }, { dirs: ["bin"] }))!;
    expect(p.kind).toBe("dart");
    expect(p.actions[0]).toMatchObject({ kind: "task", command: "dart run" });
  });

  it("Laravel, Composer PHP and plain PHP", () => {
    const l = detectProject(folder({ artisan: "", "composer.json": "{}" }, { dirs: ["vendor", "app"] }))!;
    expect(l.kind).toBe("laravel");
    expect(l.actions[0]).toMatchObject({ kind: "devServer", command: "php artisan serve", port: 8000 });
    const php = detectProject(folder({ "index.php": "<?php echo 1;" }))!;
    expect(php.kind).toBe("php");
    expect(php.actions[0].command).toBe("php -S localhost:8000 -t .");
    const pub = detectProject(folder({ "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}' }, { dirs: ["public"] }))!;
    expect(pub.actions[0].command).toBe("php -S localhost:8000 -t public");
    expect(pub.actions[0].prelude).toBe("composer install");
    expect(pub.actions.map((a) => a.label)).toContain("phpunit");
  });

  it("Rails, Sinatra and Ruby scripts", () => {
    expect(detectProject(folder({ Gemfile: "gem 'rails'", "Gemfile.lock": "" }, { dirs: ["app", "config"] }))!.actions[0]).toMatchObject({ kind: "devServer", command: "bin/rails server", port: 3000 });
    const s = detectProject(folder({ Gemfile: "gem 'sinatra'", "app.rb": "require 'sinatra'" }))!;
    expect(s.kind).toBe("sinatra");
    expect(s.actions[0]).toMatchObject({ kind: "devServer", port: 4567, prelude: "bundle install" });
    expect(detectProject(folder({ "main.rb": "puts 1" }))!.actions[0]).toMatchObject({ kind: "task", command: "ruby main.rb" });
  });

  it("Swift packages", () => {
    expect(detectProject(folder({ "Package.swift": "// swift-tools-version:5.9" }))!.actions.map((a) => a.command)).toEqual(["swift run", "swift test", "swift build"]);
  });

  it("NestJS starts with start:dev", () => {
    const p = detectProject(folder({ "package.json": pkg({ scripts: { start: "nest start", "start:dev": "nest start --watch" }, dependencies: { "@nestjs/core": "^11" } }) }, { dirs: ["node_modules"] }))!;
    expect(p.label).toBe("Node.js (NestJS)");
    expect(p.actions[0]).toMatchObject({ kind: "devServer", command: "npm run start:dev" });
  });

  it("SQL and logic folders run in TMCode itself", () => {
    const sql = detectProject(folder({ "schema.sql": "", "queries.sql": "" }))!;
    expect(sql.kind).toBe("sql");
    expect(sql.actions.map((a) => [a.kind, a.entry])).toEqual([
      ["sqlRun", "queries.sql"],
      ["sqlRun", "schema.sql"],
    ]);
    expect(detectProject(folder({ "laws.logic": "F = A" }))!.actions[0]).toMatchObject({ kind: "logicPreview", entry: "laws.logic" });
  });

  it("single files of many languages run in a terminal", () => {
    const all = (p: string) => fileActions(p, { webRoot: null });
    const run = (p: string) => all(p).find((a) => a.kind !== "runFile")!;
    // PHP, Ruby, Kotlin, Dart, Swift run in the Run panel first (keyboard input, example tests).
    for (const f of ["src/hello.php", "a.rb", "a.kt", "a.dart", "a.swift"]) expect(all(f)[0]).toMatchObject({ kind: "runFile", entry: f, needs: "runner" });
    expect(run("src/hello.php")).toMatchObject({ kind: "task", command: 'php "hello.php"', cwd: "src" });
    expect(run("a.rb").command).toBe('ruby "a.rb"');
    expect(run("a.dart").command).toBe('dart run "a.dart"');
    expect(run("a.kt").prelude).toContain("kotlinc");
    expect(run("a.kt").command).toBe(`java -jar ".tmcode/build/a.jar"`);
    expect(run("a.lua").command).toBe('lua "a.lua"');
    expect(run("a.R").command).toBe('Rscript "a.R"');
    expect(run("q.sql")).toMatchObject({ kind: "sqlRun", entry: "q.sql", needs: "none" });
    expect(run("x.logic")).toMatchObject({ kind: "logicPreview" });
    // Built-in kinds work in exams too; terminal ones don't.
    expect(actionAvailable(run("q.sql"), EXAM)).toBe(true);
    expect(actionAvailable(run("a.rb"), EXAM)).toBe(false);
  });
});

describe("one Run: resolveRun", () => {
  // The demo layout: loose Python + JS exercises at the top, a React app in a folder.
  const projects = detectProjects([
    folder({ "main.py": "print(1)", "hello.js": "console.log(1)", "README.md": "" }, { dirs: ["react-app"] }),
    folder({ "package.json": pkg({ dependencies: { react: "18" }, devDependencies: { vite: "6" }, scripts: { dev: "vite", build: "vite build", test: "vitest" } }), "index.html": "" }, { dir: "react-app", dirs: ["src", "node_modules"] }),
  ]);
  const run = (activePath: string | null, extra: Partial<Parameters<typeof resolveRun>[0]> = {}) =>
    resolveRun({ projects, file: activePath ? fileActions(activePath, { webRoot: null }) : [], activePath, pins: {}, ctx: DESKTOP, ...extra });

  it("runs the file you're editing when it's a loose exercise", () => {
    const py = run("main.py");
    expect(py.action?.label).toBe("Run main.py");
    expect(py.reason).toBe("it's the file you're editing");
    expect(run("hello.js").action?.entry).toBe("hello.js");
  });

  it("runs the file's own project, never a test or build task", () => {
    const r = run("react-app/src/App.jsx");
    expect(r.action?.label).toMatch(/dev/);
    expect(r.reason).toMatch(/^react-app is a .*React project$/);
  });

  it("a pin wins for its project folder only", () => {
    const build = projects.flatMap((p) => p.actions).find((a) => /build/.test(a.label))!;
    const pins = { "react-app": build.id };
    expect(run("react-app/src/App.jsx", { pins }).action?.id).toBe(build.id);
    expect(run("react-app/src/App.jsx", { pins }).reason).toMatch(/Change Run Target/);
    expect(run("main.py", { pins }).action?.label).toBe("Run main.py");
  });

  it("an exam task's main file wins inside the task folder", () => {
    const task = { entry: "task1/main.py", actions: fileActions("task1/main.py", { webRoot: null }) };
    const r = run("task1/helper.py", { task });
    expect(r.action?.entry).toBe("task1/main.py");
    expect(r.reason).toBe("it's this task's main file");
  });

  it("with nothing open, the only project runs", () => {
    const only = detectProjects([folder({ Makefile: "run:\n\t./app\n", "main.c": "int main(){}" })]);
    const r = resolveRun({ projects: only, file: [], activePath: null, pins: {}, ctx: DESKTOP });
    expect(r.reason).toBe("it's the only project here");
    expect(r.action?.command).toBe("make run");
    // Build and test steps are never "Run": a plain Maven project says how to choose.
    const maven = detectProjects([folder({ "pom.xml": "<project><artifactId>demo</artifactId></project>" }, { dirs: ["src"] })]);
    expect(resolveRun({ projects: maven, file: [], activePath: null, pins: {}, ctx: DESKTOP })).toEqual({ action: null, reason: expect.stringMatching(/Change Run Target/) });
    expect(resolveRun({ projects: [], file: [], activePath: null, pins: {}, ctx: DESKTOP })).toEqual({ action: null, reason: "there is nothing to run here yet" });
  });

  it("a folder of Ruby exercises runs the one being edited; a script beside a Node package runs itself", () => {
    const rb = detectProjects([folder({ "app.rb": "puts 1", "two.rb": "puts 2" })]);
    expect(resolveRun({ projects: rb, file: fileActions("two.rb", { webRoot: null }), activePath: "two.rb", pins: {}, ctx: DESKTOP }).action?.entry).toBe("two.rb");
    const node = detectProjects([folder({ "package.json": pkg({ name: "x" }), "index.js": "console.log(1)", "tool.js": "console.log(2)" })]);
    const r = resolveRun({ projects: node, file: fileActions("tool.js", { webRoot: null, source: "console.log(2)" }), activePath: "tool.js", pins: {}, ctx: DESKTOP });
    expect(r.action?.entry).toBe("tool.js");
  });

  it("a loose PHP script runs as a script", () => {
    const php = detectProjects([folder({ "calc.php": "<?php echo 1;" })]);
    expect(resolveRun({ projects: php, file: fileActions("calc.php", { webRoot: null }), activePath: "calc.php", pins: {}, ctx: DESKTOP }).reason).toBe("it's the file you're editing");
  });

  it("a web page previews itself, not the site's index", () => {
    const site = detectProjects([folder({ "index.html": "", "about.html": "" }, { dir: "web" })]);
    const r = resolveRun({ projects: site, file: fileActions("web/about.html", { webRoot: "web" }), activePath: "web/about.html", pins: {}, ctx: DESKTOP });
    expect(r.reason).toBe("it's the page you're editing");
    expect(r.action?.entry ?? r.action?.label).toMatch(/about\.html/);
  });

  it("a .js file previews its page only when the page loads it", () => {
    expect(fileActions("site/app.js", { webRoot: "site", pageLoadsFile: true })[0].kind).toBe("livePreview");
    expect(fileActions("site/app.js", { webRoot: "site", pageLoadsFile: false })[0].kind).not.toBe("livePreview");
    expect(preferredJsRunner("const prompt = require('prompt-sync')();")).not.toBe(preferredJsRunner("console.log(1)"));
  });
});
