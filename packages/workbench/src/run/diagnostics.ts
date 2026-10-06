/**
 * Turns compiler and interpreter output into editor diagnostics, so build
 * errors show up as squiggles and in Problems (plan §8.1).
 */
export interface ParsedDiagnostic {
  /** As printed by the tool (absolute or relative); the caller maps it to a workspace path. */
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  source: string;
}

// gcc / clang:  path/main.c:12:5: error: expected ';' before 'return'
const GCC = /^(.+?):(\d+):(\d+):\s+(fatal error|error|warning):\s+(.*)$/;
// javac:        Main.java:7: error: cannot find symbol
const JAVAC = /^(.+?\.java):(\d+):\s+(error|warning):\s+(.*)$/;
// Go:           ./main.go:5:2: undefined: x
const GO = /^(\S+?\.go):(\d+):(\d+):\s+(.*)$/;
// Rust:         error[E0425]: cannot find value `x` in this scope
//                 --> main.rs:3:5
const RUST_HEAD = /^(error|warning)(?:\[\w+\])?:\s+(.*)$/;
const RUST_AT = /^\s*-->\s+(.+?):(\d+):(\d+)$/;
// Python:       File "/path/main.py", line 4, in <module>
const PY_FRAME = /^\s*File "(.+?)", line (\d+)/;
// Node:         /path/main.js:3
const NODE_LOC = /^(\/.+?\.(?:js|mjs|cjs|ts)|[A-Za-z]:\\.+?\.(?:js|mjs|cjs|ts)):(\d+)$/;

export function parseDiagnostics(output: string): ParsedDiagnostic[] {
  const out: ParsedDiagnostic[] = [];
  const lines = output.split(/\r?\n/);

  for (const l of lines) {
    let m = GCC.exec(l);
    if (m) {
      out.push({ file: m[1], line: +m[2], column: +m[3], severity: m[4] === "warning" ? "warning" : "error", message: m[5], source: "compiler" });
      continue;
    }
    m = JAVAC.exec(l);
    if (m) out.push({ file: m[1], line: +m[2], column: 1, severity: m[3] === "warning" ? "warning" : "error", message: m[4], source: "javac" });
  }
  if (out.length) return out;

  // Rust: a headline, then " --> file:line:col".
  let head: RegExpExecArray | null = null;
  for (const l of lines) {
    const h = RUST_HEAD.exec(l);
    if (h) {
      head = h;
      continue;
    }
    const at = RUST_AT.exec(l);
    if (at && head) {
      out.push({ file: at[1], line: +at[2], column: +at[3], severity: head[1] === "warning" ? "warning" : "error", message: head[2], source: "rustc" });
      head = null;
    }
  }
  if (out.length) return out;

  // Go: "file.go:line:col: message" (after a "# package" header).
  for (const l of lines) {
    const g = GO.exec(l);
    if (g) out.push({ file: g[1], line: +g[2], column: +g[3], severity: "error", message: g[4], source: "go" });
  }
  if (out.length) return out;

  // Python traceback: the last frame + the final "XxxError: message" line.
  const lastLine = [...lines].reverse().find((l) => l.trim());
  let frame: RegExpExecArray | null = null;
  for (const l of lines) {
    const f = PY_FRAME.exec(l);
    if (f && !f[1].startsWith("<")) frame = f;
  }
  if (frame && lastLine && /^\w+(Error|Exception|Interrupt)\b/.test(lastLine.trim())) {
    out.push({ file: frame[1], line: +frame[2], column: 1, severity: "error", message: lastLine.trim(), source: "python" });
    return out;
  }
  // SyntaxError has no "line N, in" frame but a File line just above the caret.
  if (frame && lastLine?.startsWith("SyntaxError")) {
    out.push({ file: frame[1], line: +frame[2], column: 1, severity: "error", message: lastLine.trim(), source: "python" });
    return out;
  }

  // Node: "path:line" then the source line, a caret, and later "XxxError: message".
  for (let i = 0; i < lines.length; i++) {
    const m = NODE_LOC.exec(lines[i].trim());
    if (!m) continue;
    const err = lines.slice(i + 1).find((l) => /^\w*Error\b/.test(l.trim()));
    if (err) out.push({ file: m[1], line: +m[2], column: 1, severity: "error", message: err.trim(), source: "node" });
    break;
  }
  return out;
}

/** Maps a tool-printed path to a workspace path ("" root), or null if it is elsewhere. */
export function toWorkspacePath(file: string, workspaceRoot: string, entryDir: string): string | null {
  const norm = file.replace(/\\/g, "/");
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
  if (root && norm.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return norm.slice(root.length + 1);
  if (/^(\/|[A-Za-z]:\/)/.test(norm)) return null;
  // Relative to the run's working directory (the entry's folder).
  const parts = (entryDir ? `${entryDir}/${norm}` : norm).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "..") stack.pop();
    else if (p && p !== ".") stack.push(p);
  }
  return stack.join("/");
}
