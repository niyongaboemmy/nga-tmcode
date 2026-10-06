/**
 * Activation events (https://code.visualstudio.com/api/references/activation-events).
 * TMCode supports `*`, `onStartupFinished`, `onLanguage:<id>` (and bare
 * `onLanguage`), `onCommand:<id>` and `workspaceContains:<glob>`, plus the
 * implicit events VS Code 1.74+ derives from contributions (every contributed
 * command and language). Other events (onView, onDebug, onUri…) never fire.
 */

export interface ManifestLike {
  activationEvents?: unknown;
  contributes?: { commands?: unknown; languages?: unknown } & Record<string, unknown>;
  main?: unknown;
  browser?: unknown;
}

export const SUPPORTED_EVENTS = ["*", "onStartupFinished", "onLanguage", "onCommand", "workspaceContains"] as const;

const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/** Explicit events plus the implicit ones of contributed commands and languages. */
export function activationEventsOf(manifest: ManifestLike): string[] {
  const out = new Set<string>();
  if (Array.isArray(manifest.activationEvents)) for (const e of manifest.activationEvents) if (typeof e === "string" && e) out.add(e);
  const c = manifest.contributes ?? {};
  for (const cmd of list(c.commands)) if (typeof cmd.command === "string") out.add(`onCommand:${cmd.command}`);
  for (const lang of list(c.languages)) if (typeof lang.id === "string") out.add(`onLanguage:${lang.id}`);
  return [...out];
}

/** Does `event` (as fired: "onLanguage:python", "onCommand:x.y", "*") activate an extension with these events? */
export function matchesActivationEvent(events: readonly string[], event: string): boolean {
  if (events.includes(event)) return true;
  // A bare "onLanguage" activates for any language.
  if (event.startsWith("onLanguage:") && events.includes("onLanguage")) return true;
  return false;
}

/** Fired once at startup, in this order. */
export const STARTUP_EVENTS = ["*", "onStartupFinished"] as const;

/** The globs of `workspaceContains:` events. */
export function workspaceContainsPatterns(events: readonly string[]): string[] {
  return events.filter((e) => e.startsWith("workspaceContains:")).map((e) => e.slice("workspaceContains:".length)).filter(Boolean);
}

/** Events TMCode never fires (shown on the extension's Runtime Status). */
export function unsupportedEvents(events: readonly string[]): string[] {
  return events.filter((e) => !SUPPORTED_EVENTS.some((s) => e === s || e.startsWith(s + ":")));
}
