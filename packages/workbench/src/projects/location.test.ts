import { describe, expect, it } from "vitest";
import { detectProjects, resolveRun, type TargetContext } from "../run/projectKind";
import { servedBy, wantsWebServer, withWebServer } from "./location";

const xampp = [{ server: "XAMPP", path: "/Applications/XAMPP/xamppfiles/htdocs", url: "http://localhost" }];
const wamp = [{ server: "WAMP", path: "C:\\wamp64\\www", url: "http://localhost:8080" }];
const DESKTOP: TargetContext = { practice: true, terminal: true, runner: true, debugger: true, previewOrigin: true };
const folder = (files: Record<string, string>, dir = "") => ({ dir, files: Object.keys(files), dirs: [], read: files });

describe("project location", () => {
  it("PHP work wants a web server; other languages don't", () => {
    expect(wantsWebServer({ language: "PHP" })).toBe(true);
    expect(wantsWebServer({ templateId: "laravel" })).toBe(true);
    expect(wantsWebServer({ language: "python", templateId: "flask" })).toBe(false);
  });

  it("knows which web server serves a folder, and at which address", () => {
    expect(servedBy("/Applications/XAMPP/xamppfiles/htdocs/my shop", xampp)).toEqual({ server: "XAMPP", url: "http://localhost/my%20shop" });
    expect(servedBy("C:\\WAMP64\\www\\blog", wamp)).toEqual({ server: "WAMP", url: "http://localhost:8080/blog" });
    expect(servedBy("/Users/ada/TMCode Projects/shop", xampp)).toBeNull();
    expect(servedBy("/Applications/XAMPP/xamppfiles/htdocs", xampp)).toBeNull();
  });

  it("a PHP site in htdocs runs as Apache serves it; loose PHP exercises still run one by one", () => {
    const served = servedBy("/Applications/XAMPP/xamppfiles/htdocs/shop", xampp);
    const site = withWebServer(detectProjects([folder({ "index.php": "<?php echo 1;" })]), served);
    const run = resolveRun({ projects: site, file: [], activePath: null, pins: {}, ctx: DESKTOP });
    expect(run.action?.url).toBe("http://localhost/shop/");
    expect(run.action?.label).toBe("Open in XAMPP (localhost/shop/)");
    const laravel = withWebServer(detectProjects([folder({ artisan: "", "composer.json": "{}" })]), served);
    expect(laravel[0].actions[0].url).toBe("http://localhost/shop/public/");
  });
});
