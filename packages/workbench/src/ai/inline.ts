import { recordActivity, sizeText } from "../activity/log";
import { monaco, setupMonaco } from "../monaco/setup";
import { pathOfUri } from "../monaco/documents";
import { aiGate } from "./gate";
import { completeAt, useAi } from "./service";

/**
 * TMCode AI's ghost text while typing (VS Code's inline suggestions): only when the student turned
 * suggestions on, only when the AI gate allows (Task Mentor's status, the exam policy), after a short pause (Monaco's debounce), at the end of a line or
 * before closing brackets, with the last few answers cached. Tab accepts; the accept is logged.
 */

const cache = new Map<string, string>();
let wired: monaco.IDisposable | null = null;
let quietUntil = 0;

function key(prefix: string, suffix: string) {
  return `${prefix.slice(-400)}\u0000${suffix.slice(0, 80)}`;
}

export function wireInlineSuggestions() {
  if (wired) return;
  setupMonaco();
  type Item = monaco.languages.InlineCompletion & { _tm: { text: string; model: string; path: string } };
  wired = monaco.languages.registerInlineCompletionsProvider(
    { pattern: "**" },
    {
      displayName: "TMCode AI",
      debounceDelayMs: 650,
      async provideInlineCompletions(model, position, context, token) {
        const { suggestions } = useAi.getState();
        const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
        if ((!suggestions && !explicit) || !aiGate().complete || Date.now() < quietUntil) return { items: [] };
        if (model.uri.scheme !== "tmcode") return { items: [] };
        const line = model.getLineContent(position.lineNumber);
        const after = line.slice(position.column - 1);
        // Mid-word or mid-line (other than closing brackets): no suggestion, as Copilot does.
        if (!explicit && after.trim() && !/^[)\]}'"`;,\s]*$/.test(after)) return { items: [] };
        const before = line.slice(0, position.column - 1);
        if (!explicit && !before.trim() && position.lineNumber > 1 && !model.getLineContent(position.lineNumber - 1).trim()) return { items: [] };
        const full = model.getValue();
        const offset = model.getOffsetAt(position);
        const prefix = full.slice(Math.max(0, offset - 6000), offset);
        const suffix = full.slice(offset, offset + 2000);
        if (prefix.trim().length < 8) return { items: [] };
        const k = key(prefix, suffix);
        let text = cache.get(k);
        let modelName = "cached";
        if (text === undefined) {
          try {
            const r = await completeAt({ prefix, suffix, language: model.getLanguageId(), path: pathOfUri(model.uri) });
            if (token.isCancellationRequested) return { items: [] };
            text = r?.text ?? "";
            modelName = r ? `${r.provider} · ${r.model}` : "";
          } catch (e) {
            // Out of allowance or offline: stop asking for a while.
            quietUntil = Date.now() + (/QUOTA|EXHAUSTED/.test(String((e as { code?: string }).code)) ? 30 * 60_000 : 60_000);
            return { items: [] };
          }
          cache.set(k, text);
          if (cache.size > 60) cache.delete(cache.keys().next().value!);
        }
        if (!text) return { items: [] };
        const item: Item = { insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), _tm: { text, model: modelName, path: pathOfUri(model.uri) } };
        return { items: [item] };
      },
      handleEndOfLifetime(_list, item, reason) {
        if (reason.kind !== monaco.languages.InlineCompletionEndOfLifeReasonKind.Accepted) return;
        const t = (item as Item)._tm;
        recordActivity({
          kind: "ai",
          action: "suggestion",
          path: t.path,
          text: `Accepted a suggestion from TMCode AI (${sizeText(t.text)})`,
          data: { chars: t.text.length, lines: t.text.split("\n").length },
          actor: { type: "tmcode-ai" },
          ai: { by: "TMCode AI", how: "inline suggestion accepted", model: t.model },
        });
      },
      handlePartialAccept(_list, item, accepted) {
        const t = (item as Item)._tm;
        recordActivity({
          kind: "ai",
          action: "suggestion",
          path: t.path,
          text: `Accepted part of a suggestion from TMCode AI (${accepted} characters)`,
          data: { chars: accepted, partial: true },
          actor: { type: "tmcode-ai" },
          ai: { by: "TMCode AI", how: "inline suggestion, partly accepted", model: t.model },
        });
      },
      disposeInlineCompletions() {},
    },
  );
}
