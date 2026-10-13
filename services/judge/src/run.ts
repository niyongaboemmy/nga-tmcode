/**
 * POST /v1/run: one endpoint, two request shapes.
 * - `language` = a TMCode profile id ("python-3", "java-21"…) and no `kind`:
 *   the original single-language path (judge.ts), unchanged for Task Mentor.
 * - `kind`, or files to detect a kind from (optionally narrowed by a catalog
 *   `language` key such as "java"): a catalog project (project.ts).
 */
import { judge, RequestError, type RunRequest, type RunResponse } from "./judge.ts";
import { languageById } from "./languages.ts";
import { runProject, type ProjectRequest, type ProjectResponse } from "./project.ts";
import type { ContainerSandbox } from "./containers.ts";
import type { Sandbox } from "./sandbox.ts";
import type { Toolchains } from "./toolchains.ts";

export interface JudgeEnv {
  /** Legacy profiles' programs (resolvePrograms). */
  programs: Map<string, string>;
  toolchains: Toolchains;
  /** Seconds for a whole project request. */
  budgetS?: number;
  /** Tier 3 (Docker + gVisor), when enabled and usable. */
  containers?: ContainerSandbox;
}

export type AnyRunRequest = Partial<RunRequest> & Partial<ProjectRequest>;

export function isProjectRequest(req: AnyRunRequest): boolean {
  if (req.kind !== undefined && req.kind !== null) return true;
  if (typeof req.language === "string" && languageById(req.language)) {
    // A profile asked for unit tests (or a database) runs as its single-file kind.
    return (Array.isArray(req.actions) && req.actions.includes("test")) || (Array.isArray(req.services) && req.services.length > 0);
  }
  return true;
}

export async function run(sandbox: Sandbox, env: JudgeEnv, body: unknown): Promise<RunResponse | ProjectResponse> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Body must be a JSON object.");
  const req = body as AnyRunRequest;
  if (isProjectRequest(req)) return runProject(sandbox, { toolchains: env.toolchains, budgetS: env.budgetS, containers: env.containers }, req as ProjectRequest);
  return judge(sandbox, env.programs, req as RunRequest);
}
