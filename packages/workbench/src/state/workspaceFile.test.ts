import { describe, expect, it } from "vitest";
import { parseWorkspaceFile } from "./workspaceFile";

describe(".code-workspace files", () => {
  it("lists the folders, relative ones made absolute, named by name or folder", () => {
    const text = `{
      // a comment
      "folders": [{ "path": "client" }, { "name": "API", "path": "./server" }, { "path": "../shared" }, { "path": "/opt/lib" }, { "path": "client" }, {}],
      "settings": {}
    }`;
    expect(parseWorkspaceFile(text, "/home/ada/proj")).toEqual([
      { name: "client", path: "/home/ada/proj/client" },
      { name: "API", path: "/home/ada/proj/server" },
      { name: "shared", path: "/home/ada/shared" },
      { name: "lib", path: "/opt/lib" },
    ]);
  });

  it("works with Windows paths and broken files", () => {
    expect(parseWorkspaceFile('{"folders":[{"path":"web"},{"path":"D:\\\\data"}]}', "C:\\Users\\a\\p")).toEqual([
      { name: "web", path: "C:\\Users\\a\\p\\web" },
      { name: "data", path: "D:\\data" },
    ]);
    expect(parseWorkspaceFile("not json", "/x")).toEqual([]);
    expect(parseWorkspaceFile('{"folders":"no"}', "/x")).toEqual([]);
  });
});
