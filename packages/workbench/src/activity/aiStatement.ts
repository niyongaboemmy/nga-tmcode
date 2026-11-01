import type { ActivityEvent } from "./log";

/**
 * The automatic AI-use statement (proposal I4; CSTA: assessment needs process evidence): what the
 * Activity log says about AI in this work, as facts a teacher can check, never a guess or an
 * "AI-likelihood" score. It names the layers the work was done in and counts each kind of help.
 */

export interface AiUse {
  layers: string[];
  questions: number;
  suggestions: number;
  agentChanges: number;
  filesChangedByAi: number;
  appliedFromChat: number;
  filtered: number;
  copyBlocked: number;
  explained: number;
  aiTools: string[];
}

export function summariseAiUse(events: readonly ActivityEvent[]): AiUse {
  const u: AiUse = { layers: [], questions: 0, suggestions: 0, agentChanges: 0, filesChangedByAi: 0, appliedFromChat: 0, filtered: 0, copyBlocked: 0, explained: 0, aiTools: [] };
  const layers = new Set<string>();
  const tools = new Set<string>();
  const files = new Set<string>();
  for (const e of events) {
    if (e.kind === "ai" && e.action === "layer" && typeof e.data?.to === "string") layers.add(String(e.data.to));
    if (e.kind === "ai" && e.action === "chat") {
      u.questions++;
      if (typeof e.data?.layer === "string") layers.add(String(e.data.layer));
    }
    if (e.kind === "ai" && e.action === "suggestion") u.suggestions++;
    if (e.kind === "ai" && e.action === "agent") {
      u.agentChanges++;
      for (const f of String(e.data?.files ?? "").split(", ").filter(Boolean)) files.add(f);
    }
    if (e.kind === "ai" && e.action === "apply") u.appliedFromChat++;
    if (e.kind === "ai" && e.action === "filtered") u.filtered += Number(e.data?.removed ?? 1);
    if (e.kind === "ai" && e.action === "copy-blocked") u.copyBlocked++;
    if (e.kind === "ai" && e.action === "explained") u.explained++;
    if (e.ai?.by && e.ai.by !== "TMCode AI") tools.add(e.ai.by.replace(/^terminal: /, ""));
  }
  u.layers = [...layers];
  u.aiTools = [...tools].slice(0, 8);
  u.filesChangedByAi = files.size;
  return u;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const LAYER_NAME: Record<string, string> = { exam: "No AI", learning: "Learning", industrial: "Industrial" };

/** The statement in plain words (one paragraph). */
export function aiUseStatement(u: AiUse): string {
  const used = u.questions + u.suggestions + u.agentChanges + u.appliedFromChat + u.aiTools.length;
  if (!used) return "AI use: none recorded in TMCode for this work.";
  const parts: string[] = [];
  if (u.questions) parts.push(plural(u.questions, "question") + " to TMCode AI");
  if (u.suggestions) parts.push(plural(u.suggestions, "suggestion") + " accepted while typing");
  if (u.appliedFromChat) parts.push(plural(u.appliedFromChat, "answer") + " applied from the chat");
  if (u.agentChanges) parts.push(`${plural(u.agentChanges, "agent request")} that changed ${plural(u.filesChangedByAi, "file")}`);
  if (u.aiTools.length) parts.push(`other AI tools: ${u.aiTools.join(", ")}`);
  const extra: string[] = [];
  if (u.filtered) extra.push(`the Learning filter removed ${plural(u.filtered, "line")} of code`);
  if (u.copyBlocked) extra.push(`${plural(u.copyBlocked, "copy", "copies")} of code from the AI panel ${u.copyBlocked === 1 ? "was" : "were"} blocked`);
  if (u.explained) extra.push(`${plural(u.explained, "AI change")} explained by the student`);
  const layers = u.layers.length ? ` Layers: ${u.layers.map((l) => LAYER_NAME[l] ?? l).join(", ")}.` : "";
  return `AI use (from the Activity log): ${parts.join("; ")}.${extra.length ? ` Also: ${extra.join("; ")}.` : ""}${layers}`;
}
