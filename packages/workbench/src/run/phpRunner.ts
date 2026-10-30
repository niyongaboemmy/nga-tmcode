/**
 * PHP without PHP on this computer: pages open in the preview and scripts run in the Run panel,
 * on the school's code runner through Task Mentor (the MIS Code Playground's way, nga-webrun).
 * With PHP installed, the Run hub keeps to `php -S` and `php file.php`; this is the other choice,
 * and what Run does when PHP is missing. Composer and Laravel always need PHP here.
 */
import { getDocument } from "../monaco/documents";
import { errorPage } from "../preview/page";
import { activeFilePath, getPlatform, log, notify } from "../state/store";
import { basename, dirname, join } from "../util/paths";
import { buildPageDocument, resolvePath, type NavRequest } from "../vendor/nga-webrun";
import { codeErrorWords, codeTransport, runOnServer, verdictWords, type CodeFile } from "./codeRunner";
import { isPhpPage, needsLocalPhp, PHP_RUN_KIND, phpPageRequest, phpPageResult, phpServerRoot, type PageLog, type PhpRequest } from "./phpPages";
import type { RunAction } from "./projectKind";

/** The project's files for a page run: what is on disk, with unsaved edits in their place. */
async function siteFiles(root: string): Promise<{ files: CodeFile[]; skipped: number }> {
  const { collectFolder } = await import("./serverRun");
  const { files, skipped } = await collectFolder(root);
  return { files: files.map((f) => ({ path: f.path, content: getDocument(join(root, f.path))?.getValue() ?? f.content })), skipped };
}

/**
 * One page of a PHP site as a preview document: an .html file as it is, a .php file run on the
 * school's code runner (its output is the page). Links and forms inside it come back to the
 * preview as navigations (nga-webrun's listenToRun) for the next call.
 */
export async function renderPhpPage(root: string, req: PhpRequest, runId: string): Promise<{ doc: string; logs: PageLog[] }> {
  const { files, skipped } = await siteFiles(root);
  const logs: PageLog[] = skipped ? [{ level: "warn", text: `${skipped} file(s) were too many or too large to send.` }] : [];
  const file = files.find((f) => f.path === req.path);
  if (!file) return { doc: errorPage("Page not found", [`${join(root, req.path)} is not one of the project's files.`]), logs };
  if (/\.html?$/i.test(req.path)) {
    const { doc, missing } = buildPageDocument(file.content, req.path, files, runId, "");
    return { doc, logs: [...logs, ...missing.map((m) => ({ level: "warn" as const, text: `${req.path} links to ${m}, which isn't one of the files.` }))] };
  }
  if (!/\.php$/i.test(req.path)) return { doc: errorPage("Not a page", [`${req.path} isn't a page: only .php and .html files open here.`]), logs };
  const t = codeTransport();
  if (!t) return { doc: errorPage("Sign in to Task Mentor", ["PHP pages run on the school's code runner through Task Mentor. Sign in, then Reload.", "Or install PHP to run the site on this computer."]), logs };
  log("Run", `${req.method} ${join(root, req.path)}${req.query ? `?${req.query}` : ""} on the school's code runner (${files.length} files)`);
  try {
    const r = phpPageResult(await runOnServer(t, phpPageRequest(files, req)), verdictWords);
    return { doc: buildPageDocument(r.html || "<p></p>", req.path, files, runId, "").doc, logs: [...logs, ...r.logs] };
  } catch (e) {
    const message = codeErrorWords(e);
    return { doc: errorPage("The page could not run", [message]), logs: [...logs, { level: "error", text: message }] };
  }
}

/** A link or form of the page at `from`: the request it makes. */
export function requestFor(from: string, nav: NavRequest): PhpRequest {
  const { path, query } = resolvePath(from, nav.href || from);
  return { path, method: nav.method, query, fields: nav.fields };
}

/** Opens a PHP site's page in the preview, run on the school's code runner. `note` is the console's first line. */
export async function openPhpPage(root: string, entry: string, note?: string) {
  const { openPreview } = await import("./runService");
  openPreview(root, entry, "php-runner", note);
}

/** The PHP site a file belongs to: the deepest PHP project around it, else its own folder. */
async function siteRootOf(path: string): Promise<string> {
  const { useRunHub } = await import("./runHub");
  const own = useRunHub
    .getState()
    .projects.filter((p) => p.kind === "php" && (p.dir === "" || path.startsWith(`${p.dir}/`)))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  return own?.dir ?? dirname(path);
}

/**
 * Runs a PHP action on the school's code runner instead of this computer: `php -S` opens the
 * page being edited (or index.php) in the preview, a page file the same, a script runs live in
 * the Run panel. False when it can't: signed out, or Composer/Laravel, which need PHP here.
 */
export async function runPhpOnSchoolRunner(a: RunAction, why: string): Promise<boolean> {
  if (needsLocalPhp(a.command) || !codeTransport()) return false;
  const active = activeFilePath();
  if (a.kind === "devServer" && /^php\s+-S\b/.test(a.command ?? "")) {
    const root = phpServerRoot(a.command!, a.cwd);
    const inside = !!active && /\.(php|html?)$/i.test(active) && (root === "" || active.startsWith(`${root}/`));
    await openPhpPage(root, inside ? active!.slice(root ? root.length + 1 : 0) : "index.php", why);
    return true;
  }
  // A terminal run names its file last ("php -d display_errors=stderr 'my page.php'").
  const quoted = /(?:'([^']+\.php)'|(\S+\.php))\s*$/i.exec(a.command ?? "");
  const named = quoted?.[1] ?? quoted?.[2];
  const file = a.entry ?? (named ? join(a.cwd ?? "", named) : null);
  if (!file || !/\.php$/i.test(file)) return false;
  const source = getDocument(file)?.getValue() ?? (await getPlatform().fs.readFile(file).catch(() => ""));
  if (isPhpPage(source, file)) {
    const root = await siteRootOf(file);
    await openPhpPage(root, root ? file.slice(root.length + 1) : file, why);
    return true;
  }
  const { runOnTaskMentor } = await import("./serverRun");
  return runOnTaskMentor(file, why, { kind: PHP_RUN_KIND });
}

/** The first line of the run, when PHP is missing here: why it runs on the school's code runner. */
export function phpMissingNote(a: RunAction): string {
  const what = a.entry ? basename(a.entry) : a.kind === "devServer" ? "the site" : "the file";
  return `PHP isn't installed on this computer, so ${what} runs on the school's code runner.`;
}

/** Says once (one notification, replaced on the next run) how to run PHP here instead. */
export function tellPhpMissing() {
  notify("info", "PHP runs on the school's code runner because it isn't installed on this computer. Install PHP to run it here: Composer and Laravel need it.", [{ label: "How to Install", run: () => void import("../debug/debugService").then((m) => m.showInstallGuide("php")) }], { owner: "php-runner" });
}
