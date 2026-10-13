/**
 * The Runtime Catalog's shapes (CODE_RUNNER_PLAN §11.2, §14.1): toolchains
 * (runtimes), languages, project types (kinds) and starter projects. The
 * catalog is data; these zod schemas validate it at build time and let
 * consumers (tm-judge, Task Mentor, TMCode) check what they load.
 */
import { z } from "zod";

// ───────────── runtimes ─────────────

export const RuntimeDefSchema = z.strictObject({
  /** "jdk-21", "python-3.12". */
  id: z.string().regex(/^[a-z0-9][a-z0-9.+-]*$/),
  label: z.string().min(1),
  install: z.strictObject({
    apt: z.array(z.string()).optional(),
    tarball: z.strictObject({ url: z.string().url(), sha256: z.string(), dir: z.string() }).optional(),
    script: z.string().optional(),
  }),
  /** argv that prints the version, e.g. ["java", "-version"]. */
  version: z.array(z.string()),
  /** Logical tool → absolute path inside the runner image. */
  tools: z.record(z.string(), z.string().startsWith("/")),
  /** Always set when this runtime runs. */
  env: z.record(z.string(), z.string()).optional(),
  /** Other runtimes this one builds on (TypeScript uses node-22). */
  uses: z.array(z.string()).optional(),
});
export type RuntimeDef = z.infer<typeof RuntimeDefSchema>;

// ───────────── languages ─────────────

export const WaveSchema = z.enum(["A", "B", "C", "D"]);
export type Wave = z.infer<typeof WaveSchema>;

export const LanguageSchema = z.strictObject({
  /** "python", "cpp", "csharp". */
  key: z.string().regex(/^[a-z][a-z0-9]*$/),
  label: z.string().min(1),
  /** "systems" | "jvm" | "dotnet" | "scripting" | "functional" | "mobile" | "data" | "web" | "other". */
  family: z.enum(["systems", "jvm", "dotnet", "scripting", "functional", "mobile", "data", "web", "other"]),
  wave: WaveSchema,
  /** Offered to schools now (wave A); later waves ship as data with enabled: false. */
  enabled: z.boolean(),
  /** Source extensions without the dot. */
  extensions: z.array(z.string().regex(/^[a-z0-9+]+$/i)).min(1),
  /** Monaco's language id for the editor. */
  monaco_language: z.string(),
});
export type Language = z.infer<typeof LanguageSchema>;

// ───────────── steps ─────────────

/**
 * A step argument: a literal string, or a typed token the runner fills in.
 * - {entry}: the entry file ("src/main.c"); {entry_stem}: without extension ("main")
 * - {out: "main"}: a path in the build output folder
 * - {sources: "c"} / {sources: ["cpp","cc"]}: every source file with that extension
 * - {main_class}: the Java/Kotlin main class (package + file stem)
 * - {test_filter}: the framework's "run only these tests" argument (empty = all)
 * - {report_path}: where the test step must write its report
 */
export const TokenSchema = z.union([
  z.string(),
  z.strictObject({ entry: z.literal(true) }),
  z.strictObject({ entry_stem: z.literal(true) }),
  /** `prefix` glues a flag to the path: {out: "main.mjs", prefix: "--outfile="}. */
  z.strictObject({ out: z.string().min(1), prefix: z.string().optional() }),
  z.strictObject({ sources: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) }),
  z.strictObject({ main_class: z.literal(true) }),
  z.strictObject({ test_filter: z.literal(true) }),
  z.strictObject({ report_path: z.literal(true), prefix: z.string().optional() }),
]);
export type Token = z.infer<typeof TokenSchema>;

export const StepSchema = z.strictObject({
  /** Logical tool, resolved through the runtime's `tools` (never a shell string). */
  tool: z.string().min(1),
  args: z.array(TokenSchema),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  /** Feed this file to the program's stdin instead of the run's input (SQL). */
  stdin: TokenSchema.optional(),
  /** Run the step only when these project files exist (e.g. SQL's schema.sql). */
  when: z.strictObject({ exists: z.array(z.string()).min(1) }).optional(),
  /** The step executes the project's own build logic (npm scripts, make, mvn, gradle): policy may forbid it in exams. */
  runsProjectScripts: z.boolean().optional(),
});
export type Step = z.infer<typeof StepSchema>;

/** How a test step reports results (parsed by testing/report.ts). */
export const ReportKindSchema = z.enum(["junit", "junit-dir", "jest", "rspec", "trx", "go", "dart", "cargo", "swift", "unittest", "minitest", "tap", "text", "none"]);
export type ReportKindId = z.infer<typeof ReportKindSchema>;

export const TestStepSchema = StepSchema.extend({
  report: ReportKindSchema,
  /** Report file or folder, relative to the project. */
  path: z.string().optional(),
});
export type TestStep = z.infer<typeof TestStepSchema>;

export const ServeStepSchema = StepSchema.extend({
  port: z.number().int().positive(),
  /** Text in the output meaning the server is up. */
  ready: z.string(),
});

export const LimitsSchema = z.strictObject({
  cpu_s: z.number().positive().optional(),
  wall_s: z.number().positive().optional(),
  memory_mb: z.number().positive().optional(),
  processes: z.number().int().positive().optional(),
  output_kb: z.number().positive().optional(),
  disk_mb: z.number().positive().optional(),
});
export type Limits = z.infer<typeof LimitsSchema>;

// ───────────── kinds ─────────────

/**
 * Detection rules. A kind matches a project when every `files` marker exists at
 * the project root, at least one `anyOf` glob matches a file anywhere (when
 * given), every `contains` rule matches, and no `none` marker exists at the root.
 * Patterns: "*" within a name; "a|b" lists alternatives. `files`, `none` and
 * plain `contains.file` names are root files; `anyOf` and globbed
 * `contains.file` patterns match base names anywhere (dependency and build
 * folders are ignored).
 */
export const DetectSchema = z.strictObject({
  files: z.array(z.string()).optional(),
  anyOf: z.array(z.string()).optional(),
  contains: z
    .array(
      z.strictObject({
        /** A root file name or a glob ("*.py") matched against every file. */
        file: z.string(),
        /** A regular expression (source text, case-sensitive). */
        text: z.string(),
      }),
    )
    .optional(),
  none: z.array(z.string()).optional(),
  /** Higher wins when several kinds match. Single-file kinds ≈ 10, build tools ≈ 50, frameworks ≈ 70+. */
  priority: z.number(),
});
export type Detect = z.infer<typeof DetectSchema>;

export const TierSchema = z.enum(["browser", "isolate", "isolate-build", "container"]);
export type Tier = z.infer<typeof TierSchema>;

/** Database sidecars a tier-3 run can ask for. */
export const ServiceSchema = z.enum(["postgres", "mysql"]);
export type Service = z.infer<typeof ServiceSchema>;

export const KindDefSchema = z.strictObject({
  /** "<language>/<type>", e.g. "java/maven". */
  id: z.string().regex(/^[a-z0-9]+\/[a-z0-9-]+$/),
  language: z.string(),
  label: z.string().min(1),
  runtime: z.string(),
  wave: WaveSchema,
  enabled: z.boolean(),
  detect: DetectSchema,
  entry: z.strictObject({ default: z.string(), find: z.enum(["main-decl", "manifest"]).optional() }).optional(),
  steps: z.strictObject({
    restore: StepSchema.optional(),
    build: StepSchema.optional(),
    run: StepSchema.optional(),
    test: TestStepSchema.optional(),
    serve: ServeStepSchema.optional(),
  }),
  tier: TierSchema,
  interactive: z.enum(["pipes", "pty", "none"]),
  caches: z.array(z.string()),
  /**
   * Isolate tiers: the box allows file locks (flock, fcntl F_SETLK…). isolate
   * forbids them by default because a lock on an inode several boxes share
   * (/usr, a cache layer) is a side channel between boxes; only kinds whose
   * tools refuse to work without locks turn this on (the go command locks
   * go.mod and its module cache).
   */
  fileLocks: z.boolean().optional(),
  limits: z.partialRecord(z.enum(["restore", "build", "run", "test", "serve"]), LimitsSchema),
  /** Starter ids (§14); filled from the starters' manifests at build time. */
  starters: z.array(z.string()),
  /**
   * Tier 3 only: database sidecars started for every run of this kind (a
   * per-run internal network, tmpfs data, schema.sql/seed.sql loaded, fresh
   * per I/O test). The program gets DATABASE_URL and PG* / MYSQL_* variables.
   */
  services: z.array(ServiceSchema).optional(),
  /** Browser kinds: how TMCode previews it. */
  preview: z.enum(["static", "bundle-react", "dist"]).optional(),
  notes: z.string().optional(),
});
export type KindDef = z.infer<typeof KindDefSchema>;

// ───────────── starters ─────────────

export const LevelSchema = z.enum(["beginner", "intermediate", "advanced"]);
/** §14.1's variants plus "web" (websites and front-end apps previewed in the browser). */
export const PurposeSchema = z.enum(["hello", "io-exercise", "project", "api", "data", "algorithms", "web"]);
export type Purpose = z.infer<typeof PurposeSchema>;

export const StarterManifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  language: z.string(),
  kind: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
  level: LevelSchema,
  purpose: PurposeSchema,
  /** The file to open and run first. */
  entry: z.string(),
  open: z.array(z.string()).min(1),
  tests: z
    .strictObject({
      /** Visible stdin/stdout cases (hidden ones live in Task Mentor). */
      io: z.string().optional(),
      unit: z.strictObject({ framework: z.string(), command: z.string() }).optional(),
    })
    .optional(),
  /** Files students can't change in an exam. */
  readonly: z.array(z.string()).optional(),
  tags: z.array(z.string()),
  /** Catalog version that introduced it. */
  since: z.string(),
  /** Codicon for pickers. */
  icon: z.string().optional(),
  /** Tools the starter needs on a student's own computer (TMCode desktop). */
  tools: z.array(z.string()).optional(),
  /** A one-off command after the files are written (scaffolding), TMCode only. */
  setup: z.strictObject({ command: z.string(), note: z.string() }).optional(),
  /** Older ids (the TMCode New Project template it came from). */
  aliases: z.array(z.string()).optional(),
});
export type StarterManifest = z.infer<typeof StarterManifestSchema>;

/** `.nga/tests.json`: today's `.tmcode/tests.json` plus points. */
export const IoTestsSchema = z.strictObject({
  entry: z.string(),
  tests: z
    .array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        input: z.string(),
        expected_output: z.string(),
        points: z.number().nonnegative(),
      }),
    )
    .min(1),
});
export type IoTests = z.infer<typeof IoTestsSchema>;

export const StarterFileSchema = z.strictObject({ path: z.string(), content: z.string() });
export const StarterSchema = StarterManifestSchema.extend({ files: z.array(StarterFileSchema).min(1) });
export type StarterFile = z.infer<typeof StarterFileSchema>;
export type Starter = z.infer<typeof StarterSchema>;

export const CatalogSchema = z.strictObject({
  version: z.string(),
  languages: z.array(LanguageSchema),
  runtimes: z.array(RuntimeDefSchema),
  kinds: z.array(KindDefSchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;
