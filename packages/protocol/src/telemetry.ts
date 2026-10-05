import { z } from "zod";

/** Telemetry events (plan §11.4). `t` is ms since session start (monotonic). */
const base = { t: z.number().nonnegative() };

export const TelemetryEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("edit"),
    file: z.string(),
    offset: z.number().int(),
    removed: z.number().int(),
    inserted: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("paste"),
    file: z.string(),
    length: z.number().int(),
    lines: z.number().int(),
    origin: z.enum(["internal", "external-blocked", "external-allowed"]),
  }),
  z.object({ ...base, type: z.literal("focus"), state: z.enum(["lost", "gained"]), app: z.string().optional() }),
  z.object({ ...base, type: z.literal("run"), kind: z.enum(["run", "test"]), ok: z.boolean(), ms: z.number() }),
  z.object({
    ...base,
    type: z.literal("file"),
    op: z.enum(["create", "rename", "delete"]),
    path: z.string(),
    to: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("env"), kind: z.string(), detail: z.string() }),
  z.object({ ...base, type: z.literal("lifecycle"), kind: z.string() }),
]);
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
