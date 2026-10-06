import { describe, expect, it } from "vitest";
import { CONSOLE_SHIM, findModuleEntry, injectBeforeBodyEnd, injectIntoHead, inlineAssets, resolveRelative, scrollTag } from "./compose";

describe("preview composition", () => {
  it("injects into head or creates one", () => {
    expect(injectIntoHead("<html><head><title>x</title></head></html>", "<s/>")).toBe("<html><head><s/><title>x</title></head></html>");
    expect(injectIntoHead("<html><body></body></html>", "<s/>")).toBe("<html><head><s/></head><body></body></html>");
    expect(injectIntoHead("<p>hi</p>", "<s/>")).toBe("<s/><p>hi</p>");
    expect(injectBeforeBodyEnd("<body><p/></body>", "<x/>")).toBe("<body><p/><x/></body>");
  });

  it("resolves relative URLs inside the preview root only", () => {
    expect(resolveRelative("index.html", "css/site.css")).toBe("css/site.css");
    expect(resolveRelative("pages/about.html", "../style.css")).toBe("style.css");
    expect(resolveRelative("index.html", "/app.js?v=2")).toBe("app.js");
    expect(resolveRelative("index.html", "../../etc/passwd")).toBeNull();
    expect(resolveRelative("index.html", "https://cdn.example.com/x.js")).toBeNull();
    expect(resolveRelative("index.html", "#top")).toBeNull();
  });

  it("inlines stylesheets and scripts and reports missing files", async () => {
    const files: Record<string, string> = { "style.css": "body{color:red}", "app.js": "console.log('</script>')" };
    const { html, missing } = await inlineAssets(
      '<head><link rel="stylesheet" href="style.css"><link rel="icon" href="x.ico"></head><body><script src="app.js"></script><script type="module" src="gone.js"></script></body>',
      "index.html",
      async (p) => files[p] ?? null,
    );
    expect(html).toContain('<style data-source="style.css">\nbody{color:red}\n</style>');
    expect(html).toContain('<link rel="icon" href="x.ico">');
    expect(html).toContain("console.log('<\\/script>')");
    expect(missing).toEqual(["gone.js"]);
  });

  it("finds a Vite-style module entry", () => {
    expect(findModuleEntry('<div id="root"></div><script type="module" src="/src/main.jsx"></script>')?.src).toBe("/src/main.jsx");
    expect(findModuleEntry("<p>no scripts</p>")).toBeNull();
  });

  it("ships a console shim that parses, and restores the scroll position", () => {
    expect(() => new Function(CONSOLE_SHIM)).not.toThrow();
    expect(scrollTag(10.4, 250)).toBe("<script>window.__tmcodeScroll={x:10,y:250};</script>");
    expect(scrollTag(NaN, 0)).toBe("<script>window.__tmcodeScroll={x:0,y:0};</script>");
  });
});
