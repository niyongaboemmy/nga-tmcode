import { describe, expect, it } from "vitest";
import { detectTasks, makeTasks, npmTasks, packageManagerFor } from "./detect";

describe("task detection", () => {
  it("orders npm scripts dev/start/build/test first and uses the project's package manager", () => {
    const pkg = JSON.stringify({ scripts: { lint: "eslint .", build: "vite build", dev: "vite", "test:unit": "vitest" } });
    const pm = packageManagerFor(["package.json", "pnpm-lock.yaml"]);
    expect(pm).toBe("pnpm");
    const tasks = npmTasks(pkg, pm);
    expect(tasks.map((t) => t.command)).toEqual(["pnpm dev", "pnpm build", "pnpm test:unit", "pnpm lint", "pnpm install"]);
    expect(npmTasks(JSON.stringify({ scripts: { start: "node ." } }), "npm")[0].command).toBe("npm start");
  });

  it("ignores broken package.json", () => {
    expect(npmTasks("{nope", "npm")).toEqual([]);
  });

  it("reads Makefile targets but not variables or special targets", () => {
    const tasks = makeTasks("CC := gcc\n.PHONY: all\nall: app\napp: main.o\n\tgcc -o app main.o\n%.o: %.c\n");
    expect(tasks.map((t) => t.label)).toEqual(["make: all", "make: app"]);
  });

  it("detects Spring Boot on Maven and Gradle wrappers", () => {
    const mvn = detectTasks(["pom.xml", "mvnw"], { "pom.xml": "<artifactId>spring-boot-starter-web</artifactId>" });
    expect(mvn.map((t) => t.command)).toContain("./mvnw spring-boot:run");
    const gradle = detectTasks(["build.gradle", "gradlew"], { "build.gradle": "plugins { id 'application' }" });
    expect(gradle.map((t) => t.command)).toEqual(["./gradlew build", "./gradlew test", "./gradlew run", "./gradlew clean"]);
  });

  it("knows Django, Cargo and Go projects", () => {
    const labels = detectTasks(["manage.py", "Cargo.toml", "go.mod"], {}).map((t) => t.label);
    expect(labels).toEqual(expect.arrayContaining(["django: runserver", "cargo: run", "go: run ."]));
  });
});
