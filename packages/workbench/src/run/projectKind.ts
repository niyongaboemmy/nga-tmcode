/**
 * What kind of project is open, and the best ways to run it (the Run hub).
 * Pure: the caller lists folders and reads manifests; everything here is
 * unit-tested (projectKind.test.ts).
 *
 * A *run action* is one thing the ▶ can do: run a file in the Run panel,
 * open a live preview, start a dev server in a named terminal and open the
 * built-in browser on it, run a one-shot task, open a REPL…
 */
import { packageManagerFor, type PackageManager } from "../tasks/detect";

export type ProjectKindId =
  | "static-site"
  | "vite"
  | "react"
  | "vue"
  | "svelte"
  | "angular"
  | "next"
  | "node"
  | "python"
  | "flask"
  | "django"
  | "fastapi"
  | "maven"
  | "gradle"
  | "spring-boot"
  | "c"
  | "cpp"
  | "make"
  | "cmake"
  | "go"
  | "rust"
  | "dotnet"
  | "flutter"
  | "dart"
  | "php"
  | "laravel"
  | "ruby"
  | "rails"
  | "sinatra"
  | "swift"
  | "sql"
  | "logic"
  | "markdown";

export type RunActionKind =
  /** Build and run a file in the Run panel (runService.runFile). */
  | "runFile"
  /** Run a JavaScript/TypeScript file in the in-app JavaScript Console (structured output). */
  | "jsConsole"
  /** TMCode's live preview of a page (static or React bundled in the app). */
  | "livePreview"
  /** The page in the system browser. */
  | "openBrowser"
  /** A long-running server in a named terminal; the built-in browser opens when its port answers. */
  | "devServer"
  /** A one-shot command in a named terminal (build, test, `go run .`…). */
  | "task"
  /** An interactive interpreter in a terminal (Python, Node.js). */
  | "repl"
  /** Start Debugging on a file. */
  | "debug"
  /** Terminal › Run Task… */
  | "pickTask"
  /** Markdown preview to the side. */
  | "markdownPreview"
  /** Run a .sql file in TMCode's built-in SQLite (results as tables, errors at their line). */
  | "sqlRun"
  /** A .logic file's truth tables (logical expressions), beside it. */
  | "logicPreview";

export interface RunAction {
  /** Stable across rescans, so a remembered choice survives: "<kind>:<dir>:<what>". */
  id: string;
  kind: RunActionKind;
  /** "npm: dev", "index.html (Live Preview)". */
  label: string;
  /** Codicon name. */
  icon: string;
  /** Command line or a hint, shown greyed in pickers. */
  description?: string;
  /** Shell command (devServer, task, repl). */
  command?: string;
  /** Run first when dependencies are missing ("npm install"); the service joins it for the user's shell. */
  prelude?: string;
  /** Workspace-relative folder the command runs in ("" = root). */
  cwd?: string;
  /** A file (runFile, jsConsole, debug, markdownPreview) or the page (livePreview/openBrowser, relative to `root`). */
  entry?: string;
  root?: string;
  preview?: "static" | "bundle-react";
  /** Where a dev server usually listens, used until the terminal prints its real URL. */
  port?: number;
  /** What the host must provide. */
  needs: "none" | "runner" | "terminal" | "debugger" | "preview-origin";
  /** Dev servers, REPLs and tasks never run in an exam. */
  practiceOnly: boolean;
}

export interface FolderSnapshot {
  /** Workspace-relative folder ("" = root). */
  dir: string;
  /** File names directly in the folder. */
  files: string[];
  /** Sub-folder names directly in the folder. */
  dirs: string[];
  /** Contents of the files in PROJECT_FILES that exist (only the first few KB). */
  read: Record<string, string>;
}

export interface ProjectInfo {
  kind: ProjectKindId;
  /** "Vite + React", "Spring Boot (Maven)". */
  label: string;
  icon: string;
  dir: string;
  /** Best first. */
  actions: RunAction[];
}

/** Files worth reading to tell projects apart. */
export const PROJECT_FILES = [
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "Makefile",
  "CMakeLists.txt",
  "Cargo.toml",
  "go.mod",
  "main.go",
  "main.py",
  "app.py",
  "server.py",
  "manage.py",
  "index.html",
  "pubspec.yaml",
  "composer.json",
  "artisan",
  "Gemfile",
  "config.ru",
  "app.rb",
  "Package.swift",
  "index.php",
];

const at = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const where = (dir: string) => (dir ? ` - ${dir}` : "");
const has = (f: FolderSnapshot, name: string) => f.files.includes(name);

function action(a: Omit<RunAction, "practiceOnly" | "needs"> & Partial<Pick<RunAction, "practiceOnly" | "needs">>): RunAction {
  const terminal = a.kind === "devServer" || a.kind === "task" || a.kind === "repl" || a.kind === "pickTask";
  return { practiceOnly: terminal, needs: terminal ? "terminal" : "none", ...a };
}

// ───────────── JavaScript projects ─────────────

interface PackageJson {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function parsePackage(text: string): PackageJson | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as PackageJson) : null;
  } catch {
    return null;
  }
}

export function scriptCommand(pm: PackageManager, script: string) {
  if (pm === "npm") return script === "start" || script === "test" ? `npm ${script}` : `npm run ${script}`;
  return `${pm} ${script}`;
}

const SERVER_LIBS = ["express", "fastify", "koa", "@hapi/hapi", "@nestjs/core", "hono", "socket.io"];

function jsProject(f: FolderSnapshot): ProjectInfo | null {
  if (!has(f, "package.json")) return null;
  const pkg = parsePackage(f.read["package.json"] ?? "") ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const dep = (n: string) => n in deps;
  const scripts = pkg.scripts ?? {};
  const pm = packageManagerFor(f.files);
  const installed = f.dirs.includes("node_modules");
  const prelude = installed || !Object.keys(deps).length ? undefined : `${pm} install`;

  let kind: ProjectKindId = "node";
  let label = "Node.js";
  let icon = "symbol-namespace";
  let port: number | undefined;
  let server = false;
  if (dep("next")) [kind, label, icon, port, server] = ["next", "Next.js", "globe", 3000, true];
  else if (dep("@angular/core")) [kind, label, icon, port, server] = ["angular", "Angular", "globe", 4200, true];
  else if (dep("svelte") || dep("@sveltejs/kit")) [kind, label, icon, port, server] = ["svelte", dep("@sveltejs/kit") ? "SvelteKit" : "Svelte", "globe", 5173, true];
  else if (dep("vue")) [kind, label, icon, port, server] = ["vue", dep("vite") ? "Vite + Vue" : "Vue", "globe", dep("vite") ? 5173 : 8080, true];
  else if (dep("react") && dep("vite")) [kind, label, icon, port, server] = ["react", "Vite + React", "globe", 5173, true];
  else if (dep("react-scripts")) [kind, label, icon, port, server] = ["react", "Create React App", "globe", 3000, true];
  else if (dep("vite")) [kind, label, icon, port, server] = ["vite", "Vite", "globe", 5173, true];
  else if (dep("react")) [kind, label, icon, port, server] = ["react", "React", "globe", undefined, false];
  else if (SERVER_LIBS.some(dep)) {
    const lib = SERVER_LIBS.find(dep)!;
    const name = lib === "@nestjs/core" ? "NestJS" : lib === "@hapi/hapi" ? "hapi" : lib[0].toUpperCase() + lib.slice(1);
    [kind, label, icon, port, server] = ["node", `Node.js (${name})`, "server", 3000, true];
  }

  const actions: RunAction[] = [];
  // NestJS watches with start:dev; others use dev / start / serve.
  const devScript = (dep("@nestjs/core") ? ["start:dev", "dev", "start"] : ["dev", "start", "serve"]).find((sc) => sc in scripts);
  if (devScript) {
    actions.push(
      action({
        id: `${server ? "devServer" : "task"}:${f.dir}:${devScript}`,
        kind: server ? "devServer" : "task",
        label: `${pm}: ${devScript}${where(f.dir)}`,
        icon: server ? "play-circle" : "play",
        description: scripts[devScript],
        command: scriptCommand(pm, devScript),
        prelude,
        cwd: f.dir,
        port,
      }),
    );
  } else if (pkg.main || has(f, "index.js") || has(f, "server.js") || has(f, "app.js")) {
    const main = pkg.main ?? (has(f, "server.js") ? "server.js" : has(f, "app.js") ? "app.js" : "index.js");
    const entry = at(f.dir, main.replace(/^\.\//, ""));
    actions.push(
      server
        ? action({ id: `devServer:${f.dir}:node ${main}`, kind: "devServer", label: `node ${main}${where(f.dir)}`, icon: "play-circle", command: `node ${main}`, prelude, cwd: f.dir, port })
        : action({ id: `runFile:${entry}`, kind: "runFile", label: `Run ${main}`, icon: "play", description: "Node.js in the Run panel", entry, needs: "runner", practiceOnly: false }),
    );
  }
  // React/Vite with an index.html: TMCode can also bundle it itself (offline, no npm, also in exams).
  if ((kind === "react" || kind === "vite") && has(f, "index.html") && f.dirs.includes("src")) {
    actions.push(
      action({
        id: `livePreview:${f.dir}:index.html`,
        kind: "livePreview",
        label: `Live Preview${where(f.dir)}`,
        icon: "open-preview",
        description: "Bundled inside TMCode (offline)",
        root: f.dir,
        entry: "index.html",
        preview: dep("react") ? "bundle-react" : "static",
      }),
    );
  }
  for (const s of ["build", "test", "preview", "lint"]) {
    if (!(s in scripts) || s === devScript) continue;
    actions.push(
      action({
        id: `task:${f.dir}:${s}`,
        kind: s === "preview" ? "devServer" : "task",
        label: `${pm}: ${s}${where(f.dir)}`,
        icon: s === "test" ? "beaker" : s === "build" ? "package" : s === "preview" ? "play-circle" : "checklist",
        description: scripts[s],
        command: scriptCommand(pm, s),
        prelude,
        cwd: f.dir,
        port: s === "preview" ? (kind === "next" ? 3000 : 4173) : undefined,
      }),
    );
  }
  if (!installed && Object.keys(deps).length) {
    actions.push(action({ id: `task:${f.dir}:install`, kind: "task", label: `${pm}: install${where(f.dir)}`, icon: "cloud-download", description: "Install dependencies", command: `${pm} install`, cwd: f.dir }));
  }
  if (!actions.length) return null;
  return { kind, label, icon, dir: f.dir, actions };
}

// ───────────── Python ─────────────

const pyText = (f: FolderSnapshot) =>
  [f.read["requirements.txt"], f.read["pyproject.toml"], f.read["Pipfile"], f.read["main.py"], f.read["app.py"], f.read["server.py"]].filter(Boolean).join("\n");

function pythonExtras(f: FolderSnapshot, entryName: string | null): RunAction[] {
  const out: RunAction[] = [];
  if (entryName) {
    const entry = at(f.dir, entryName);
    out.push(action({ id: `runFile:${entry}`, kind: "runFile", label: `Run ${entryName}`, icon: "play", description: "Python in the Run panel", entry, needs: "runner" }));
  }
  if (has(f, "requirements.txt")) {
    out.push(action({ id: `task:${f.dir}:pip`, kind: "task", label: `pip: install -r requirements.txt${where(f.dir)}`, icon: "cloud-download", command: "python -m pip install -r requirements.txt", cwd: f.dir }));
  }
  out.push(action({ id: `repl:${f.dir}:python`, kind: "repl", label: "Python REPL", icon: "terminal", command: "python", cwd: f.dir }));
  return out;
}

function pythonProject(f: FolderSnapshot): ProjectInfo | null {
  if (has(f, "manage.py")) {
    return {
      kind: "django",
      label: "Django",
      icon: "server",
      dir: f.dir,
      actions: [
        action({ id: `devServer:${f.dir}:runserver`, kind: "devServer", label: `django: runserver${where(f.dir)}`, icon: "play-circle", command: "python manage.py runserver", cwd: f.dir, port: 8000 }),
        action({ id: `task:${f.dir}:migrate`, kind: "task", label: `django: migrate${where(f.dir)}`, icon: "database", command: "python manage.py migrate", cwd: f.dir }),
        action({ id: `task:${f.dir}:test`, kind: "task", label: `django: test${where(f.dir)}`, icon: "beaker", command: "python manage.py test", cwd: f.dir }),
        action({ id: `repl:${f.dir}:shell`, kind: "repl", label: `django: shell${where(f.dir)}`, icon: "terminal", command: "python manage.py shell", cwd: f.dir }),
      ],
    };
  }
  const text = pyText(f);
  const pyFiles = f.files.filter((n) => n.endsWith(".py"));
  const entryName = ["main.py", "app.py", "server.py"].find((n) => has(f, n)) ?? (pyFiles.length === 1 ? pyFiles[0] : null);
  if (/\bfastapi\b/i.test(text)) {
    const mod = (["main.py", "app.py", "server.py"].find((n) => /FastAPI\s*\(/.test(f.read[n] ?? "")) ?? entryName ?? "main.py").replace(/\.py$/, "");
    return {
      kind: "fastapi",
      label: "FastAPI",
      icon: "server",
      dir: f.dir,
      actions: [
        action({ id: `devServer:${f.dir}:uvicorn`, kind: "devServer", label: `uvicorn ${mod}:app${where(f.dir)}`, icon: "play-circle", command: `python -m uvicorn ${mod}:app --reload`, cwd: f.dir, port: 8000 }),
        ...pythonExtras(f, entryName),
      ],
    };
  }
  if (/\bflask\b/i.test(text)) {
    const app = (["app.py", "main.py", "server.py"].find((n) => /Flask\s*\(/.test(f.read[n] ?? "")) ?? entryName ?? "app.py").replace(/\.py$/, "");
    return {
      kind: "flask",
      label: "Flask",
      icon: "server",
      dir: f.dir,
      actions: [
        action({ id: `devServer:${f.dir}:flask`, kind: "devServer", label: `flask run${where(f.dir)}`, icon: "play-circle", command: `python -m flask --app ${app} run --debug`, cwd: f.dir, port: 5000 }),
        ...pythonExtras(f, entryName),
      ],
    };
  }
  if (!entryName && !has(f, "requirements.txt") && !has(f, "pyproject.toml")) return null;
  return { kind: "python", label: "Python", icon: "symbol-method", dir: f.dir, actions: pythonExtras(f, entryName) };
}

// ───────────── Java ─────────────

function javaProject(f: FolderSnapshot): ProjectInfo | null {
  if (has(f, "pom.xml")) {
    const pom = f.read["pom.xml"] ?? "";
    const mvn = has(f, "mvnw") ? "./mvnw" : "mvn";
    const spring = /spring-boot/.test(pom);
    const actions: RunAction[] = [];
    if (spring) actions.push(action({ id: `devServer:${f.dir}:spring-boot:run`, kind: "devServer", label: `maven: spring-boot:run${where(f.dir)}`, icon: "play-circle", command: `${mvn} spring-boot:run`, cwd: f.dir, port: 8080 }));
    else if (/exec-maven-plugin/.test(pom)) actions.push(action({ id: `task:${f.dir}:exec:java`, kind: "task", label: `maven: exec:java${where(f.dir)}`, icon: "play", command: `${mvn} -q compile exec:java`, cwd: f.dir }));
    actions.push(
      action({ id: `task:${f.dir}:package`, kind: "task", label: `maven: package${where(f.dir)}`, icon: "package", command: `${mvn} package`, cwd: f.dir }),
      action({ id: `task:${f.dir}:mvn-test`, kind: "task", label: `maven: test${where(f.dir)}`, icon: "beaker", command: `${mvn} test`, cwd: f.dir }),
    );
    return { kind: spring ? "spring-boot" : "maven", label: spring ? "Spring Boot (Maven)" : "Maven", icon: spring ? "server" : "package", dir: f.dir, actions };
  }
  const gradleFile = has(f, "build.gradle.kts") ? "build.gradle.kts" : has(f, "build.gradle") ? "build.gradle" : null;
  if (gradleFile) {
    const text = f.read[gradleFile] ?? "";
    const gradle = has(f, "gradlew") ? "./gradlew" : "gradle";
    const spring = /spring-boot|org\.springframework\.boot/.test(text);
    const app = /\bapplication\b/.test(text);
    const actions: RunAction[] = [];
    if (spring) actions.push(action({ id: `devServer:${f.dir}:bootRun`, kind: "devServer", label: `gradle: bootRun${where(f.dir)}`, icon: "play-circle", command: `${gradle} bootRun`, cwd: f.dir, port: 8080 }));
    else if (app) actions.push(action({ id: `task:${f.dir}:run`, kind: "task", label: `gradle: run${where(f.dir)}`, icon: "play", command: `${gradle} run`, cwd: f.dir }));
    actions.push(
      action({ id: `task:${f.dir}:build`, kind: "task", label: `gradle: build${where(f.dir)}`, icon: "package", command: `${gradle} build`, cwd: f.dir }),
      action({ id: `task:${f.dir}:gradle-test`, kind: "task", label: `gradle: test${where(f.dir)}`, icon: "beaker", command: `${gradle} test`, cwd: f.dir }),
    );
    return { kind: spring ? "spring-boot" : "gradle", label: spring ? "Spring Boot (Gradle)" : "Gradle", icon: spring ? "server" : "package", dir: f.dir, actions };
  }
  return null;
}

// ───────────── C / C++, Go, Rust, .NET ─────────────

function nativeProject(f: FolderSnapshot): ProjectInfo | null {
  if (has(f, "CMakeLists.txt")) {
    return {
      kind: "cmake",
      label: "CMake",
      icon: "tools",
      dir: f.dir,
      actions: [
        action({ id: `task:${f.dir}:cmake-build`, kind: "task", label: `cmake: build${where(f.dir)}`, icon: "package", command: "cmake -S . -B build && cmake --build build", cwd: f.dir }),
        action({ id: `task:${f.dir}:ctest`, kind: "task", label: `cmake: test${where(f.dir)}`, icon: "beaker", command: "ctest --test-dir build", cwd: f.dir }),
      ],
    };
  }
  if (has(f, "Makefile") || has(f, "makefile")) {
    const targets = new Set<string>();
    for (const line of (f.read["Makefile"] ?? "").split(/\r?\n/)) {
      const m = /^([A-Za-z0-9][\w.-]*)\s*:(?!=)/.exec(line);
      if (m) targets.add(m[1]);
    }
    const actions: RunAction[] = [];
    if (targets.has("run")) actions.push(action({ id: `task:${f.dir}:make run`, kind: "task", label: `make: run${where(f.dir)}`, icon: "play", command: "make run", cwd: f.dir }));
    actions.push(action({ id: `task:${f.dir}:make`, kind: "task", label: `make${where(f.dir)}`, icon: "package", command: "make", cwd: f.dir }));
    if (targets.has("test")) actions.push(action({ id: `task:${f.dir}:make test`, kind: "task", label: `make: test${where(f.dir)}`, icon: "beaker", command: "make test", cwd: f.dir }));
    if (targets.has("clean")) actions.push(action({ id: `task:${f.dir}:make clean`, kind: "task", label: `make: clean${where(f.dir)}`, icon: "trash", command: "make clean", cwd: f.dir }));
    return { kind: "make", label: "Makefile", icon: "tools", dir: f.dir, actions };
  }
  if (has(f, "go.mod")) {
    const web = /"net\/http"|gin-gonic|labstack\/echo|gofiber/.test((f.read["main.go"] ?? "") + (f.read["go.mod"] ?? ""));
    return {
      kind: "go",
      label: web ? "Go (web server)" : "Go",
      icon: "symbol-namespace",
      dir: f.dir,
      actions: [
        action({ id: `${web ? "devServer" : "task"}:${f.dir}:go run .`, kind: web ? "devServer" : "task", label: `go: run .${where(f.dir)}`, icon: web ? "play-circle" : "play", command: "go run .", cwd: f.dir, port: web ? 8080 : undefined }),
        action({ id: `task:${f.dir}:go build`, kind: "task", label: `go: build${where(f.dir)}`, icon: "package", command: "go build ./...", cwd: f.dir }),
        action({ id: `task:${f.dir}:go test`, kind: "task", label: `go: test ./...${where(f.dir)}`, icon: "beaker", command: "go test ./...", cwd: f.dir }),
      ],
    };
  }
  if (has(f, "Cargo.toml")) {
    const web = /^\s*(actix-web|axum|rocket|warp|poem)\s*=/m.test(f.read["Cargo.toml"] ?? "");
    return {
      kind: "rust",
      label: web ? "Rust (web server)" : "Rust (Cargo)",
      icon: "symbol-namespace",
      dir: f.dir,
      actions: [
        action({ id: `${web ? "devServer" : "task"}:${f.dir}:cargo run`, kind: web ? "devServer" : "task", label: `cargo: run${where(f.dir)}`, icon: web ? "play-circle" : "play", command: "cargo run", cwd: f.dir, port: web ? 8080 : undefined }),
        action({ id: `task:${f.dir}:cargo build`, kind: "task", label: `cargo: build${where(f.dir)}`, icon: "package", command: "cargo build", cwd: f.dir }),
        action({ id: `task:${f.dir}:cargo test`, kind: "task", label: `cargo: test${where(f.dir)}`, icon: "beaker", command: "cargo test", cwd: f.dir }),
      ],
    };
  }
  const proj = f.files.find((n) => n.endsWith(".csproj") || n.endsWith(".fsproj"));
  if (proj || f.files.some((n) => n.endsWith(".sln"))) {
    const web = /Microsoft\.NET\.Sdk\.Web/.test(proj ? (f.read[proj] ?? "") : "");
    return {
      kind: "dotnet",
      label: web ? ".NET (ASP.NET Core)" : ".NET",
      icon: "symbol-namespace",
      dir: f.dir,
      actions: [
        action({ id: `${web ? "devServer" : "task"}:${f.dir}:dotnet run`, kind: web ? "devServer" : "task", label: `dotnet: run${where(f.dir)}`, icon: web ? "play-circle" : "play", command: web ? "dotnet watch run" : "dotnet run", cwd: f.dir, port: web ? 5000 : undefined }),
        action({ id: `task:${f.dir}:dotnet build`, kind: "task", label: `dotnet: build${where(f.dir)}`, icon: "package", command: "dotnet build", cwd: f.dir }),
        action({ id: `task:${f.dir}:dotnet test`, kind: "task", label: `dotnet: test${where(f.dir)}`, icon: "beaker", command: "dotnet test", cwd: f.dir }),
      ],
    };
  }
  // A folder of plain sources: compile and run the file with main.
  const single = (["main.c", "main.cpp", "Main.java", "main.go", "main.rs"] as const).find((n) => has(f, n));
  if (single) {
    const entry = at(f.dir, single);
    const kind: ProjectKindId = single.endsWith(".cpp") ? "cpp" : single.endsWith(".c") ? "c" : single.endsWith(".java") ? "maven" : single.endsWith(".go") ? "go" : "rust";
    const label = { "main.c": "C", "main.cpp": "C++", "Main.java": "Java", "main.go": "Go", "main.rs": "Rust" }[single];
    return {
      kind,
      label,
      icon: "file-code",
      dir: f.dir,
      actions: [action({ id: `runFile:${entry}`, kind: "runFile", label: `Run ${single}`, icon: "play", description: "Compile and run in the Run panel", entry, needs: "runner" })],
    };
  }
  return null;
}

// ───────────── Dart & Flutter ─────────────

function dartProject(f: FolderSnapshot): ProjectInfo | null {
  if (!has(f, "pubspec.yaml")) return null;
  const pub = f.read["pubspec.yaml"] ?? "";
  const got = f.dirs.includes(".dart_tool");
  const prelude = got ? undefined : pub.includes("flutter:") ? "flutter pub get" : "dart pub get";
  if (/^\s*flutter:\s*$/m.test(pub) || /sdk:\s*flutter/.test(pub)) {
    const webReady = f.dirs.includes("web");
    return {
      kind: "flutter",
      label: "Flutter",
      icon: "device-mobile",
      dir: f.dir,
      actions: [
        ...(webReady
          ? [action({ id: `devServer:${f.dir}:flutter-web`, kind: "devServer", label: `flutter: run (web)${where(f.dir)}`, icon: "play-circle", description: "Hot reload: press r in the terminal", command: "flutter run -d web-server --web-hostname localhost --web-port 8686", prelude, cwd: f.dir, port: 8686 })]
          : [action({ id: `task:${f.dir}:flutter-create-web`, kind: "task", label: `flutter: add web support${where(f.dir)}`, icon: "add", description: "flutter create . --platforms=web", command: "flutter create . --platforms=web", cwd: f.dir })]),
        action({ id: `task:${f.dir}:flutter-desktop`, kind: "task", label: `flutter: run on this computer${where(f.dir)}`, icon: "device-desktop", command: "flutter run", prelude, cwd: f.dir }),
        action({ id: `task:${f.dir}:flutter-test`, kind: "task", label: `flutter: test${where(f.dir)}`, icon: "beaker", command: "flutter test", prelude, cwd: f.dir }),
        action({ id: `task:${f.dir}:flutter-analyze`, kind: "task", label: `flutter: analyze${where(f.dir)}`, icon: "checklist", command: "flutter analyze", cwd: f.dir }),
        action({ id: `task:${f.dir}:flutter-build-web`, kind: "task", label: `flutter: build web${where(f.dir)}`, icon: "package", command: "flutter build web", prelude, cwd: f.dir }),
        action({ id: `task:${f.dir}:pub-get`, kind: "task", label: `flutter: pub get${where(f.dir)}`, icon: "cloud-download", command: "flutter pub get", cwd: f.dir }),
      ],
    };
  }
  const main = f.dirs.includes("bin") ? "dart run" : has(f, "main.dart") ? "dart run main.dart" : "dart run";
  return {
    kind: "dart",
    label: "Dart",
    icon: "symbol-method",
    dir: f.dir,
    actions: [
      action({ id: `task:${f.dir}:dart-run`, kind: "task", label: `dart: run${where(f.dir)}`, icon: "play", command: main, prelude, cwd: f.dir }),
      action({ id: `task:${f.dir}:dart-test`, kind: "task", label: `dart: test${where(f.dir)}`, icon: "beaker", command: "dart test", prelude, cwd: f.dir }),
      action({ id: `task:${f.dir}:dart-analyze`, kind: "task", label: `dart: analyze${where(f.dir)}`, icon: "checklist", command: "dart analyze", cwd: f.dir }),
      action({ id: `task:${f.dir}:pub-get`, kind: "task", label: `dart: pub get${where(f.dir)}`, icon: "cloud-download", command: "dart pub get", cwd: f.dir }),
    ],
  };
}

// ───────────── PHP & Laravel ─────────────

function phpProject(f: FolderSnapshot): ProjectInfo | null {
  const composer = f.read["composer.json"] ?? "";
  const vendor = f.dirs.includes("vendor");
  const prelude = has(f, "composer.json") && !vendor ? "composer install" : undefined;
  if (has(f, "artisan")) {
    return {
      kind: "laravel",
      label: "Laravel",
      icon: "server",
      dir: f.dir,
      actions: [
        action({ id: `devServer:${f.dir}:artisan-serve`, kind: "devServer", label: `artisan: serve${where(f.dir)}`, icon: "play-circle", command: "php artisan serve", prelude, cwd: f.dir, port: 8000 }),
        action({ id: `task:${f.dir}:artisan-migrate`, kind: "task", label: `artisan: migrate${where(f.dir)}`, icon: "database", command: "php artisan migrate", prelude, cwd: f.dir }),
        action({ id: `task:${f.dir}:artisan-test`, kind: "task", label: `artisan: test${where(f.dir)}`, icon: "beaker", command: "php artisan test", prelude, cwd: f.dir }),
        action({ id: `task:${f.dir}:artisan-routes`, kind: "task", label: `artisan: route:list${where(f.dir)}`, icon: "list-tree", command: "php artisan route:list", cwd: f.dir }),
        action({ id: `repl:${f.dir}:tinker`, kind: "repl", label: `artisan: tinker${where(f.dir)}`, icon: "terminal", command: "php artisan tinker", cwd: f.dir }),
        ...(prelude ? [action({ id: `task:${f.dir}:composer-install`, kind: "task", label: `composer: install${where(f.dir)}`, icon: "cloud-download", command: "composer install", cwd: f.dir })] : []),
      ],
    };
  }
  const phpFiles = f.files.filter((n) => n.endsWith(".php"));
  if (!has(f, "composer.json") && !phpFiles.length) return null;
  const docroot = f.dirs.includes("public") && !has(f, "index.php") ? "public" : ".";
  const actions: RunAction[] = [
    action({ id: `devServer:${f.dir}:php-S`, kind: "devServer", label: `php: built-in server${where(f.dir)}`, icon: "play-circle", description: `php -S localhost:8000 -t ${docroot}`, command: `php -S localhost:8000 -t ${docroot}`, prelude, cwd: f.dir, port: 8000 }),
  ];
  if (/phpunit/.test(composer)) actions.push(action({ id: `task:${f.dir}:phpunit`, kind: "task", label: `phpunit${where(f.dir)}`, icon: "beaker", command: "vendor/bin/phpunit", prelude, cwd: f.dir }));
  if (prelude) actions.push(action({ id: `task:${f.dir}:composer-install`, kind: "task", label: `composer: install${where(f.dir)}`, icon: "cloud-download", command: "composer install", cwd: f.dir }));
  actions.push(action({ id: `repl:${f.dir}:php`, kind: "repl", label: "PHP interactive shell", icon: "terminal", command: "php -a", cwd: f.dir }));
  return { kind: "php", label: has(f, "composer.json") ? "PHP (Composer)" : "PHP", icon: "server", dir: f.dir, actions };
}

// ───────────── Ruby, Rails & Sinatra ─────────────

function rubyProject(f: FolderSnapshot): ProjectInfo | null {
  const gems = f.read["Gemfile"] ?? "";
  const bundled = has(f, "Gemfile.lock");
  const prelude = has(f, "Gemfile") && !bundled ? "bundle install" : undefined;
  if (/\brails\b/.test(gems) || (f.dirs.includes("config") && f.dirs.includes("app") && has(f, "Gemfile"))) {
    return {
      kind: "rails",
      label: "Ruby on Rails",
      icon: "server",
      dir: f.dir,
      actions: [
        action({ id: `devServer:${f.dir}:rails-server`, kind: "devServer", label: `rails: server${where(f.dir)}`, icon: "play-circle", command: "bin/rails server", prelude, cwd: f.dir, port: 3000 }),
        action({ id: `task:${f.dir}:rails-migrate`, kind: "task", label: `rails: db:migrate${where(f.dir)}`, icon: "database", command: "bin/rails db:migrate", prelude, cwd: f.dir }),
        action({ id: `task:${f.dir}:rails-test`, kind: "task", label: `rails: test${where(f.dir)}`, icon: "beaker", command: "bin/rails test", prelude, cwd: f.dir }),
        action({ id: `task:${f.dir}:rails-routes`, kind: "task", label: `rails: routes${where(f.dir)}`, icon: "list-tree", command: "bin/rails routes", cwd: f.dir }),
        action({ id: `repl:${f.dir}:rails-console`, kind: "repl", label: `rails: console${where(f.dir)}`, icon: "terminal", command: "bin/rails console", cwd: f.dir }),
      ],
    };
  }
  const rbFiles = f.files.filter((n) => n.endsWith(".rb"));
  if (!has(f, "Gemfile") && !rbFiles.length) return null;
  const app = has(f, "app.rb") ? "app.rb" : has(f, "main.rb") ? "main.rb" : rbFiles[0];
  const actions: RunAction[] = [];
  if (/sinatra/.test(gems) || /require\s+["']sinatra["']/.test(f.read["app.rb"] ?? "")) {
    actions.push(action({ id: `devServer:${f.dir}:sinatra`, kind: "devServer", label: `ruby ${app} (Sinatra)${where(f.dir)}`, icon: "play-circle", command: has(f, "Gemfile") ? `bundle exec ruby ${app}` : `ruby ${app}`, prelude, cwd: f.dir, port: 4567 }));
  } else if (app) {
    actions.push(action({ id: `task:${f.dir}:ruby ${app}`, kind: "task", label: `ruby ${app}${where(f.dir)}`, icon: "play", command: `ruby ${app}`, prelude, cwd: f.dir }));
  }
  if (/rspec/.test(gems)) actions.push(action({ id: `task:${f.dir}:rspec`, kind: "task", label: `rspec${where(f.dir)}`, icon: "beaker", command: "bundle exec rspec", prelude, cwd: f.dir }));
  if (prelude) actions.push(action({ id: `task:${f.dir}:bundle-install`, kind: "task", label: `bundle install${where(f.dir)}`, icon: "cloud-download", command: "bundle install", cwd: f.dir }));
  actions.push(action({ id: `repl:${f.dir}:irb`, kind: "repl", label: "Ruby REPL (irb)", icon: "terminal", command: "irb", cwd: f.dir }));
  const sinatra = actions[0]?.id.includes("sinatra");
  return { kind: sinatra ? "sinatra" : "ruby", label: sinatra ? "Sinatra" : "Ruby", icon: sinatra ? "server" : "ruby", dir: f.dir, actions };
}

// ───────────── Swift ─────────────

function swiftProject(f: FolderSnapshot): ProjectInfo | null {
  if (!has(f, "Package.swift")) return null;
  return {
    kind: "swift",
    label: "Swift Package",
    icon: "symbol-method",
    dir: f.dir,
    actions: [
      action({ id: `task:${f.dir}:swift-run`, kind: "task", label: `swift: run${where(f.dir)}`, icon: "play", command: "swift run", cwd: f.dir }),
      action({ id: `task:${f.dir}:swift-test`, kind: "task", label: `swift: test${where(f.dir)}`, icon: "beaker", command: "swift test", cwd: f.dir }),
      action({ id: `task:${f.dir}:swift-build`, kind: "task", label: `swift: build${where(f.dir)}`, icon: "package", command: "swift build", cwd: f.dir }),
    ],
  };
}

// ───────────── SQL & logic (built into TMCode) ─────────────

function sqlProject(f: FolderSnapshot): ProjectInfo | null {
  const sql = f.files.filter((n) => /\.sql$/i.test(n));
  if (!sql.length) return null;
  const main = ["main.sql", "queries.sql", "query.sql", "schema.sql"].find((n) => has(f, n)) ?? sql[0];
  return {
    kind: "sql",
    label: "SQL (SQLite)",
    icon: "database",
    dir: f.dir,
    actions: sql
      .sort((a, b) => (a === main ? -1 : b === main ? 1 : a.localeCompare(b)))
      .map((n) => action({ id: `sqlRun:${at(f.dir, n)}`, kind: "sqlRun", label: `Run ${n}`, icon: "database", description: "Built-in SQLite, results as tables", entry: at(f.dir, n) })),
  };
}

function logicProject(f: FolderSnapshot): ProjectInfo | null {
  const files = f.files.filter((n) => /\.logic$/i.test(n));
  if (!files.length) return null;
  return {
    kind: "logic",
    label: "Logic (truth tables)",
    icon: "symbol-boolean",
    dir: f.dir,
    actions: files.map((n) => action({ id: `logicPreview:${at(f.dir, n)}`, kind: "logicPreview", label: `${n} (Truth Tables)`, icon: "table", description: "Every expression's truth table", entry: at(f.dir, n) })),
  };
}

/** Single files of languages that run in a terminal (interpreters TMCode doesn't bundle). */
const TERMINAL_RUNNERS: Record<string, { lang: string; run: (file: string) => string; repl?: { label: string; command: string } }> = {
  php: { lang: "PHP", run: (f) => `php "${f}"`, repl: { label: "PHP interactive shell", command: "php -a" } },
  rb: { lang: "Ruby", run: (f) => `ruby "${f}"`, repl: { label: "Ruby REPL (irb)", command: "irb" } },
  dart: { lang: "Dart", run: (f) => `dart run "${f}"` },
  swift: { lang: "Swift", run: (f) => `swift "${f}"`, repl: { label: "Swift REPL", command: "swift repl" } },
  kt: { lang: "Kotlin", run: (f) => `kotlinc "${f}" -include-runtime -d tmcode-kotlin.jar && java -jar tmcode-kotlin.jar` },
  kts: { lang: "Kotlin script", run: (f) => `kotlinc -script "${f}"` },
  scala: { lang: "Scala", run: (f) => `scala run "${f}"` },
  cs: { lang: "C#", run: (f) => `dotnet run "${f}"` },
  lua: { lang: "Lua", run: (f) => `lua "${f}"`, repl: { label: "Lua REPL", command: "lua" } },
  r: { lang: "R", run: (f) => `Rscript "${f}"`, repl: { label: "R console", command: "R" } },
  pl: { lang: "Perl", run: (f) => `perl "${f}"` },
  sh: { lang: "Shell", run: (f) => `bash "${f}"` },
  ps1: { lang: "PowerShell", run: (f) => `pwsh -File "${f}"` },
  jl: { lang: "Julia", run: (f) => `julia "${f}"`, repl: { label: "Julia REPL", command: "julia" } },
  hs: { lang: "Haskell", run: (f) => `runghc "${f}"`, repl: { label: "GHCi", command: "ghci" } },
  ex: { lang: "Elixir", run: (f) => `elixir "${f}"`, repl: { label: "Elixir (iex)", command: "iex" } },
  exs: { lang: "Elixir", run: (f) => `elixir "${f}"`, repl: { label: "Elixir (iex)", command: "iex" } },
};

// ───────────── static sites & docs ─────────────

function staticSite(f: FolderSnapshot): ProjectInfo | null {
  if (has(f, "package.json")) return null;
  const page = has(f, "index.html") ? "index.html" : has(f, "index.htm") ? "index.htm" : f.files.find((n) => /\.html?$/i.test(n));
  if (!page) return null;
  // A page whose module entry is JSX/TSX is a React app without a build tool: TMCode bundles it.
  if (page === "index.html" && /<script\b[^>]*\bsrc\s*=\s*["'][^"']+\.(jsx|tsx)["']/i.test(f.read["index.html"] ?? "")) {
    return {
      kind: "react",
      label: "React",
      icon: "globe",
      dir: f.dir,
      actions: [
        action({ id: `livePreview:${f.dir}:index.html`, kind: "livePreview", label: `React${where(f.dir)} (Live Preview)`, icon: "open-preview", description: "Bundled inside TMCode (offline)", root: f.dir, entry: "index.html", preview: "bundle-react" }),
      ],
    };
  }
  return {
    kind: "static-site",
    label: "Static website",
    icon: "globe",
    dir: f.dir,
    actions: [
      action({ id: `livePreview:${f.dir}:${page}`, kind: "livePreview", label: `${page}${where(f.dir)} (Live Preview)`, icon: "open-preview", description: "Reloads as you edit", root: f.dir, entry: page, preview: "static" }),
      action({ id: `openBrowser:${f.dir}:${page}`, kind: "openBrowser", label: `${page}${where(f.dir)} (Open in Browser)`, icon: "link-external", description: "System browser", root: f.dir, entry: page, needs: "preview-origin" }),
    ],
  };
}

function markdownDocs(f: FolderSnapshot): ProjectInfo | null {
  const docs = f.files.filter((n) => /\.(md|markdown)$/i.test(n));
  if (!docs.length) return null;
  const page = docs.find((n) => /^readme\.md$/i.test(n)) ?? docs.find((n) => /^index\.md$/i.test(n)) ?? docs[0];
  const entry = at(f.dir, page);
  return {
    kind: "markdown",
    label: "Markdown",
    icon: "markdown",
    dir: f.dir,
    actions: [action({ id: `markdownPreview:${entry}`, kind: "markdownPreview", label: `${page}${where(f.dir)} (Preview)`, icon: "open-preview", entry })],
  };
}

/** The project a folder holds, or null. Build manifests win over loose files. */
export function detectProject(f: FolderSnapshot): ProjectInfo | null {
  return (
    jsProject(f) ??
    javaProject(f) ??
    pythonProject(f) ??
    dartProject(f) ??
    phpProject(f) ??
    rubyProject(f) ??
    swiftProject(f) ??
    nativeProject(f) ??
    staticSite(f) ??
    sqlProject(f) ??
    logicProject(f) ??
    markdownDocs(f)
  );
}

/**
 * Projects of the workspace: the root first, then sub-folders (client/, server/…).
 * A root that is only Markdown (a README beside real projects) goes last.
 */
export function detectProjects(folders: FolderSnapshot[]): ProjectInfo[] {
  const found = folders.map(detectProject).filter((p): p is ProjectInfo => !!p);
  const weight = (p: ProjectInfo) => (p.kind === "markdown" ? 2 : p.dir === "" ? 0 : 1);
  return found.sort((a, b) => weight(a) - weight(b) || a.dir.split("/").length - b.dir.split("/").length || a.dir.localeCompare(b.dir));
}

// ───────────── the active file ─────────────

/**
 * JavaScript that reads keyboard input or needs Node's own modules runs best in
 * Node (Run panel); everything else gets the JavaScript Console's structured output.
 */
export function preferredJsRunner(source: string): "console" | "node" {
  if (/readFileSync\(\s*(0|["']\/dev\/stdin["'])|process\.stdin|require\(\s*["'](node:)?readline["']\)|from\s+["'](node:)?readline/.test(source)) return "node";
  const nodeOnly =
    /require\(\s*["'](node:)?(http|https|net|child_process|os|path|fs|fs\/promises|worker_threads|cluster|dgram|zlib|crypto|stream)["']\)|from\s+["'](node:)?(http|https|net|child_process|os|path|fs|fs\/promises|worker_threads|cluster|zlib|crypto|stream)["']/;
  return nodeOnly.test(source) ? "node" : "console";
}

export interface FileContext {
  /** Folder of the nearest index.html at or above the file (a web page's root), if any. */
  webRoot: string | null;
  /** The file's text, for JavaScript (console vs Node). */
  source?: string;
  /** A debugger exists for this file. */
  debuggable?: boolean;
}

const JS_EXTS = ["js", "mjs", "cjs", "ts", "mts", "cts"];
const COMPILED: Record<string, string> = { c: "C", cpp: "C++", cc: "C++", cxx: "C++", java: "Java", go: "Go", rs: "Rust" };

/** What ▶ can do with the active file, best first. */
export function fileActions(path: string, ctx: FileContext): RunAction[] {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const out: RunAction[] = [];
  const debug = () =>
    ctx.debuggable ? [action({ id: `debug:${path}`, kind: "debug", label: `Debug ${name}`, icon: "debug-alt", description: "Breakpoints and stepping", entry: path, needs: "debugger" })] : [];

  if (ext === "html" || ext === "htm") {
    out.push(
      action({ id: `livePreview:${dir}:${name}`, kind: "livePreview", label: `${name} (Live Preview)`, icon: "open-preview", description: "Reloads as you edit", root: dir, entry: name, preview: "static" }),
      action({ id: `openBrowser:${dir}:${name}`, kind: "openBrowser", label: `${name} (Open in Browser)`, icon: "link-external", description: "System browser", root: dir, entry: name, needs: "preview-origin" }),
    );
  } else if ((ext === "jsx" || ext === "tsx") && ctx.webRoot !== null) {
    out.push(action({ id: `livePreview:${ctx.webRoot}:index.html`, kind: "livePreview", label: "React (Live Preview)", icon: "open-preview", description: "Bundled inside TMCode", root: ctx.webRoot, entry: "index.html", preview: "bundle-react" }));
  } else if ((ext === "css" || ext === "js") && ctx.webRoot !== null) {
    // A stylesheet or script of a page belongs to that page.
    out.push(action({ id: `livePreview:${ctx.webRoot}:index.html`, kind: "livePreview", label: `${ctx.webRoot ? `${ctx.webRoot}/` : ""}index.html (Live Preview)`, icon: "open-preview", description: "The page that uses this file", root: ctx.webRoot, entry: "index.html", preview: "static" }));
    if (ext === "js") out.push(action({ id: `jsConsole:${path}`, kind: "jsConsole", label: `Run ${name} in JavaScript Console`, icon: "debug-console", description: "Structured console output", entry: path }));
  } else if (JS_EXTS.includes(ext)) {
    const consoleRun = action({ id: `jsConsole:${path}`, kind: "jsConsole", label: `Run ${name} in JavaScript Console`, icon: "debug-console", description: "Structured console output", entry: path });
    const nodeRun = action({ id: `runFile:${path}`, kind: "runFile", label: `Run ${name} with Node.js`, icon: "play", description: "Run panel, keyboard input", entry: path, needs: "runner" });
    out.push(...(preferredJsRunner(ctx.source ?? "") === "console" ? [consoleRun, nodeRun] : [nodeRun, consoleRun]), ...debug());
    out.push(action({ id: "repl::node", kind: "repl", label: "Node.js REPL", icon: "terminal", description: "node in a terminal", command: "node", cwd: dir }));
  } else if (ext === "py") {
    out.push(
      action({ id: `runFile:${path}`, kind: "runFile", label: `Run ${name}`, icon: "play", description: "Python in the Run panel", entry: path, needs: "runner" }),
      ...debug(),
      action({ id: "repl::python", kind: "repl", label: "Python REPL", icon: "terminal", description: "python in a terminal", command: "python", cwd: dir }),
    );
  } else if (ext in COMPILED) {
    out.push(action({ id: `runFile:${path}`, kind: "runFile", label: `Run ${name}`, icon: "play", description: `Compile and run (${COMPILED[ext]})`, entry: path, needs: "runner" }), ...debug());
  } else if (ext === "sql") {
    out.push(action({ id: `sqlRun:${path}`, kind: "sqlRun", label: `Run ${name}`, icon: "database", description: "Built-in SQLite, results as tables", entry: path }));
  } else if (ext === "logic") {
    out.push(action({ id: `logicPreview:${path}`, kind: "logicPreview", label: `${name} (Truth Tables)`, icon: "table", description: "Every expression's truth table", entry: path }));
  } else if (ext in TERMINAL_RUNNERS) {
    const r = TERMINAL_RUNNERS[ext];
    out.push(action({ id: `task:${dir}:file:${name}`, kind: "task", label: `Run ${name}`, icon: "play", description: `${r.lang} in a terminal`, command: r.run(name), cwd: dir }), ...debug());
    if (r.repl) out.push(action({ id: `repl::${ext}`, kind: "repl", label: r.repl.label, icon: "terminal", command: r.repl.command, cwd: dir }));
  } else if (ext === "md" || ext === "markdown" || ext === "svg") {
    out.push(action({ id: `markdownPreview:${path}`, kind: "markdownPreview", label: `${name} (Preview)`, icon: "open-preview", entry: path }));
  }
  return out;
}

// ───────────── choosing the run target ─────────────

export interface TargetContext {
  /** Exams and locked-down sessions: no dev servers, tasks or REPLs. */
  practice: boolean;
  terminal: boolean;
  /** Whether a file can run in the Run panel (the browser build only runs JavaScript). */
  runner: boolean | ((entry: string) => boolean);
  debugger: boolean;
  previewOrigin: boolean;
}

/** Whether this host and policy can do an action. */
export function actionAvailable(a: RunAction, ctx: TargetContext): boolean {
  if (a.practiceOnly && !ctx.practice) return false;
  switch (a.needs) {
    case "terminal":
      return ctx.terminal;
    case "runner":
      return typeof ctx.runner === "function" ? ctx.runner(a.entry ?? "") : ctx.runner;
    case "debugger":
      return ctx.debugger;
    case "preview-origin":
      return ctx.previewOrigin;
    default:
      return true;
  }
}

/** Why an action can't run here, for the picker's greyed hint. */
export function unavailableReason(a: RunAction, ctx: TargetContext): string | null {
  if (actionAvailable(a, ctx)) return null;
  if (a.practiceOnly && !ctx.practice) return "Not available during an exam";
  if (a.needs === "terminal") return "Needs the integrated terminal (TMCode desktop app)";
  if (a.needs === "runner") return "Runs in the TMCode desktop app";
  if (a.needs === "preview-origin") return "Available in the TMCode desktop app";
  return "Not available here";
}

/**
 * The Run Project target: the remembered choice while it still exists and is
 * allowed; otherwise the first usable main action of a project; otherwise
 * the best action for the active file.
 */
export function chooseTarget(projects: ProjectInfo[], file: RunAction[], rememberedId: string | null, ctx: TargetContext): RunAction | null {
  const all = [...projects.flatMap((p) => p.actions), ...file];
  if (rememberedId) {
    const hit = all.find((a) => a.id === rememberedId);
    if (hit && actionAvailable(hit, ctx)) return hit;
  }
  for (const p of projects) {
    if (p.kind === "markdown") continue;
    const a = p.actions.find((x) => actionAvailable(x, ctx) && x.kind !== "task" && x.kind !== "repl");
    if (a) return a;
  }
  return file.find((a) => actionAvailable(a, ctx)) ?? projects.flatMap((p) => p.actions).find((a) => actionAvailable(a, ctx)) ?? null;
}

/** Joins a prelude ("npm install") and a command for the user's shell. */
export function shellLine(command: string, opts: { prelude?: string; os: "mac" | "windows" | "linux"; exitAfter?: boolean }): string {
  // macOS and most Linux distributions only ship "python3".
  const fix = (c: string) => (opts.os === "windows" ? c : c.replace(/^python(\s|$)/, "python3$1"));
  let line = fix(command);
  if (opts.prelude) line = opts.os === "windows" ? `${fix(opts.prelude)}; if ($?) { ${line} }` : `${fix(opts.prelude)} && ${line}`;
  // The terminal ends with the command, so TMCode knows when the server stopped (and its exit code).
  if (opts.exitAfter) line = opts.os === "windows" ? `${line}; exit $LASTEXITCODE` : `${line}; exit`;
  return line;
}

/** Elapsed time for the status bar: "0:07", "12:30", "1:02:03". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
