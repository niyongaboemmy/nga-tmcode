import { describe, expect, it } from "vitest";
import { Position, Range, Selection, TextEdit, WorkspaceEdit, SnippetString, MarkdownString, Diagnostic, CodeActionKind, Disposable } from "./types";
import { Uri, setUriPlatform } from "./uri";
import { CancellationTokenSource, EventEmitter } from "./events";

describe("Position and Range (VS Code semantics)", () => {
  it("validates and compares positions", () => {
    expect(() => new Position(-1, 0)).toThrow();
    const p = new Position(2, 5);
    expect(p.isBefore(new Position(3, 0))).toBe(true);
    expect(p.isAfter(new Position(2, 4))).toBe(true);
    expect(p.compareTo(new Position(2, 5))).toBe(0);
    expect(p.translate(1, -2)).toEqual(new Position(3, 3));
    expect(p.translate({ characterDelta: 1 })).toEqual(new Position(2, 6));
    expect(p.with(undefined, 0)).toEqual(new Position(2, 0));
    expect(p.translate(0, 0)).toBe(p);
  });

  it("normalises ranges so start is before end", () => {
    const r = new Range(5, 1, 2, 3);
    expect(r.start).toEqual(new Position(2, 3));
    expect(r.end).toEqual(new Position(5, 1));
    expect(new Range(1, 1, 1, 1).isEmpty).toBe(true);
    expect(new Range(1, 0, 1, 9).isSingleLine).toBe(true);
  });

  it("contains, intersects and unions like VS Code", () => {
    const r = new Range(1, 0, 3, 0);
    expect(r.contains(new Position(1, 0))).toBe(true);
    expect(r.contains(new Position(3, 0))).toBe(true);
    expect(r.contains(new Position(3, 1))).toBe(false);
    expect(r.contains(new Range(2, 0, 2, 5))).toBe(true);
    expect(r.intersection(new Range(2, 0, 9, 0))).toEqual(new Range(2, 0, 3, 0));
    expect(r.intersection(new Range(4, 0, 5, 0))).toBeUndefined();
    expect(r.union(new Range(0, 0, 1, 1))).toEqual(new Range(0, 0, 3, 0));
    expect(r.with({ end: new Position(4, 0) })).toEqual(new Range(1, 0, 4, 0));
  });

  it("knows a reversed selection", () => {
    expect(new Selection(3, 0, 1, 0).isReversed).toBe(true);
    expect(new Selection(1, 0, 3, 0).isReversed).toBe(false);
    expect(new Selection(new Position(1, 1), new Position(1, 1)).isReversed).toBe(false);
    expect(Range.isRange(new Selection(0, 0, 0, 1))).toBe(true);
    expect(Selection.isSelection({ start: 1 })).toBe(false);
  });
});

describe("Uri (VS Code semantics)", () => {
  it("parses and prints with VS Code's encoding", () => {
    const u = Uri.parse("https://example.com/a b/c?q=1#frag");
    expect(u.scheme).toBe("https");
    expect(u.authority).toBe("example.com");
    expect(u.path).toBe("/a b/c");
    expect(u.query).toBe("q=1");
    expect(u.fragment).toBe("frag");
    expect(u.toString()).toBe("https://example.com/a%20b/c?q%3D1#frag");
    expect(u.toString(true)).toBe("https://example.com/a b/c?q=1#frag");
  });

  it("makes file URIs and fsPaths for the host OS", () => {
    setUriPlatform(false);
    const f = Uri.file("/Users/me/my project/a.js");
    expect(f.toString()).toBe("file:///Users/me/my%20project/a.js");
    expect(f.fsPath).toBe("/Users/me/my project/a.js");
    setUriPlatform(true);
    const w = Uri.file("C:\\Users\\me\\a.js");
    expect(w.path).toBe("/C:/Users/me/a.js");
    expect(w.toString()).toBe("file:///c%3A/Users/me/a.js");
    expect(w.fsPath).toBe("c:\\Users\\me\\a.js");
    expect(Uri.file("\\\\server\\share\\x").authority).toBe("server");
    setUriPlatform(false);
  });

  it("joins paths, changes parts and revives from JSON", () => {
    const base = Uri.file("/ws");
    expect(Uri.joinPath(base, "src", "../lib/a.ts").path).toBe("/ws/lib/a.ts");
    expect(base.with({ scheme: "untitled" }).toString()).toBe("untitled:/ws");
    expect(base.with({ path: "/ws" })).toBe(base);
    const back = Uri.revive(JSON.parse(JSON.stringify(base)));
    expect(back.toString()).toBe(base.toString());
    expect(Uri.isUri(back)).toBe(true);
    expect(() => Uri.from({ scheme: "" })).toThrow();
  });
});

describe("edits, strings and events", () => {
  it("WorkspaceEdit groups text edits by resource", () => {
    const e = new WorkspaceEdit();
    const a = Uri.file("/a");
    e.insert(a, new Position(0, 0), "x");
    e.replace(a, new Range(1, 0, 1, 2), "y");
    e.delete(Uri.file("/b"), new Range(0, 0, 0, 1));
    e.renameFile(a, Uri.file("/c"));
    expect(e.size).toBe(2);
    expect(e.get(a).map((t) => t.newText)).toEqual(["x", "y"]);
    e.set(a, [TextEdit.replace(new Range(0, 0, 0, 0), "z")]);
    expect(e.get(a).map((t) => t.newText)).toEqual(["z"]);
    expect(e._allEntries().some((x) => x.kind === "rename")).toBe(true);
  });

  it("SnippetString escapes text and numbers tab stops", () => {
    const s = new SnippetString("a").appendText("$}").appendTabstop().appendPlaceholder("name").appendChoice(["x", "y"]);
    expect(s.value).toBe("a\\$\\}$1${2:name}${3|x,y|}");
  });

  it("MarkdownString, Diagnostic and CodeActionKind", () => {
    expect(new MarkdownString("a").appendCodeblock("b", "js").value).toBe("a\n```js\nb\n```\n");
    expect(() => new Diagnostic(new Range(0, 0, 0, 1), "")).toThrow();
    expect(CodeActionKind.QuickFix.value).toBe("quickfix");
    expect(CodeActionKind.Source.contains(CodeActionKind.SourceFixAll)).toBe(true);
    expect(CodeActionKind.Refactor.contains(CodeActionKind.QuickFix)).toBe(false);
  });

  it("EventEmitter isolates throwing listeners; Disposable.from; cancellation", () => {
    const em = new EventEmitter<number>();
    const seen: number[] = [];
    const errors: unknown[] = [];
    EventEmitter.onListenerError = (e) => errors.push(e);
    em.event(() => {
      throw new Error("boom");
    });
    const d = em.event((n) => seen.push(n));
    em.fire(1);
    d.dispose();
    em.fire(2);
    expect(seen).toEqual([1]);
    expect(errors).toHaveLength(2);
    let disposed = 0;
    Disposable.from({ dispose: () => disposed++ }, { dispose: () => disposed++ }).dispose();
    expect(disposed).toBe(2);
    const src = new CancellationTokenSource();
    let fired = false;
    src.token.onCancellationRequested(() => (fired = true));
    src.cancel();
    expect(src.token.isCancellationRequested && fired).toBe(true);
  });
});
