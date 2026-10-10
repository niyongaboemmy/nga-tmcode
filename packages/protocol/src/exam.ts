import { z } from "zod";
import { PolicySchema } from "./policy";
import { ProfileSchema } from "./profile";

export const WorkspaceFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  readonly: z.boolean().optional(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

/** A visible I/O test. Hidden tests never leave the server (plan §10.3). */
export const VisibleTestSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  input: z.string(),
  expected_output: z.string(),
  points: z.number().nonnegative(),
});
export type VisibleTest = z.infer<typeof VisibleTestSchema>;

export const ExamTaskSchema = z.object({
  question_id: z.number().int(),
  order: z.number().int(),
  points: z.number().nonnegative(),
  title: z.string(),
  brief_md: z.string(),
  profile_id: z.string(),
  files: z.array(WorkspaceFileSchema),
  visible_tests: z.array(VisibleTestSchema),
  hidden_test_count: z.number().int().nonnegative(),
  resume: z
    .object({ snapshot_seq: z.number().int(), files: z.array(WorkspaceFileSchema) })
    .nullable()
    .optional(),
});
export type ExamTask = z.infer<typeof ExamTaskSchema>;

/** `GET /api/tmcode/sessions/:sid/package` (plan §10.3). */
export const ExamPackageSchema = z.object({
  submission_id: z.number().int(),
  quiz: z.object({ id: z.number().int(), title: z.string(), type: z.string() }),
  deadline: z.string().datetime(),
  server_time: z.string().datetime(),
  policy: PolicySchema,
  journal_nonce: z.string(),
  profiles: z.array(ProfileSchema),
  toolchains: z.array(z.string()),
  tasks: z.array(ExamTaskSchema),
  live: z.object({ url: z.string(), ticket: z.string() }).nullable(),
  /** Oldest TMCode that can take this exam ("0.12.0"); older apps say "Update TMCode". */
  min_app_version: z.string().optional(),
});
export type ExamPackage = z.infer<typeof ExamPackageSchema>;
