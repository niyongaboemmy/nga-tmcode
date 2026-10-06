/**
 * Auto-detected tasks, like VS Code's npm / Gradle / Maven / Make task
 * providers: what a real project already knows how to run. Pure parsing here
 * (unit-tested); reading files is the caller's job.
 */

export interface Task {
  /** Shown in the picker, e.g. "npm: dev". */
  label: string;
  /** Shell command run in a new terminal. */
  command: string;
  /** Folder (workspace-relative) the command runs in; "" = workspace root. */
  cwd: string;
  source: "npm" | "maven" | "gradle" | "make" | "cargo" | "go" | "python" | "dotnet";
  /** Codicon name. */
  icon: string;
  /** Long-running servers get the dev-server treatment (port detection). */
  detail?: string;
}

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export function packageManagerFor(files: string[]): PackageManager {
  if (files.includes("bun.lockb") || files.includes("bun.lock")) return "bun";
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  return "npm";
}

/** Scripts from package.json, ordered the way developers reach for them. */
export function npmTasks(packageJson: string, pm: PackageManager, cwd = ""): Task[] {
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(packageJson) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return [];
  }
  const rank = (n: string) => ["dev", "start", "serve", "build", "test", "lint", "preview"].indexOf(n.split(":")[0]);
  const names = Object.keys(scripts).sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.localeCompare(b);
  });
  const run = (name: string) => (pm === "npm" ? (name === "start" || name === "test" ? `npm ${name}` : `npm run ${name}`) : `${pm} ${name}`);
  const tasks: Task[] = names.map((name) => ({
    label: `${pm}: ${name}${cwd ? ` - ${cwd}` : ""}`,
    command: run(name),
    cwd,
    source: "npm",
    icon: /^(dev|start|serve)/.test(name) ? "play-circle" : /^test/.test(name) ? "beaker" : /^build/.test(name) ? "package" : "terminal",
    detail: scripts[name],
  }));
  tasks.push({ label: `${pm}: install${cwd ? ` - ${cwd}` : ""}`, command: `${pm} install`, cwd, source: "npm", icon: "cloud-download", detail: "Install dependencies" });
  return tasks;
}

/** Targets declared in a Makefile (`name: deps`), skipping pattern and special targets. */
export function makeTasks(makefile: string, cwd = ""): Task[] {
  const out = new Set<string>();
  for (const line of makefile.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][\w.-]*)\s*:(?!=)/.exec(line);
    if (m && !m[1].startsWith(".")) out.add(m[1]);
  }
  return [...out].map((t) => ({ label: `make: ${t}`, command: `make ${t}`, cwd, source: "make", icon: "tools" }));
}

const MAVEN_GOALS = ["compile", "test", "package", "clean install", "spring-boot:run"];
const GRADLE_TASKS = ["build", "test", "run", "bootRun", "clean"];

export function javaTasks(files: string[], cwd = "", pomOrGradle = ""): Task[] {
  if (files.includes("pom.xml")) {
    const mvn = files.includes("mvnw") ? "./mvnw" : "mvn";
    const spring = /spring-boot/.test(pomOrGradle);
    return MAVEN_GOALS.filter((g) => spring || g !== "spring-boot:run").map((g) => ({
      label: `maven: ${g}`,
      command: `${mvn} ${g}`,
      cwd,
      source: "maven",
      icon: g === "spring-boot:run" ? "play-circle" : g === "test" ? "beaker" : "package",
    }));
  }
  if (files.some((f) => /^build\.gradle(\.kts)?$/.test(f))) {
    const gradle = files.includes("gradlew") ? "./gradlew" : "gradle";
    const spring = /spring-boot|org\.springframework\.boot/.test(pomOrGradle);
    const app = /\bapplication\b/.test(pomOrGradle);
    return GRADLE_TASKS.filter((t) => (t === "bootRun" ? spring : t === "run" ? app : true)).map((t) => ({
      label: `gradle: ${t}`,
      command: `${gradle} ${t}`,
      cwd,
      source: "gradle",
      icon: t === "bootRun" || t === "run" ? "play-circle" : t === "test" ? "beaker" : "package",
    }));
  }
  return [];
}

/** Tasks for a folder given its file names and the contents of the manifests it has. */
export function detectTasks(files: string[], read: Record<string, string>, cwd = ""): Task[] {
  const tasks: Task[] = [];
  if (read["package.json"] !== undefined) tasks.push(...npmTasks(read["package.json"], packageManagerFor(files), cwd));
  tasks.push(...javaTasks(files, cwd, read["pom.xml"] ?? read["build.gradle"] ?? read["build.gradle.kts"] ?? ""));
  if (read["Makefile"] !== undefined) tasks.push(...makeTasks(read["Makefile"], cwd));
  if (files.includes("Cargo.toml")) {
    for (const t of ["run", "build", "test"]) tasks.push({ label: `cargo: ${t}`, command: `cargo ${t}`, cwd, source: "cargo", icon: t === "run" ? "play-circle" : t === "test" ? "beaker" : "package" });
  }
  if (files.includes("go.mod")) {
    tasks.push({ label: "go: run .", command: "go run .", cwd, source: "go", icon: "play-circle" }, { label: "go: test ./...", command: "go test ./...", cwd, source: "go", icon: "beaker" });
  }
  if (files.includes("manage.py")) {
    tasks.push(
      { label: "django: runserver", command: "python manage.py runserver", cwd, source: "python", icon: "play-circle" },
      { label: "django: migrate", command: "python manage.py migrate", cwd, source: "python", icon: "database" },
    );
  }
  if (files.includes("requirements.txt")) tasks.push({ label: "pip: install -r requirements.txt", command: "python -m pip install -r requirements.txt", cwd, source: "python", icon: "cloud-download" });
  if (files.some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) {
    for (const t of ["run", "build", "test"]) tasks.push({ label: `dotnet: ${t}`, command: `dotnet ${t}`, cwd, source: "dotnet", icon: t === "run" ? "play-circle" : "package" });
  }
  return tasks;
}

/** Manifests worth reading when present. */
export const MANIFESTS = ["package.json", "Makefile", "pom.xml", "build.gradle", "build.gradle.kts"];
