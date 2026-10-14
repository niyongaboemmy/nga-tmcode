import type { TerminalEnvMutation } from "../platform/types";

/**
 * Extensions' environmentVariableCollection: every new terminal gets these changes, as in
 * VS Code (Claude Code sets CLAUDE_CODE_SSE_PORT so `claude` in any terminal finds TMCode).
 */

const byExtension = new Map<string, TerminalEnvMutation[]>();

export function setExtensionEnv(extensionId: string, mutations: TerminalEnvMutation[]) {
  if (mutations.length) byExtension.set(extensionId, mutations);
  else byExtension.delete(extensionId);
}

/** A host stopped: its extensions' changes go with it. */
export function clearExtensionEnv(ids?: string[]) {
  if (!ids) byExtension.clear();
  else for (const id of ids) byExtension.delete(id);
}

export function terminalEnv(extra: TerminalEnvMutation[] = []): TerminalEnvMutation[] {
  return [...[...byExtension.values()].flat(), ...extra];
}
