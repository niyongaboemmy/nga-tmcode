/** Java, Kotlin, Scala (§13.2). */
import { kind, LIMITS, mainClass, MANAGED_RUN, out, sources, testFilter, reportTo } from "./kit";

const JVM_RUN = ["-Xmx256m", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1"];
/** Offline; the school repository (cache layer m2-school) is a read-only "tail" behind a writable per-run local repo (Maven 3.9+). */
const M2 = ["-o", "-q", "-B", "-Dmaven.repo.local=/tmp/m2", "-Dmaven.repo.local.tail=/caches/m2-school"];
const GRADLE = ["--offline", "--no-daemon", "-q"];
const JVM_PROJECT_LIMITS = { ...LIMITS["isolate-build"], run: MANAGED_RUN };
const BUILD_FILES = ["pom.xml", "build.gradle", "build.gradle.kts"];

export const JVM_KINDS = [
  kind({
    id: "java/single",
    language: "java",
    label: "Java – source files (no build tool)",
    runtime: "jdk-21",
    wave: "A",
    detect: { anyOf: ["*.java"], none: BUILD_FILES, priority: 10 },
    entry: { default: "Main.java", find: "main-decl" },
    steps: {
      // The JUnit console jar carries the JUnit 5 API, so test classes compile beside the program.
      build: { tool: "javac", args: ["-encoding", "UTF-8", "-cp", "/opt/junit/junit-platform-console-standalone.jar", "-d", out("classes"), sources("java")] },
      run: { tool: "java", args: [...JVM_RUN, "-cp", out("classes"), mainClass] },
      test: {
        tool: "java",
        args: ["-jar", "/opt/junit/junit-platform-console-standalone.jar", "execute", "--class-path", out("classes"), "--scan-class-path", reportTo("--reports-dir="), testFilter],
        report: "junit-dir",
        path: "junit-reports",
      },
    },
    tier: "isolate",
    limits: { build: { cpu_s: 20, wall_s: 40, memory_mb: 768, processes: 64 }, run: MANAGED_RUN },
    notes: "The main class comes from the entry's `package` line plus its file name.",
  }),
  kind({
    id: "java/maven",
    language: "java",
    label: "Java – Maven project",
    runtime: "jdk-21",
    wave: "A",
    detect: { files: ["pom.xml"], priority: 50 },
    entry: { default: "src/main/java/Main.java", find: "manifest" },
    steps: {
      build: { tool: "mvn", args: [...M2, "package", "-DskipTests"], runsProjectScripts: true },
      run: { tool: "java", args: [...JVM_RUN, "-cp", out("target/classes"), mainClass] },
      test: { tool: "mvn", args: [...M2, "test", testFilter], runsProjectScripts: true, report: "junit-dir", path: "target/surefire-reports" },
    },
    tier: "isolate-build",
    caches: ["m2-school"],
    limits: JVM_PROJECT_LIMITS,
  }),
  kind({
    id: "java/gradle",
    language: "java",
    label: "Java – Gradle project",
    runtime: "jdk-21",
    wave: "A",
    detect: { files: ["build.gradle|build.gradle.kts"], anyOf: ["*.java"], priority: 50 },
    entry: { default: "src/main/java/App.java", find: "manifest" },
    steps: {
      build: { tool: "gradle", args: [...GRADLE, "build", "-x", "test"], runsProjectScripts: true },
      run: { tool: "java", args: [...JVM_RUN, "-cp", out("build/classes/java/main"), mainClass] },
      test: { tool: "gradle", args: [...GRADLE, "test", testFilter], runsProjectScripts: true, report: "junit-dir", path: "build/test-results/test" },
    },
    tier: "isolate-build",
    caches: ["gradle-school"],
    limits: JVM_PROJECT_LIMITS,
    notes: "A gradlew wrapper is ignored: the runner's pinned Gradle runs offline.",
  }),
  kind({
    id: "java/spring-boot",
    language: "java",
    label: "Java – Spring Boot",
    runtime: "jdk-21",
    wave: "C",
    detect: { anyOf: BUILD_FILES, contains: [{ file: "pom.xml|build.gradle|build.gradle.kts", text: "spring-boot|org\\.springframework\\.boot" }], priority: 70 },
    entry: { default: "src/main/java/DemoApplication.java", find: "manifest" },
    steps: {
      build: { tool: "mvn", args: [...M2, "package", "-DskipTests"], runsProjectScripts: true },
      test: { tool: "mvn", args: [...M2, "test"], runsProjectScripts: true, report: "junit-dir", path: "target/surefire-reports" },
      serve: { tool: "java", args: ["-Xmx384m", "-XX:+UseSerialGC", "-jar", out("target/app.jar")], port: 8080, ready: "Started " },
    },
    tier: "container",
    caches: ["m2-school"],
  }),
  kind({
    id: "kotlin/single",
    language: "kotlin",
    label: "Kotlin – single file",
    runtime: "kotlin-2",
    wave: "B",
    detect: { anyOf: ["*.kt"], none: BUILD_FILES, priority: 10 },
    entry: { default: "Main.kt", find: "main-decl" },
    steps: {
      build: { tool: "kotlinc", args: [sources("kt"), "-include-runtime", "-d", out("main.jar")] },
      run: { tool: "java", args: [...JVM_RUN, "-jar", out("main.jar")] },
    },
    tier: "isolate-build",
    limits: JVM_PROJECT_LIMITS,
  }),
  kind({
    id: "kotlin/gradle",
    language: "kotlin",
    label: "Kotlin – Gradle project",
    runtime: "kotlin-2",
    wave: "C",
    detect: { files: ["build.gradle.kts"], anyOf: ["*.kt"], priority: 55 },
    entry: { default: "src/main/kotlin/App.kt", find: "main-decl" },
    steps: {
      build: { tool: "gradle", args: [...GRADLE, "build", "-x", "test"], runsProjectScripts: true },
      test: { tool: "gradle", args: [...GRADLE, "test"], runsProjectScripts: true, report: "junit-dir", path: "build/test-results/test" },
    },
    tier: "container",
    caches: ["gradle-school"],
    limits: JVM_PROJECT_LIMITS,
    notes: "Tier 3: the Kotlin Gradle plugin starts a compile daemon and many threads.",
  }),
  kind({
    id: "scala/single",
    language: "scala",
    label: "Scala – single file",
    runtime: "scala-3",
    wave: "C",
    detect: { anyOf: ["*.scala", "*.sc"], none: ["build.sbt"], priority: 10 },
    entry: { default: "Main.scala", find: "main-decl" },
    steps: { run: { tool: "scala-cli", args: ["--server=false", "--offline", "run", { entry: true }] } },
    tier: "isolate-build",
    limits: JVM_PROJECT_LIMITS,
  }),
  kind({
    id: "scala/sbt",
    language: "scala",
    label: "Scala – sbt project",
    runtime: "scala-3",
    wave: "C",
    detect: { files: ["build.sbt"], priority: 50 },
    entry: { default: "src/main/scala/App.scala", find: "main-decl" },
    steps: {
      build: { tool: "sbt", args: ["-Dsbt.offline=true", "compile"], runsProjectScripts: true },
      test: { tool: "sbt", args: ["-Dsbt.offline=true", "test"], runsProjectScripts: true, report: "junit-dir", path: "target/test-reports" },
    },
    tier: "isolate-build",
    caches: ["ivy-school"],
    limits: JVM_PROJECT_LIMITS,
  }),
];
