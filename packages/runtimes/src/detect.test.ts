import { describe, expect, it } from "vitest";
import { detect, detectKind, entryFor, isTestPath, javaMainClass, matchName } from "./detect";

const reader = (files: Record<string, string>) => (p: string) => files[p] ?? null;
const kindOf = (files: Record<string, string>) => detectKind(Object.keys(files), reader(files));

describe("detect", () => {
  it("a Makefile beats a single C file", () => {
    expect(kindOf({ "main.c": "int main(void){}", Makefile: "app: main.c\n" })).toBe("c/make");
    expect(kindOf({ "main.c": "int main(void){}" })).toBe("c/single");
    expect(kindOf({ "main.cpp": "int main(){}", Makefile: "" })).toBe("cpp/make");
    expect(kindOf({ "CMakeLists.txt": "", "src/main.cpp": "" })).toBe("cpp/cmake");
  });

  it("pom.xml → java/maven, Gradle → java/gradle, Spring Boot wins over both", () => {
    expect(kindOf({ "pom.xml": "<project/>", "src/main/java/App.java": "" })).toBe("java/maven");
    expect(kindOf({ "build.gradle.kts": "plugins { application }", "src/main/java/App.java": "" })).toBe("java/gradle");
    expect(kindOf({ "pom.xml": "<artifactId>spring-boot-starter-parent</artifactId>", "src/main/java/App.java": "" })).toBe("java/spring-boot");
    expect(kindOf({ "Main.java": "class Main {}" })).toBe("java/single");
  });

  it("package.json with vite → js/vite; plain package.json → js/npm; tsconfig → ts/npm", () => {
    expect(kindOf({ "package.json": '{"devDependencies":{"vite":"^7.0.0"}}', "index.html": "", "src/main.js": "" })).toBe("js/vite");
    expect(kindOf({ "package.json": '{"devDependencies":{"vitest":"^3"}}', "src/index.js": "" })).toBe("js/npm");
    expect(kindOf({ "package.json": "{}", "tsconfig.json": "{}", "src/index.ts": "" })).toBe("ts/npm");
    expect(kindOf({ "package.json": '{"dependencies":{"express":"^4"}}', "src/app.js": "" })).toBe("js/express");
    expect(kindOf({ "main.js": "" })).toBe("js/single");
    expect(kindOf({ "main.ts": "" })).toBe("ts/single");
  });

  it("go.mod → go/module, Cargo.toml → rust/cargo", () => {
    expect(kindOf({ "go.mod": "module x\n", "main.go": "package main" })).toBe("go/module");
    expect(kindOf({ "main.go": "package main" })).toBe("go/single");
    expect(kindOf({ "Cargo.toml": '[package]\nname = "x"\n', "src/main.rs": "" })).toBe("rust/cargo");
    expect(kindOf({ "Cargo.toml": '[dependencies]\naxum = "0.7"\n', "src/main.rs": "" })).toBe("rust/web");
    expect(kindOf({ "main.rs": "fn main() {}" })).toBe("rust/single");
  });

  it("requirements.txt → python/project; plain main.py → python/single; frameworks and data win", () => {
    expect(kindOf({ "requirements.txt": "requests\n", "main.py": "" })).toBe("python/project");
    expect(kindOf({ "main.py": "print(1)" })).toBe("python/single");
    expect(kindOf({ "requirements.txt": "pandas\n", "analysis.py": "import pandas" })).toBe("python/data");
    expect(kindOf({ "requirements.txt": "flask\n", "app.py": "from flask import Flask" })).toBe("python/flask");
    expect(kindOf({ "manage.py": "", "site/settings.py": "" })).toBe("python/django");
  });

  it("web pages, SQL and logic", () => {
    expect(kindOf({ "index.html": "<h1>Hi</h1>", "style.css": "", "app.js": "" })).toBe("web/static");
    expect(kindOf({ "index.html": '<script type="module" src="main.jsx"></script>', "main.jsx": "" })).toBe("web/react-cdn");
    expect(kindOf({ "schema.sql": "", "queries.sql": "" })).toBe("sql/sqlite");
    expect(kindOf({ "laws.logic": "" })).toBe("logic/tables");
  });

  it("wave D: shared extensions go to the language whose content matches", () => {
    // *.pl: Perl unless it has Prolog clauses.
    expect(kindOf({ "main.pl": 'use strict;\nprint "Hi\\n";\n' })).toBe("perl/single");
    expect(kindOf({ "main.pl": "main :-\n    writeln('Hi').\n" })).toBe("prolog/single");
    // *.m: GNU Octave unless it imports headers or declares classes (Objective-C).
    expect(kindOf({ "main.m": "disp('Hi');\n" })).toBe("octave/single");
    expect(kindOf({ "main.m": "#import <Foundation/Foundation.h>\nint main(void) { return 0; }\n" })).toBe("objc/single");
    // *.v: V when it declares fn main, Verilog when it has modules.
    expect(kindOf({ "main.v": "fn main() {\n\tprintln('Hi')\n}\n" })).toBe("v/single");
    expect(kindOf({ "main.v": "module main;\n  initial $display(\"Hi\");\nendmodule\n" })).toBe("verilog/iverilog");
    // *.d: D source, not a Makefile dependency file next to C code.
    expect(kindOf({ "main.d": "import std.stdio;\nvoid main() {}\n" })).toBe("d/single");
    expect(kindOf({ "main.c": "int main(void){}", "main.d": "main.o: main.c util.h\n" })).toBe("c/single");
  });

  it("wave D build tools beat their single files", () => {
    expect(kindOf({ "build.zig": "", "src/main.zig": "pub fn main() void {}" })).toBe("zig/build");
    expect(kindOf({ "main.zig": "pub fn main() void {}" })).toBe("zig/single");
    expect(kindOf({ "app.nimble": "", "src/app.nim": "" })).toBe("nim/nimble");
    expect(kindOf({ "fpm.toml": "", "app/main.f90": "" })).toBe("fortran/fpm");
    expect(kindOf({ "dune-project": "(lang dune 3.0)", "bin/main.ml": "" })).toBe("ocaml/dune");
    expect(kindOf({ "rebar.config": "", "src/app.erl": "" })).toBe("erlang/rebar3");
    expect(kindOf({ "gleam.toml": 'name = "app"', "src/app.gleam": "", "src/app_ffi.erl": "" })).toBe("gleam/project");
    expect(kindOf({ "build.gradle": "plugins { id 'groovy' }", "src/main/groovy/App.groovy": "" })).toBe("groovy/gradle");
    expect(kindOf({ "build.gradle": "plugins { id 'java' }", "src/main/java/App.java": "" })).toBe("java/gradle");
    expect(kindOf({ "App.fsproj": "<Project/>", "Program.fs": "" })).toBe("fsharp/console");
    expect(kindOf({ "Tests.fsproj": "Microsoft.NET.Test.Sdk", "Tests.fs": "" })).toBe("fsharp/test");
    expect(kindOf({ "App.vbproj": "<Project/>", "Program.vb": "" })).toBe("vb/console");
  });

  it("ignores dependency and build folders, and returns nothing for no code", () => {
    expect(detect(["node_modules/x/index.js", "README.md"])).toEqual([]);
    expect(kindOf({ "target/classes/Main.java": "", "main.py": "" })).toBe("python/single");
  });

  it("content rules need a reader", () => {
    const files = { "pom.xml": "spring-boot", "src/main/java/App.java": "" };
    expect(detectKind(Object.keys(files))).toBe("java/maven");
  });

  it("matches names with globs and alternatives", () => {
    expect(matchName("*.c", "list.c")).toBe(true);
    expect(matchName("*.c", "list.cpp")).toBe(false);
    expect(matchName("Makefile|makefile", "makefile")).toBe(true);
  });
});

describe("entryFor", () => {
  it("picks the file that declares main, not the test", () => {
    const files = { "src/list.c": "int list_len(void){return 0;}", "src/main.c": "int main(void) { return 0; }", "tests/test_list.c": "int main(void) { return 0; }" };
    expect(entryFor("c/make", Object.keys(files), reader(files))).toBe("src/main.c");
  });

  it("finds a Java main class in packages", () => {
    const files = { "src/rw/ac/nga/model/Student.java": "package rw.ac.nga.model; public record Student() {}", "src/rw/ac/nga/App.java": "package rw.ac.nga;\nclass App { public static void main(String[] a) {} }" };
    const entry = entryFor("java/single", Object.keys(files), reader(files));
    expect(entry).toBe("src/rw/ac/nga/App.java");
    expect(javaMainClass(entry!, files[entry as keyof typeof files])).toBe("rw.ac.nga.App");
  });

  it("Python: __main__ guard, then conventional names", () => {
    const files = { "helpers.py": "def f(): pass", "run.py": 'if __name__ == "__main__":\n    pass\n', "test_run.py": 'if __name__ == "__main__": pass' };
    expect(entryFor("python/single", Object.keys(files), reader(files))).toBe("run.py");
    expect(entryFor("python/single", ["util.py", "main.py"], () => "")).toBe("main.py");
  });

  it("npm projects: package.json start script or main", () => {
    const files = { "package.json": '{"scripts":{"start":"node src/server.js"}}', "src/server.js": "", "src/app.js": "" };
    expect(entryFor("js/npm", Object.keys(files), reader(files))).toBe("src/server.js");
    const ts = { "package.json": '{"main":"dist/index.js"}', "src/index.ts": "", "tsconfig.json": "{}" };
    expect(entryFor("ts/npm", Object.keys(ts), reader(ts))).toBe("src/index.ts");
  });

  it("Cargo, Go modules, SQL and web", () => {
    expect(entryFor("rust/cargo", ["Cargo.toml", "src/lib.rs", "src/main.rs"])).toBe("src/main.rs");
    const go = { "go.mod": "", "main.go": "package main\nfunc main() {}", "internal/x/x.go": "package x" };
    expect(entryFor("go/module", Object.keys(go), reader(go))).toBe("main.go");
    expect(entryFor("sql/sqlite", ["schema.sql", "seed.sql", "queries.sql"])).toBe("queries.sql");
    expect(entryFor("web/static", ["about.html", "index.html", "style.css"])).toBe("index.html");
  });

  it("wave D entries: Gleam and VB declare main", () => {
    const gleam = { "gleam.toml": "", "src/util.gleam": "pub fn twice(x) { x * 2 }", "src/app.gleam": "pub fn main() {}" };
    expect(entryFor("gleam/project", Object.keys(gleam), reader(gleam))).toBe("src/app.gleam");
    const vb = { "App.vbproj": "", "Helpers.vb": "Module Helpers\nEnd Module", "Start.vb": "Module Start\n  Sub Main()\n  End Sub\nEnd Module" };
    expect(entryFor("vb/console", Object.keys(vb), reader(vb))).toBe("Start.vb");
  });

  it("null when the project has no file of the language", () => {
    expect(entryFor("c/single", ["README.md"])).toBeNull();
    expect(entryFor("nope/kind", ["main.c"])).toBeNull();
  });

  it("tells test files apart", () => {
    expect(isTestPath("tests/test_cart.py")).toBe(true);
    expect(isTestPath("src/math.test.js")).toBe(true);
    expect(isTestPath("src/AppTest.java")).toBe(false);
    expect(isTestPath("src/main.c")).toBe(false);
  });
});
