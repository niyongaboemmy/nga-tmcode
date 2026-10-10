import type { Policy } from "@tmcode/protocol";
import type { LanguageServerId } from "../platform/types";

/**
 * The language servers TMCode can run itself (review V4), so Python and Java
 * students get Go to Definition, errors and real completions without
 * installing an extension. Pure data and rules (unit tested).
 */

export interface ServerSpec {
  id: LanguageServerId;
  label: string;
  /** Monaco language ids it serves. */
  languages: string[];
  /** What it runs on: Node.js (TMCode finds it like any toolchain) or a JDK 17+. */
  runtime: "node" | "jdk";
  /** False: planned, not built in yet (docs/LANGUAGE_SERVERS.md). */
  builtIn: boolean;
  /** One line for the download offer. */
  offer: string;
}

export const SERVERS: ServerSpec[] = [
  {
    id: "pyright",
    label: "Pyright",
    languages: ["python"],
    runtime: "node",
    builtIn: true,
    offer: "Python IntelliSense (errors, Go to Definition, completions) needs Pyright, about 6 MB. Download it?",
  },
  {
    id: "jdtls",
    label: "Java language server",
    languages: ["java"],
    runtime: "jdk",
    builtIn: false,
    offer: "",
  },
];

export function serverFor(languageId: string): ServerSpec | null {
  return SERVERS.find((s) => s.builtIn && s.languages.includes(languageId)) ?? null;
}

/**
 * May a server run? Always in practice; in an exam only when the teacher's
 * policy gives the editor diagnostics or full intelligence. ("basic" means
 * words and snippets only: a language server would give away more.)
 */
export function serverAllowed(policy: Pick<Policy, "mode" | "intelligence">): boolean {
  if (policy.mode === "practice") return true;
  return policy.intelligence === "diagnostics" || policy.intelligence === "full";
}

/** Servers are downloaded only outside exams (an exam never reaches the internet for tools). */
export function downloadAllowed(policy: Pick<Policy, "mode">): boolean {
  return policy.mode === "practice";
}

/**
 * Pyright's settings, answered to `workspace/configuration`. Like Pylance's
 * defaults in VS Code: type checking off (syntax, undefined names and missing
 * imports still reported), open files only. A pyrightconfig.json or
 * [tool.pyright] in pyproject.toml overrides them, as in VS Code.
 */
export function pyrightSettings(python: string | null): Record<string, unknown> {
  return {
    python: {
      ...(python ? { pythonPath: python } : {}),
      analysis: {
        typeCheckingMode: "off",
        diagnosticMode: "openFilesOnly",
        autoSearchPaths: true,
        useLibraryCodeForTypes: true,
        autoImportCompletions: true,
      },
    },
    pyright: { disableLanguageServices: false, disableOrganizeImports: false },
  };
}

/** One `workspace/configuration` item: the dotted section of `settings` (null when absent). */
export function configurationSection(settings: Record<string, unknown>, section: string | undefined): unknown {
  if (!section) return settings;
  let cur: unknown = settings;
  for (const key of section.split(".")) {
    if (!cur || typeof cur !== "object" || !(key in (cur as Record<string, unknown>))) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
