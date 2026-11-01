import type { FileSystem } from "../../platform/types";

/**
 * Project rules (proposal B2, O7): `AGENTS.md` is the one source of instructions for every AI that
 * works on the project. The root file applies everywhere; a nested `AGENTS.md` applies to its folder
 * and below, and the nearest one is listed last (it wins where they disagree), as Cursor's CLI and
 * the AGENTS.md convention do. `CLAUDE.md` / `GEMINI.md` are read too when there is no AGENTS.md in
 * that folder, so a project set up for one vendor still works.
 */

export const RULE_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;
const MAX_RULES = 12_000;

/** The folders from the root down to `path`'s folder ("" is the root). */
export function foldersOf(path: string | null): string[] {
  const parts = (path ?? "").split("/").slice(0, -1);
  const out = [""];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(0, i + 1).join("/"));
  return out;
}

export interface RulesFound {
  files: string[];
  text: string;
}

/** The rules that apply to `activePath` (root first, nearest last), cut to a budget. */
export async function projectRules(fs: FileSystem, activePath: string | null): Promise<RulesFound> {
  const files: string[] = [];
  const parts: string[] = [];
  for (const dir of foldersOf(activePath)) {
    for (const name of RULE_FILES) {
      const path = dir ? `${dir}/${name}` : name;
      const text = await fs.readFile(path).catch(() => null);
      if (text === null || !text.trim()) continue;
      files.push(path);
      parts.push(`From ${path}:\n${text.trim()}`);
      break; // one rules file per folder: AGENTS.md first
    }
  }
  let text = parts.join("\n\n");
  if (text.length > MAX_RULES) text = `${text.slice(0, MAX_RULES)}\n… (rules cut: keep AGENTS.md short)`;
  return { files, text };
}
