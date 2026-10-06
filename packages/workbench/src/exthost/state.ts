import { create } from "zustand";
import type { ExtensionStateDTO, StatusBarEntryDTO } from "@tmcode/exthost";

/** Which extension host runs an extension: Node.js (desktop) or a Web Worker (browser entry points). */
export type HostKind = "node" | "worker";

export interface RuntimeInfo extends Partial<ExtensionStateDTO> {
  id: string;
  host: HostKind;
  /** API members the extension used that TMCode does not support yet. */
  unsupported: string[];
}

export interface ExtHostUiState {
  status: "stopped" | "starting" | "running" | "crashed";
  /** Why extensions with code are not running (no Node.js, exam…). */
  message: string | null;
  /** "Node.js v22.3.0 (/usr/local/bin/node)". */
  nodeInfo: string | null;
  runtime: Record<string, RuntimeInfo>;
  /** Extension id → why its code cannot run here. */
  cannotRun: Record<string, string>;
  /** Bumps on every (re)start. */
  generation: number;
}

export const useExtHost = create<ExtHostUiState>()(() => ({ status: "stopped", message: null, nodeInfo: null, runtime: {}, cannotRun: {}, generation: 0 }));

/** Status bar items contributed by extensions (window.createStatusBarItem, progress). */
export const useExtStatusBar = create<{ items: Record<string, StatusBarEntryDTO & { host: HostKind; progress?: boolean }> }>()(() => ({ items: {} }));

/** `setContext` keys from extensions, for when clauses. */
export const extContextKeys = new Map<string, unknown>();
export const useContextVersion = create<{ v: number }>()(() => ({ v: 0 }));
export function setContextKey(key: string, value: unknown) {
  if (value === undefined || value === null) extContextKeys.delete(key);
  else extContextKeys.set(key, value);
  useContextVersion.setState((s) => ({ v: s.v + 1 }));
}
