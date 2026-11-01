import { compileIgnoreLine, IgnoreMatcher } from "./ignore";

/**
 * The agent's permission rules (proposal C7): `action(target)` rules from several sources, in
 * order built-in → device → school → teacher → user, decided **deny > ask > allow** across all of
 * them (Antigravity, Zed, Claude Code: a deny from any level always applies). A rule only ever
 * tightens what the mode would do, except an allow, which may let a command run without asking in
 * Edit automatically / Auto (never in Manual, and never past a deny or an ask).
 *
 *   read(src/**)          the agent may read src
 *   edit(*.lock)          editing lock files
 *   delete(*)             deleting anything
 *   run(npm test*)        a command starting with "npm test"
 *   run(*)                any command
 *
 * Paths use gitignore globs (relative to the project); commands use `*` as "anything". The user's
 * rules live in the project's `.tmcode/permissions.json`: { "rules": [{ "rule", "verdict" }] }.
 */

export type RuleVerdict = "allow" | "ask" | "deny";
export type RuleSource = "built-in" | "device" | "school" | "teacher" | "user";
export type RuleAction = "read" | "edit" | "delete" | "rename" | "run";

export interface PermissionRule {
  rule: string;
  verdict: RuleVerdict;
  source: RuleSource;
}

export const PERMISSIONS_FILE = ".tmcode/permissions.json";

/** Dangerous whatever the mode (deny), and what always needs a person (ask). */
export const BUILT_IN_RULES: PermissionRule[] = [
  ...["rm -rf /*", "rm -rf ~*", "rm -rf /", "sudo *", "*mkfs*", "*dd if=*", "*:(){*", "*git push --force*", "*git push -f*", "*curl * | sh*", "*curl * | bash*", "*wget * | sh*", "*wget * | bash*", "*chmod -R 777 /*"].map(
    (c): PermissionRule => ({ rule: `run(${c})`, verdict: "deny", source: "built-in" }),
  ),
  // TMCode's own records: the link, the signed layer, the activity log.
  ...[".tmcode/project.json", ".tmcode/layer.json", ".tmcode/activity/**", ".tmcode/permissions.json"].flatMap((p): PermissionRule[] => [
    { rule: `edit(${p})`, verdict: "deny", source: "built-in" },
    { rule: `delete(${p})`, verdict: "deny", source: "built-in" },
    { rule: `rename(${p})`, verdict: "deny", source: "built-in" },
  ]),
  { rule: "delete(*)", verdict: "ask", source: "built-in" },
  // Installing goes past the package check (F2) and still asks.
  ...["*npm i *", "*npm install *", "*npm add *", "*yarn add *", "*pnpm add *", "*pip install *", "*pip3 install *", "*cargo add *", "*gem install *", "*composer require *", "*go get *"].map(
    (c): PermissionRule => ({ rule: `run(${c})`, verdict: "ask", source: "built-in" }),
  ),
];

const RULE = /^\s*(read|edit|delete|rename|run|\*)\s*\(([\s\S]*)\)\s*$/;

export function parseRule(rule: string): { action: RuleAction | "*"; target: string } | null {
  const m = RULE.exec(rule);
  return m ? { action: m[1] as RuleAction | "*", target: m[2].trim() } : null;
}

const commandRe = (pattern: string) => new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");

function matches(rule: string, action: RuleAction, target: string): boolean {
  const r = parseRule(rule);
  if (!r || (r.action !== "*" && r.action !== action)) return false;
  if (r.target === "*" || r.target === "") return true;
  if (action === "run") return commandRe(r.target).test(target.trim().replace(/\s+/g, " "));
  const one = compileIgnoreLine(r.target);
  return !!one && new IgnoreMatcher([r.target]).ignores(target);
}

export interface RuleDecision {
  verdict: RuleVerdict;
  rule: PermissionRule;
}

/** What the rules say about one action (null: no rule matches; the mode decides). */
export function decideRules(rules: readonly PermissionRule[], action: RuleAction, target: string): RuleDecision | null {
  const hits = rules.filter((r) => matches(r.rule, action, target));
  for (const v of ["deny", "ask", "allow"] as const) {
    const r = hits.find((h) => h.verdict === v);
    if (r) return { verdict: v, rule: r };
  }
  return null;
}

/** A tool call as rule actions (a rename is checked at both ends). */
export function actionsOf(tool: string, args: Record<string, unknown>): { action: RuleAction; target: string }[] {
  const p = (v: unknown) =>
    String(v ?? "")
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "");
  switch (tool) {
    case "list_files":
      return [{ action: "read", target: p(args.under) || "." }];
    case "read_file":
      return [{ action: "read", target: p(args.path) }];
    case "edit_file":
    case "write_file":
      return [{ action: "edit", target: p(args.path) }];
    case "delete_file":
      return [{ action: "delete", target: p(args.path) }];
    case "rename_file":
      return [
        { action: "rename", target: p(args.from) },
        { action: "edit", target: p(args.to) },
      ];
    case "run_command":
      return [{ action: "run", target: String(args.command ?? "") }];
    default:
      return [];
  }
}

/** The strictest verdict for a whole call (deny > ask > allow), with the rule that decided. */
export function decideCall(rules: readonly PermissionRule[], tool: string, args: Record<string, unknown>): RuleDecision | null {
  let best: RuleDecision | null = null;
  const rank = { deny: 0, ask: 1, allow: 2 } as const;
  for (const a of actionsOf(tool, args)) {
    const d = decideRules(rules, a.action, a.target);
    if (d && (!best || rank[d.verdict] < rank[best.verdict])) best = d;
  }
  return best;
}

/** The user's rules from `.tmcode/permissions.json` (unreadable entries dropped; deny/ask/allow only). */
export function parsePermissionsFile(text: string | null): PermissionRule[] {
  if (!text) return [];
  try {
    const j = JSON.parse(text) as { rules?: unknown };
    if (!Array.isArray(j.rules)) return [];
    return j.rules
      .filter((r): r is { rule: string; verdict: RuleVerdict } => !!r && typeof r === "object" && typeof (r as { rule?: unknown }).rule === "string" && ["allow", "ask", "deny"].includes((r as { verdict?: string }).verdict ?? "") && !!parseRule((r as { rule: string }).rule))
      .slice(0, 200)
      .map((r) => ({ rule: r.rule, verdict: r.verdict, source: "user" as const }));
  } catch {
    return [];
  }
}
