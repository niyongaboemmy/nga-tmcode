import type { DiagnosticDTO } from "@tmcode/exthost";
import { pathOfUri } from "../monaco/documents";
import { monaco } from "../monaco/setup";

/**
 * The workbench's own problems (Monaco's TypeScript/CSS/JSON/HTML workers,
 * run errors) for extensions: VS Code's languages.getDiagnostics() includes
 * the built-in extensions' diagnostics, and Error Lens, Problems-style views
 * and linters' "fix all" read them. Extension diagnostics (owner "ext:…")
 * already live in the host and are not sent back.
 */

const SEVERITY: Record<number, number> = { 8: 0, 4: 1, 2: 2, 1: 3 }; // Monaco MarkerSeverity → vscode.DiagnosticSeverity

export function toDiagnosticDTO(m: monaco.editor.IMarker): DiagnosticDTO {
  const d: DiagnosticDTO = {
    range: [m.startLineNumber - 1, m.startColumn - 1, m.endLineNumber - 1, m.endColumn - 1] as DiagnosticDTO["range"],
    message: m.message,
    severity: SEVERITY[m.severity] ?? 0,
    source: m.source || m.owner,
  };
  const code = typeof m.code === "object" && m.code ? m.code.value : m.code;
  if (code !== undefined && code !== "") d.code = code;
  if (m.tags?.length) d.tags = [...m.tags];
  return d;
}

function entriesFor(uris: readonly monaco.Uri[]): [string, DiagnosticDTO[]][] {
  return uris
    .filter((u) => u.scheme === "tmcode")
    .map((u) => [pathOfUri(u), monaco.editor.getModelMarkers({ resource: u }).filter((m) => !m.owner.startsWith("ext:")).map(toDiagnosticDTO)]);
}

export function workbenchDiagnosticsSnapshot(): [string, DiagnosticDTO[]][] {
  const uris = new Map<string, monaco.Uri>();
  for (const m of monaco.editor.getModelMarkers({})) if (!m.owner.startsWith("ext:")) uris.set(m.resource.toString(), m.resource);
  return entriesFor([...uris.values()]).filter(([, l]) => l.length);
}

let wired = false;
export function wireWorkbenchDiagnostics(broadcast: (method: string, params: unknown[]) => void) {
  if (wired) return;
  wired = true;
  let pending = new Map<string, monaco.Uri>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  monaco.editor.onDidChangeMarkers((uris) => {
    for (const u of uris) pending.set(u.toString(), u);
    if (timer) return;
    // Markers arrive in bursts (a worker validating several files): send them together.
    timer = setTimeout(() => {
      timer = null;
      const batch = entriesFor([...pending.values()]);
      pending = new Map();
      if (batch.length) broadcast("$workbenchDiagnostics", [batch]);
    }, 150);
  });
}
