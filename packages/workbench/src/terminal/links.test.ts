import { describe, expect, it } from "vitest";
import { findFileRefs, findLocalUrls, portOf, toWorkspaceRef } from "./links";

describe("findLocalUrls", () => {
  it("finds dev servers from common frameworks", () => {
    expect(findLocalUrls("  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m")).toEqual(["http://localhost:5173/"]); // Vite colours the port
    expect(findLocalUrls("  ➜  Local:   http://localhost:5173/")).toEqual(["http://localhost:5173/"]);
    expect(findLocalUrls("ready - started server on 0.0.0.0:3000, url: http://localhost:3000")).toEqual(["http://localhost:3000"]);
    expect(findLocalUrls("** Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/ **")).toEqual(["http://localhost:4200/"]);
    expect(findLocalUrls(" * Running on http://127.0.0.1:5000")).toEqual(["http://127.0.0.1:5000"]);
    expect(findLocalUrls("Starting development server at http://0.0.0.0:8000/")).toEqual(["http://localhost:8000/"]);
    expect(findLocalUrls("see https://example.com")).toEqual([]);
  });

  it("reads ports", () => {
    expect(portOf("http://localhost:5173/")).toBe(5173);
    expect(portOf("http://localhost/")).toBe(80);
  });
});

describe("findFileRefs", () => {
  it("finds path:line:col references", () => {
    expect(findFileRefs("src/App.tsx:12:5 - error TS2322")).toMatchObject([{ path: "src/App.tsx", line: 12, column: 5, start: 0 }]);
    expect(findFileRefs("    at main (/w/js/sum.js:3:9)")).toMatchObject([{ path: "/w/js/sum.js", line: 3, column: 9 }]);
    expect(findFileRefs('  File "/w/main.py", line 4, in <module>')).toMatchObject([{ path: "/w/main.py", line: 4 }]);
    expect(findFileRefs("Compiled main.c")).toMatchObject([{ path: "main.c" }]);
    expect(findFileRefs("no files here")).toEqual([]);
  });

  it("maps to workspace paths", () => {
    expect(toWorkspaceRef("/w/js/sum.js", "/w")).toBe("js/sum.js");
    expect(toWorkspaceRef("./src/a.ts", "/w")).toBe("src/a.ts");
    expect(toWorkspaceRef("/etc/passwd", "/w")).toBeNull();
    expect(toWorkspaceRef("../x.ts", "/w")).toBeNull();
  });
});
