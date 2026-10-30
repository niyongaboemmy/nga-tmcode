import { describe, expect, it } from "vitest";
import { PHP_ROUTER, PHP_ROUTER_PATH } from "../vendor/nga-webrun";
import { verdictWords, type RunData } from "./codeRunner";
import { isPhpPage, needsLocalPhp, phpPageRequest, phpPageResult, phpServerRoot } from "./phpPages";

const run = (over: Partial<RunData> = {}): RunData => ({ language: "php", entry: PHP_ROUTER_PATH, kind: "php/single", files_sent: [], compile: null, tests: [], unit: null, error: null, ...over });

describe("PHP pages and scripts", () => {
  it("HTML before <?php, or no <?php at all, is a valid PHP page", () => {
    expect(isPhpPage("<!DOCTYPE html>\n<html><body><?php echo 'Hi'; ?></body></html>")).toBe(true);
    expect(isPhpPage("<h1>Shop</h1>\n<?php\n$items = [];\n")).toBe(true);
    expect(isPhpPage("<p>Plain HTML, no PHP yet.</p>")).toBe(true);
    expect(isPhpPage("<?php $t = 'x'; ?>\n<title><?= $t ?></title>")).toBe(true);
    expect(isPhpPage("<?php\necho '<h1>Hello</h1>';\n")).toBe(true);
    expect(isPhpPage("<?php\nif ($_SERVER['REQUEST_METHOD'] === 'POST') { echo 'ok'; }\n")).toBe(true);
    // The site's front page is a page whatever it holds.
    expect(isPhpPage("<?php require 'app.php';", "shop/index.php")).toBe(true);
  });

  it("a program that reads the keyboard or only prints text is a script", () => {
    expect(isPhpPage("<?php\n$line = trim(fgets(STDIN));\necho \"Sum: $line\\n\";\n")).toBe(false);
    expect(isPhpPage("<?php\necho \"Hello, world!\\n\";\n")).toBe(false);
    expect(isPhpPage("<?php\n$n = (int) readline('n? ');\nfor ($i = 0; $i < $n; $i++) echo $i < 3 ? '<' : '>';\n")).toBe(false);
    expect(isPhpPage("<?php\nclass Grades {}\n", "src/Grades.php")).toBe(false);
  });

  it("a page runs as one request: the router as entry next to the files, php/single, the request on stdin", () => {
    const files = [
      { path: "index.php", content: "<h1>Home</h1>" },
      { path: "admin/edit.php", content: "<?php echo $_POST['title'];" },
      { path: PHP_ROUTER_PATH, content: "<?php // an old copy" },
    ];
    const body = phpPageRequest(files, { path: "admin/edit.php", method: "POST", query: "id=2", fields: [["title", "Hi & bye"], ["tags[]", "a"], ["tags[]", "b"]] });
    expect(body).toMatchObject({ language: "php", kind: "php/single", entry: PHP_ROUTER_PATH });
    expect(body.files.map((f) => f.path)).toEqual(["index.php", "admin/edit.php", PHP_ROUTER_PATH]);
    expect(body.files.at(-1)!.content).toBe(PHP_ROUTER);
    expect(body.tests).toHaveLength(1);
    expect(JSON.parse(body.tests[0].input)).toEqual({ script: "admin/edit.php", method: "POST", get: { id: "2" }, post: { title: "Hi & bye", tags: { 0: "a", 1: "b" } } });
    expect(JSON.parse(phpPageRequest(files, { path: "index.php", method: "GET", query: "", fields: [["q", "x"]] }).tests[0].input)).toMatchObject({ method: "GET", get: { q: "x" }, post: {} });
  });

  it("what the page printed is the page; PHP's warnings and a failed run go to the console", () => {
    const ok = phpPageResult(run({ tests: [{ id: "page", verdict: "ok", passed: null, stdout: "<h1>Hi</h1>", stderr: "PHP Warning:  Undefined variable $x in index.php on line 3\n" }] }), verdictWords);
    expect(ok.html).toBe("<h1>Hi</h1>");
    expect(ok.logs).toEqual([{ level: "warn", text: "PHP Warning:  Undefined variable $x in index.php on line 3" }]);
    const crashed = phpPageResult(run({ tests: [{ id: "page", verdict: "runtime-error", passed: null, stdout: "", stderr: "PHP Parse error:  syntax error in index.php on line 2" }] }), verdictWords);
    expect(crashed.logs.map((l) => l.level)).toEqual(["error", "error"]);
    expect(crashed.logs[1].text).toBe("The page stopped: Crashed (runtime error).");
    expect(phpPageResult(run({ error: "Unknown project kind" }), verdictWords).logs[0]).toEqual({ level: "error", text: "Unknown project kind" });
  });

  it("Composer and Laravel need PHP here; php -S serves its folder", () => {
    expect(needsLocalPhp("php artisan serve")).toBe(true);
    expect(needsLocalPhp("vendor/bin/phpunit")).toBe(true);
    expect(needsLocalPhp("php -a")).toBe(true);
    expect(needsLocalPhp("php -S localhost:8000 -t .")).toBe(false);
    expect(needsLocalPhp(undefined)).toBe(false);
    expect(phpServerRoot("php -S localhost:8000 -t .", "shop")).toBe("shop");
    expect(phpServerRoot("php -S localhost:8000 -t public", "app")).toBe("app/public");
    expect(phpServerRoot("php -S localhost:8000 -t public")).toBe("public");
  });
});
