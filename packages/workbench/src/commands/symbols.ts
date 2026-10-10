import { CancellationToken } from "monaco-editor/base/common/cancellation.js";
import { IOutlineModelService } from "monaco-editor/editor/contrib/documentSymbols/browser/outlineModel.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import type { monaco } from "../monaco/setup";

/** Symbols for Quick Open's "@" (the same source as the Outline) and a hook for "#" workspace symbols. */

export interface FlatSymbol {
  name: string;
  kind: number;
  container?: string;
  range: monaco.IRange;
  selectionRange: monaco.IRange;
}

interface Sym {
  name: string;
  kind: number;
  range: monaco.IRange;
  selectionRange: monaco.IRange;
  children?: Sym[];
}

export async function documentSymbols(model: monaco.editor.ITextModel): Promise<FlatSymbol[]> {
  const service = StandaloneServices.get(IOutlineModelService) as { getOrCreate(m: unknown, t: unknown): Promise<{ getTopLevelSymbols(): Sym[] }> };
  const outline = await service.getOrCreate(model, CancellationToken.None);
  const out: FlatSymbol[] = [];
  const walk = (list: Sym[], container?: string) => {
    for (const s of list) {
      out.push({ name: s.name, kind: s.kind, container, range: s.range, selectionRange: s.selectionRange });
      if (s.children?.length) walk(s.children, s.name);
    }
  };
  walk(outline.getTopLevelSymbols());
  return out.sort((a, b) => a.range.startLineNumber - b.range.startLineNumber);
}

export interface WorkspaceSymbol {
  name: string;
  kind: number;
  path: string;
  line: number;
  column: number;
  container?: string;
}

type WorkspaceSymbolProvider = (query: string) => Promise<WorkspaceSymbol[]>;
const providers = new Set<WorkspaceSymbolProvider>();

/** Language support can offer "#" workspace symbols; without a provider Quick Open hides the mode. */
export function registerWorkspaceSymbolProvider(p: WorkspaceSymbolProvider) {
  providers.add(p);
  return () => providers.delete(p);
}
export function hasWorkspaceSymbolProvider() {
  return providers.size > 0;
}
export async function workspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
  const results = await Promise.all([...providers].map((p) => p(query).catch(() => [] as WorkspaceSymbol[])));
  return results.flat();
}
