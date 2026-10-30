/**
 * PHP on the school's code runner, the way the MIS Code Playground runs it (nga-webrun): a page
 * runs as one web request (PHP_ROUTER as the entry, the request on stdin, kind php/single) and
 * what it prints is the page; a script runs live in the Run panel. Pure: the caller sends the
 * request and shows the page.
 */
import type { CodeFile, RunData, RunRequestBody } from "./codeRunner";
import { PHP_ROUTER, PHP_ROUTER_PATH, phpRequestInput } from "../vendor/nga-webrun";

/** The catalog kind every PHP run on the code runner uses: one PHP CLI run, any number of files. */
export const PHP_RUN_KIND = "php/single";

/**
 * Whether a .php file is a web page (shown in the preview) rather than a script (run in the Run
 * panel): HTML around its PHP, `<?=`, a form's $_GET/$_POST, or the site's index.php. HTML before
 * `<?php`, or no `<?php` at all, is a valid PHP file: PHP prints that text as it is.
 */
export function isPhpPage(source: string, path = ""): boolean {
  if (/(^|\/)index\.php$/i.test(path)) return true;
  const outside = source
    .replace(/<\?(php\b|=)?[\s\S]*?(\?>|$)/gi, " ")
    .replace(/^#!.*\n/, "")
    .trim();
  if (/<\/?[a-z][\w-]*[\s>/]|<!doctype/i.test(outside)) return true;
  if (/<\?=/.test(source)) return true;
  if (/\$_(GET|POST|REQUEST|SERVER\s*\[\s*['"]REQUEST_METHOD)/.test(source)) return true;
  // Code that prints tags (echo "<h1>…") is a page too; code that reads the keyboard is a script.
  if (/\b(fgets|fscanf|stream_get_contents)\s*\(\s*(STDIN|['"]php:\/\/stdin)|\breadline\s*\(/i.test(source)) return false;
  return /\b(echo|print)\b[^;]*<\/?(html|body|h[1-6]|p|div|ul|ol|table|form|a|section|main|nav|header|footer)\b/i.test(source);
}

/** A link or form inside the page: which project file it asks for, how, and with which fields. */
export interface PhpRequest {
  /** The project path ("index.php", "admin/edit.php"). */
  path: string;
  method: "GET" | "POST";
  /** "id=3&q=x", no "?". */
  query: string;
  fields: [string, string][];
}

/**
 * The `/code/run` body for one page: the project's files plus the router as the entry, kind
 * php/single, and the request on stdin (one test, no expected output).
 */
export function phpPageRequest(files: CodeFile[], req: PhpRequest): RunRequestBody & { tests: { id: string; input: string }[] } {
  return {
    language: "php",
    kind: PHP_RUN_KIND,
    entry: PHP_ROUTER_PATH,
    files: [...files.filter((f) => f.path !== PHP_ROUTER_PATH), { path: PHP_ROUTER_PATH, content: PHP_ROUTER }],
    tests: [{ id: "page", input: phpRequestInput(req.path, req.method, req.query, req.fields) }],
  };
}

/** One line for the preview's console. */
export interface PageLog {
  level: "info" | "warn" | "error";
  text: string;
}

/**
 * What a page run printed (the page), and what goes to the console: PHP's warnings and errors
 * (stderr), and the runner's verdict when the page didn't finish.
 */
export function phpPageResult(r: RunData, words: (verdict: string) => string | null): { html: string; logs: PageLog[] } {
  const t = r.tests[0];
  const logs: PageLog[] = [];
  if (r.error) logs.push({ level: "error", text: r.error });
  if (r.compile && r.compile.ok === false && r.compile.output) logs.push({ level: "error", text: r.compile.output.trim() });
  for (const line of (t?.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 50)) {
    logs.push({ level: /\b(warning|notice|deprecated)\b/i.test(line) ? "warn" : "error", text: line });
  }
  if (t && t.verdict !== "ok" && t.verdict !== "accepted") logs.push({ level: "error", text: `The page stopped: ${words(t.verdict) ?? t.verdict}.` });
  if (!t && !logs.length) logs.push({ level: "error", text: "The code runner did not run the page." });
  return { html: t?.stdout ?? "", logs };
}

/** Composer and Laravel commands: they need PHP (and Composer) on this computer. */
export const needsLocalPhp = (command: string | undefined) => /\b(composer|artisan|phpunit)\b|\bphp\s+-a\b/.test(command ?? "");

/** `php -S … -t <docroot>` in `cwd`: the folder the server serves. */
export function phpServerRoot(command: string, cwd = ""): string {
  const docroot = /\s-t\s+("?)([^"\s]+)\1/.exec(command)?.[2] ?? ".";
  return [cwd, docroot === "." ? "" : docroot].filter(Boolean).join("/");
}
