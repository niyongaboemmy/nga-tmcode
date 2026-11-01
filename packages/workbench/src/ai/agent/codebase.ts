import type { FileSystem } from "../../platform/types";
import { listFiles } from "../../parts/search/search";
import { aiMaySee } from "./guard";

/**
 * Codebase understanding (proposal G7; Cursor's Instant Grep + Explore, Aider's repo map): a
 * local index of the project's definitions, built on demand from the files themselves. Nothing is
 * embedded or sent anywhere: the agent asks for `repo_map` (files ranked by how much the rest of
 * the project uses them, with their top-level definitions) and `find_symbol` (where a name is
 * defined and used). Files kept from AI (ignore list, secrets, teacher-hidden) are never indexed.
 */

export interface SymbolDef {
  name: string;
  kind: "function" | "class" | "type" | "variable" | "method";
  line: number;
}

const MAX_FILE = 200_000;
const MAX_FILES = 400;

/** Definition patterns per language family (the start of a line; good enough for a map). */
const PATTERNS: { exts: RegExp; rules: { re: RegExp; kind: SymbolDef["kind"] }[] }[] = [
  {
    exts: /\.(m?[jt]sx?|cjs|vue|svelte)$/,
    rules: [
      { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, kind: "function" },
      { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
      { re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: "type" },
      { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: "function" },
      { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "variable" },
    ],
  },
  {
    exts: /\.py$/,
    rules: [
      { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
      { re: /^\s+(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "method" },
      { re: /^class\s+([A-Za-z_]\w*)/, kind: "class" },
      { re: /^([A-Z][A-Z0-9_]+)\s*=/, kind: "variable" },
    ],
  },
  {
    exts: /\.(java|kt|kts|cs|swift|dart|scala)$/,
    rules: [
      { re: /^\s*(?:public|private|protected|internal|open|sealed|abstract|final|static|data|\s)*(?:class|interface|enum|record|struct|object|protocol)\s+([A-Za-z_]\w*)/, kind: "class" },
      { re: /^\s*(?:public|private|protected|internal|static|final|override|suspend|async|virtual|abstract|\s)*(?:fun|func|void|[A-Za-z_<>[\],?]+)\s+([a-zA-Z_]\w*)\s*\([^;]*$/, kind: "method" },
    ],
  },
  {
    exts: /\.go$/,
    rules: [
      { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
      { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: "type" },
    ],
  },
  {
    exts: /\.rs$/,
    rules: [
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/, kind: "type" },
    ],
  },
  {
    exts: /\.(c|h|cc|cpp|hpp|ino)$/,
    rules: [
      { re: /^(?:static\s+|inline\s+|extern\s+)*[A-Za-z_][\w\s*&:<>]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, kind: "function" },
      { re: /^\s*(?:class|struct|enum)\s+([A-Za-z_]\w*)/, kind: "class" },
    ],
  },
  {
    exts: /\.php$/,
    rules: [
      { re: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/, kind: "function" },
      { re: /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/, kind: "class" },
    ],
  },
  {
    exts: /\.rb$/,
    rules: [
      { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, kind: "method" },
      { re: /^\s*(?:class|module)\s+([A-Z]\w*)/, kind: "class" },
    ],
  },
  {
    exts: /\.sql$/i,
    rules: [{ re: /^\s*create\s+(?:or\s+replace\s+)?(?:table|view|function|procedure)\s+(?:if\s+not\s+exists\s+)?[`"[]?([A-Za-z_]\w*)/i, kind: "type" }],
  },
];

const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "new", "else", "main"]);

/** The definitions in one file (by its extension). */
export function symbolsOf(path: string, text: string): SymbolDef[] {
  const family = PATTERNS.find((p) => p.exts.test(path));
  if (!family) return [];
  const out: SymbolDef[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < 200; i++) {
    for (const r of family.rules) {
      const m = r.re.exec(lines[i]);
      if (m && m[1] && !NOT_NAMES.has(m[1])) {
        out.push({ name: m[1], kind: r.kind, line: i + 1 });
        break;
      }
    }
  }
  return out;
}

interface Indexed {
  path: string;
  text: string;
  symbols: SymbolDef[];
}

async function index(fs: FileSystem, under = ""): Promise<Indexed[]> {
  const files = (await listFiles(fs)).filter((p) => aiMaySee(p) && (!under || p.startsWith(`${under.replace(/\/$/, "")}/`))).slice(0, MAX_FILES);
  const out: Indexed[] = [];
  for (const path of files) {
    const text = await fs.readFile(path).catch(() => null);
    if (text === null || text.length > MAX_FILE || text.includes("\u0000")) continue;
    out.push({ path, text, symbols: symbolsOf(path, text) });
  }
  return out;
}

const wordRe = (name: string) => new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`, "g");

/**
 * The project as a ranked map: files ordered by how often the rest of the project names their
 * definitions, each with its definitions (line numbers), cut to `budget` characters.
 */
export async function repoMap(fs: FileSystem, under = "", budget = 8000): Promise<string> {
  const files = await index(fs, under);
  if (!files.length) return "(no files)";
  const scored = files.map((f) => {
    let score = 0;
    for (const s of f.symbols.slice(0, 40)) {
      if (s.name.length < 3) continue;
      const re = wordRe(s.name);
      for (const o of files) if (o !== f) score += (o.text.match(re) ?? []).length;
    }
    return { f, score };
  });
  scored.sort((a, b) => b.score - a.score || a.f.path.localeCompare(b.f.path));
  const lines: string[] = [];
  let used = 0;
  for (const { f, score } of scored) {
    const defs = f.symbols.slice(0, 12).map((s) => `${s.kind} ${s.name} :${s.line}`);
    const entry = `${f.path}${score ? ` (used ${score}×)` : ""}${defs.length ? `\n  ${defs.join("\n  ")}` : ""}`;
    if (used + entry.length > budget) {
      lines.push(`… ${scored.length - lines.length} more files (ask for a folder with \`under\`)`);
      break;
    }
    lines.push(entry);
    used += entry.length + 1;
  }
  return lines.join("\n");
}

/** Where `name` is defined and where it is used (file:line: text). */
export async function findSymbol(fs: FileSystem, name: string, max = 60): Promise<string> {
  const n = name.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(n)) return "Give one identifier (letters, digits, _ or $).";
  const files = await index(fs);
  const defs: string[] = [];
  const uses: string[] = [];
  const re = wordRe(n);
  for (const f of files) {
    for (const s of f.symbols) if (s.name === n) defs.push(`${f.path}:${s.line}: ${s.kind} ${n}`);
    const lines = f.text.split("\n");
    for (let i = 0; i < lines.length && uses.length < max; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i]) && !f.symbols.some((s) => s.name === n && s.line === i + 1)) uses.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
    }
  }
  if (!defs.length && !uses.length) return `No definition or use of ${n} in the project.`;
  return `Defined:\n${defs.join("\n") || "(not found: it may come from a library)"}\n\nUsed (${uses.length}${uses.length >= max ? "+" : ""}):\n${uses.join("\n")}`;
}
