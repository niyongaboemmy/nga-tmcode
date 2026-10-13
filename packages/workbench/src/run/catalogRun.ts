/**
 * Running a file on the student's own computer from the Runtime Catalog (`@nga/runtimes`): the
 * catalog says which kind a file is (`haskell/single`, `zig/single`…) and how the code runner builds
 * and runs it. TMCode turns those steps into a command for the student's terminal: the tool by its
 * own name (found on PATH), the file names in place of the catalog's tokens, and build output in
 * TMCode's own `.tmcode/build` folder (never saved to Task Mentor). Pure.
 */
import { detect, KINDS, RUNTIMES, type KindDef, type Step, type Token } from "@nga/runtimes";

/** Where a terminal run's build output goes, next to the file (TMCode's folder, never synced). */
export const BUILD_DIR = ".tmcode/build";

const ext = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
export type Os = "mac" | "windows" | "linux";
/** Single quotes: literal in bash, zsh and PowerShell alike (no `$` expansion). */
const quoter = (os: Os) => (s: string) => (/^[\w./:@=+-]+$/.test(s) ? s : os === "windows" ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`);
let quote = quoter("mac");

/**
 * The catalog's single-file kind for a file (`main.adb` → `ada/single`), or null. `read` (the
 * file's text) separates languages that share an extension: Prolog vs Perl `.pl`, Octave vs
 * Objective-C `.m`, V vs Verilog `.v`.
 */
export function fileKind(name: string, read?: string | null): KindDef | null {
  const ranked = detect([name], read == null ? undefined : () => read);
  for (const r of ranked) {
    const k = KINDS.find((x) => x.id === r.kind);
    // A single file: no build file needed at the root (not `*/maven`, `*/cargo`…), and something to run.
    if (k && !k.detect.files?.length && k.steps.run && k.tier !== "browser") return k;
  }
  return null;
}

/** One catalog step as a command line, or null when it needs the code runner's own setup. */
function stepLine(kind: KindDef, step: Step, entry: string, folderFiles: string[]): string | null {
  // The code runner's own helper scripts (e.g. NASM's link wrapper) don't exist on a student's computer.
  const runtime = RUNTIMES.find((r) => r.id === kind.runtime);
  if (runtime?.tools[step.tool]?.startsWith("/usr/local/lib/nga/")) return null;
  const stem = entry.replace(/\.[^.]+$/, "");
  const parts: string[] = [];
  let args = step.args;
  let tool = step.tool;
  // `stdbuf -oL prog` keeps output flowing on the runner's pipes; a terminal already does that.
  if (tool === "stdbuf") {
    args = args.filter((a) => typeof a !== "string" || !/^-[oei][L0]$/.test(a));
    const [first, ...rest] = args;
    const prog = tokenText(first, entry, stem, folderFiles);
    if (prog == null) return null;
    tool = prog;
    args = rest;
  }
  parts.push(tool);
  for (const a of args) {
    const t = tokenText(a, entry, stem, folderFiles);
    if (t == null) return null;
    if (t !== "") parts.push(t);
  }
  return parts.join(" ");
}

function tokenText(a: Token | undefined, entry: string, stem: string, folderFiles: string[]): string | null {
  if (a === undefined) return null;
  if (typeof a === "string") {
    // The runner's scratch folder becomes TMCode's; its other absolute paths (system jars, headers) don't exist here.
    const local = a.replace(/(^|[:=]|^-[A-Za-z]+)\/tmp(?=\/|$)/g, `$1${BUILD_DIR}/tmp`);
    if (/(^|[:=]|-I)\/(usr|opt|etc|var)\//.test(local)) return null;
    return quote(local);
  }
  if ("entry" in a) return quote(entry);
  if ("entry_stem" in a) return quote(stem);
  if ("out" in a) return `${a.prefix ?? ""}${quote(`${BUILD_DIR}/${a.out}`)}`;
  if ("sources" in a) {
    const exts = Array.isArray(a.sources) ? a.sources : [a.sources];
    const list = folderFiles.filter((f) => exts.includes(ext(f)));
    return list.length ? list.map(quote).join(" ") : quote(entry);
  }
  if ("test_filter" in a) return "";
  // {main_class}, {report_path}: the runner's own bookkeeping.
  return null;
}

export interface LocalRun {
  kind: KindDef;
  /** Build first (compiled languages), then `run`. */
  build?: string;
  run: string;
}

/**
 * The terminal commands that run `entry` (a file name in its folder) as the catalog's kind does,
 * or null when that kind only runs on the code runner.
 */
export function localRun(kind: KindDef, entry: string, folderFiles: string[] = [entry], os: Os = "mac"): LocalRun | null {
  quote = quoter(os);
  const run = kind.steps.run && stepLine(kind, kind.steps.run, entry, folderFiles);
  if (!run) return null;
  const build = kind.steps.build ? stepLine(kind, kind.steps.build, entry, folderFiles) : undefined;
  if (build === null) return null;
  return { kind, run, ...(build ? { build } : {}) };
}
