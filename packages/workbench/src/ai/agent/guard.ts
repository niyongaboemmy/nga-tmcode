import { getPlatform } from "../../state/store";
import { useLayerInputs } from "../layerState";
import { useAi } from "../service";
import { buildIgnore, IGNORE_FILE, maskSecrets, type IgnoreMatcher } from "./ignore";
import { checkInstall, installedPackages, packageWarning } from "./packages";
import { BUILT_IN_RULES, decideCall, parsePermissionsFile, PERMISSIONS_FILE, type PermissionRule, type RuleDecision } from "./rules";
import type { AgentMode, Verdict } from "./tools";

/**
 * The safety rails every AI request passes, in every layer and signed out too (proposal P4, C7,
 * F2, F4, F6): what the agent may see (ignore + teacher-hidden), what it may do (the rules), what
 * it may install (the package check) and what leaves the computer (secrets masked).
 */

export interface AgentGuard {
  rules: PermissionRule[];
  ignore: IgnoreMatcher;
  hidden: IgnoreMatcher;
}

let guard: AgentGuard = { rules: BUILT_IN_RULES, ...buildIgnore(null) };

/** The guard now (rules, ignore list); `loadAgentGuard` refreshes it from the project. */
export const agentGuard = () => guard;

export async function loadAgentGuard(): Promise<AgentGuard> {
  const fs = getPlatform().fs;
  const [ignoreText, permsText] = await Promise.all([fs.readFile(IGNORE_FILE).catch(() => null), fs.readFile(PERMISSIONS_FILE).catch(() => null)]);
  const device = (useLayerInputs.getState().device?.rules ?? []).map((r): PermissionRule => ({ rule: r.rule, verdict: r.verdict, source: "device" }));
  const hiddenPaths = useAi.getState().status?.hidden_paths ?? [];
  guard = { rules: [...BUILT_IN_RULES, ...device, ...parsePermissionsFile(permsText)], ...buildIgnore(ignoreText, hiddenPaths) };
  return guard;
}

/** May AI see this file at all (suggestions, @-mentions, context, the agent)? */
export function aiMaySee(path: string | null | undefined): boolean {
  return !path || !guard.ignore.ignores(path);
}

/** Text for an AI request: secrets masked. */
export function forAi(text: string): string {
  return maskSecrets(text).text;
}

export interface GuardVerdict {
  /** null: the mode decides; else what the rails say. */
  verdict: Verdict | null;
  /** Why, for the model (refusals) and the step card. */
  reason?: string;
  /** A warning to show with the approval (a new package). */
  warning?: string;
}

const PATH_TOOLS = new Set(["read_file", "edit_file", "write_file", "delete_file", "rename_file"]);

/** The rails' word on one tool call, before the mode's (async: installs ask the registry). */
export async function guardCall(mode: AgentMode, tool: string, args: Record<string, unknown>): Promise<GuardVerdict> {
  if (PATH_TOOLS.has(tool)) {
    const paths = tool === "rename_file" ? [args.from, args.to] : [args.path];
    for (const p of paths) {
      const path = String(p ?? "").replace(/^\.\/+/, "");
      if (guard.hidden.ignores(path)) return { verdict: "refuse", reason: `${path} is hidden from AI by your teacher.` };
      if (guard.ignore.ignores(path)) return { verdict: "refuse", reason: `${path} is kept away from AI (secrets, keys, binaries or ${IGNORE_FILE}).` };
    }
  }
  const d: RuleDecision | null = decideCall(guard.rules, tool, args);
  if (d?.verdict === "deny") return { verdict: "refuse", reason: `Not allowed by a ${d.rule.source === "built-in" ? "TMCode safety" : d.rule.source} rule: ${d.rule.rule}.` };
  let warning: string | undefined;
  if (tool === "run_command" && installedPackages(String(args.command ?? "")).length) {
    const w = packageWarning(await checkInstall(String(args.command ?? "")));
    if (w?.refuse) return { verdict: "refuse", reason: w.text };
    warning = w?.text;
  }
  if (d?.verdict === "ask" || warning) return { verdict: "ask", ...(warning ? { warning } : {}), ...(d ? { reason: `Asks because of a ${d.rule.source} rule: ${d.rule.rule}.` } : {}) };
  // An allow lets a command run without asking in Edit automatically / Auto, never in Manual.
  if (d?.verdict === "allow" && tool === "run_command" && (mode === "edit" || mode === "auto")) return { verdict: "allow" };
  return { verdict: null };
}

/** The mode's verdict, tightened (or, for an allowed command, loosened) by the rails. */
export function combine(mode: Verdict, rails: GuardVerdict): Verdict {
  if (rails.verdict === "refuse" || mode === "refuse") return "refuse";
  if (rails.verdict === "ask") return "ask";
  if (rails.verdict === "allow") return "allow";
  return mode;
}
