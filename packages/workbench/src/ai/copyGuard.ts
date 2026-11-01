import { looksLikeCode } from "@tmcode/protocol";
import { recordActivity, sizeText } from "../activity/log";
import { notify } from "../state/store";
import { aiGate } from "./gate";

/**
 * Learning's copy guard (proposal §8.3, layer 4): text that looks like code can't be copied out of
 * the AI panel while the layer is Learning; each attempt is logged, so the teacher sees attempts to
 * extract code. Prose copies freely. Industrial copies are allowed (and logged where they were).
 */

/** Any line of `text` that reads as code (the same test as the Learning filter). */
export function codeLikeText(text: string): boolean {
  return text.split("\n").some((l) => looksLikeCode(l));
}

/** May `text` be copied out of the AI panel now? Logs and explains a refusal. */
export function allowAiCopy(text: string, where = "TMCode AI's answer"): boolean {
  if (aiGate().copyCode || !codeLikeText(text)) return true;
  recordActivity({
    kind: "ai",
    action: "copy-blocked",
    text: `Learning: copying code from ${where} was blocked (${sizeText(text)})`,
    data: { chars: text.length },
    actor: { type: "you" },
    ai: { by: "TMCode AI", how: "copy of code blocked (Learning)" },
  });
  notify("info", "Learning: you write every line, so code can't be copied from the AI panel. Ask the tutor for the next hint instead.");
  return false;
}
