import { z } from "zod";

/**
 * A language profile (plan §7): everything TMCode and the judge need to know
 * about one language. Served by Task Mentor as data so a language can be added
 * or tuned without an app release.
 */
export const TestKindSchema = z.enum(["io", "unit-pytest", "unit-node", "unit-junit", "web"]);
export type TestKind = z.infer<typeof TestKindSchema>;

export const PreviewKindSchema = z.enum(["static", "bundle-react"]);
export type PreviewKind = z.infer<typeof PreviewKindSchema>;

export const LimitsSchema = z.object({
  cpu_s: z.number().positive(),
  wall_s: z.number().positive(),
  memory_mb: z.number().int().positive(),
  output_kb: z.number().int().positive(),
});
export type Limits = z.infer<typeof LimitsSchema>;

export const ToolSchema = z.enum(["python", "node", "cc", "cxx", "javac", "java", "go", "rustc", "exe"]);
export type Tool = z.infer<typeof ToolSchema>;

export const StepSchema = z.object({ tool: ToolSchema, args: z.array(z.string()) });
export type Step = z.infer<typeof StepSchema>;

export const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9.+-]+$/),
  version: z.number().int().positive(),
  label: z.string(),
  /** Monaco language id used for colouring. */
  monaco_language: z.string(),
  /** File extensions this profile owns, without the dot. */
  extensions: z.array(z.string()),
  entry_point: z.string(),
  /** Files a new practice project starts with. */
  template: z.array(z.object({ path: z.string(), content: z.string() })),
  /**
   * How to build and run locally. Each step names a *tool* the desktop app
   * resolved itself ("python", "node", "cc", "cxx", "javac", "java", "go", "rustc", or "exe"
   * for a binary the build produced), so a profile can never run an arbitrary
   * program. Argument tokens: {entry}, {entry_stem}, {out}, {sources:<ext>}.
   */
  local: z
    .object({
      build: z.array(StepSchema).default([]),
      run: StepSchema,
      fallback: z.enum(["pyodide", "js-worker", "server"]).optional(),
    })
    .nullable(),
  judge: z.object({ engine: z.string(), language: z.string(), version: z.string() }).nullable(),
  preview: PreviewKindSchema.nullable(),
  test_kinds: z.array(TestKindSchema),
  limits: LimitsSchema,
});
export type Profile = z.infer<typeof ProfileSchema>;
