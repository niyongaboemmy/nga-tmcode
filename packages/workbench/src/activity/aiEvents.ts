import { useExtensions } from "../extensions/service";
import { activeFilePath } from "../state/store";
import { aiExtensionName, isAiExtension } from "./aiExtensions";
import { isBookkeepingPath, markWritten } from "./fsRecorder";
import { aiOf, recordActivity, sizeText, updateActivity, useActivityLog, type Actor } from "./log";
import { recordTerminalCommand } from "./sources";

/**
 * AI use that happens inside the editor rather than on disk: ghost-text suggestions accepted
 * from an extension's inline completion provider, and the actor for anything an AI extension
 * does through the extension host (edits, file writes, terminal commands).
 */

function manifestOf(id: string) {
  return useExtensions.getState().installed.find((e) => e.id === id.toLowerCase())?.manifest ?? null;
}

/** The actor for an extension's request: AI extensions are named as AI tools. */
export function extensionActor(id: string): Actor {
  const m = manifestOf(id);
  const ai = isAiExtension(id, m);
  return { type: "extension", id, name: ai ? aiExtensionName(id, m) : (m?.displayName ?? id), ai };
}

/**
 * A suggestion was accepted (Tab, or a word/line of it). Inline completions are AI suggestions
 * in practice (Gemini, Codeium, Continue, Copilot…), so they're recorded as AI use whatever the
 * extension's category says.
 */
export function inlineAccepted(extensionId: string, text: string, partial: boolean) {
  if (!text) return;
  const m = manifestOf(extensionId);
  const by = extensionId ? aiExtensionName(extensionId, m) : "an extension";
  const path = activeFilePath() ?? undefined;
  recordActivity({
    kind: "ai",
    action: "suggestion",
    path,
    text: `Accepted ${partial ? "part of " : ""}a suggestion from ${by} (${sizeText(text)})`,
    data: { chars: text.length, lines: text.split("\n").length, partial, extension: extensionId },
    actor: { type: "extension", id: extensionId, name: by, ai: true },
    ai: { by, how: partial ? "inline suggestion, partly accepted" : "inline suggestion accepted" },
  });
}

// ── what extensions do through the extension host ──

interface EditLike {
  path: string;
  edits: { text: string; range: [number, number, number, number] }[];
}

/** The text edits of a workspace edit, by file. */
export function workspaceEditTexts(dto: { entries: { kind: string; path: string; edit?: { text: string; range: [number, number, number, number] } }[] }): EditLike[] {
  const by = new Map<string, EditLike>();
  for (const e of dto.entries) {
    if (e.kind !== "text" || !e.edit) continue;
    if (!by.has(e.path)) by.set(e.path, { path: e.path, edits: [] });
    by.get(e.path)!.edits.push(e.edit);
  }
  return [...by.values()];
}

/** An AI extension's edits to one file in a row (streamed answers) are one entry that grows. */
const STREAM_MS = 30_000;
const lastEdit = new Map<string, { id: number; t: number; chars: number; lines: number; count: number }>();

/**
 * An extension edited files in the editor. AI extensions' edits are AI use ("Claude Code edited
 * app.js"); other extensions' edits (formatters, refactorings the user asked for) aren't recorded
 * one by one: the save that follows is.
 */
export function extensionEdited(extensionId: string, files: EditLike[]) {
  const actor = extensionActor(extensionId);
  if (actor.type !== "extension" || !actor.ai) return;
  for (const f of files) {
    const chars = f.edits.reduce((n, e) => n + e.text.length, 0);
    const lines = f.edits.reduce((n, e) => n + (e.text ? e.text.split("\n").length : 0), 0);
    const removed = f.edits.reduce((n, e) => n + Math.max(0, e.range[2] - e.range[0]), 0);
    const key = `${extensionId}|${f.path}`;
    const prev = lastEdit.get(key);
    const name = f.path.slice(f.path.lastIndexOf("/") + 1);
    if (prev && Date.now() - prev.t < STREAM_MS && useActivityLog.getState().events.some((e) => e.id === prev.id)) {
      prev.t = Date.now();
      prev.chars += chars;
      prev.lines += lines;
      prev.count++;
      updateActivity(prev.id, { t: prev.t, text: `${actor.name} edited ${name} (${prev.count} changes, ${prev.chars} characters written)`, data: { chars: prev.chars, lines: prev.lines, changes: prev.count } });
      continue;
    }
    const e = recordActivity({
      kind: "ai",
      action: "edit",
      path: f.path,
      text: `${actor.name} edited ${name} (${chars} characters written${removed ? `, ${removed} lines replaced` : ""})`,
      data: { chars, lines, changes: 1 },
      actor,
      ai: { by: actor.name, how: "edited the file in the editor" },
    });
    if (e) lastEdit.set(key, { id: e.id, t: e.t, chars, lines, count: 1 });
  }
}

/** File writes and terminal commands an extension made itself (Node host). */
export function extensionActivity(extensionId: string, data: Record<string, unknown>) {
  const actor = extensionActor(extensionId);
  if (data.kind === "terminal") {
    recordTerminalCommand(String(data.command ?? ""), typeof data.terminal === "string" ? data.terminal : null, actor);
    return;
  }
  if (data.kind !== "fs" || typeof data.path !== "string") return;
  const path = data.path;
  const to = typeof data.to === "string" ? data.to : undefined;
  markWritten([path, ...(to ? [to] : [])]);
  if (isBookkeepingPath(path)) return;
  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const op = String(data.op);
  const text =
    op === "create"
      ? `${actor.type === "extension" ? actor.name : "An extension"} created ${name(path)}`
      : op === "write"
        ? `${actor.type === "extension" ? actor.name : "An extension"} wrote ${name(path)}`
        : op === "delete"
          ? `${actor.type === "extension" ? actor.name : "An extension"} deleted ${name(path)}`
          : op === "rename"
            ? `${actor.type === "extension" ? actor.name : "An extension"} renamed ${name(path)} to ${name(to ?? "")}`
            : `${actor.type === "extension" ? actor.name : "An extension"} copied ${name(path)} to ${to ?? ""}`;
  recordActivity({
    kind: "file",
    action: op === "write" ? "save" : op,
    path,
    to,
    text,
    data: typeof data.chars === "number" ? { chars: data.chars } : undefined,
    actor,
    ai: aiOf(actor, op === "create" ? "created the file" : op === "delete" ? "deleted the file" : op === "rename" ? "renamed the file" : "wrote the file"),
  });
}
