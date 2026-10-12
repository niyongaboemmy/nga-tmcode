import type { GuideId } from "../debug/installGuide";
import { toolsForPath } from "../debug/installGuide";
import type { RunAction } from "./projectKind";

/** The detected tool (toolchains.rs TOOLS) a command's first word needs, and the guide that installs it. */
const COMMAND_TOOLS: Record<string, { tool: string; guide: GuideId }> = {
  python: { tool: "python", guide: "python" },
  python3: { tool: "python", guide: "python" },
  py: { tool: "python", guide: "python" },
  node: { tool: "node", guide: "node" },
  npm: { tool: "node", guide: "node" },
  npx: { tool: "node", guide: "node" },
  java: { tool: "java", guide: "java" },
  javac: { tool: "javac", guide: "java" },
  go: { tool: "go", guide: "go" },
  rustc: { tool: "rustc", guide: "rust" },
  php: { tool: "php", guide: "php" },
  ruby: { tool: "ruby", guide: "ruby" },
  irb: { tool: "ruby", guide: "ruby" },
  kotlinc: { tool: "kotlinc", guide: "kotlin" },
  dotnet: { tool: "dotnet", guide: "csharp" },
  dart: { tool: "dart", guide: "dart" },
  swift: { tool: "swift", guide: "swift" },
};

const TOOL_GUIDE: Record<string, GuideId> = { python: "python", node: "node", cc: "c", cxx: "cpp", javac: "java", java: "java", go: "go", rustc: "rust", php: "php", ruby: "ruby", kotlinc: "kotlin", dotnet: "csharp", dart: "dart", swift: "swift" };

/** What must be installed for `a` to run: [tool, guide] pairs (empty: nothing TMCode can check). */
export function toolsForAction(a: RunAction): { tool: string; guide: GuideId }[] {
  if (a.kind === "runFile" && a.entry) {
    return toolsForPath(a.entry)
      .filter((t) => TOOL_GUIDE[t])
      .map((tool) => ({ tool, guide: TOOL_GUIDE[tool] }));
  }
  if ((a.kind === "task" || a.kind === "devServer" || a.kind === "repl") && a.command) {
    // Every command of a chain ("kotlinc … && java -jar …"), first words only.
    const words = a.command.split(/&&|\|\||;/).map((c) => c.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, "").toLowerCase() ?? "");
    const out: { tool: string; guide: GuideId }[] = [];
    for (const w of words) {
      const hit = COMMAND_TOOLS[w];
      if (hit && !out.some((o) => o.tool === hit.tool)) out.push(hit);
    }
    return out;
  }
  return [];
}

/** The first missing tool for `a`, given the tools found on this computer (null: ready to run). */
export function missingFor(a: RunAction, detected: string[]): { tool: string; guide: GuideId } | null {
  const have = new Set(detected);
  return toolsForAction(a).find((t) => !have.has(t.tool)) ?? null;
}
