import { describe, expect, it } from "vitest";
import { Uri } from "../api/uri";
import { ScmService } from "./scm";
import { TestingService } from "./testing";
import { DebugConfigService } from "./debugConfig";

function fakeRpc() {
  const sent: [string, unknown[]][] = [];
  const handlers = new Map<string, (args: unknown[]) => unknown>();
  return {
    sent,
    handlers,
    rpc: { register: (n: string, f: (a: unknown[]) => unknown) => handlers.set(n, f), request: async (n: string, a: unknown[]) => (sent.push([n, a]), true) } as never,
  };
}
const paths = { toPath: (u: Uri) => (u.path.startsWith("/ws/") ? u.path.slice(4) : null) };
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe("extension source control", () => {
  it("sends its input, groups and resources, and takes the input back", async () => {
    const { rpc, sent, handlers } = fakeRpc();
    let ref = 0;
    const scm = new ScmService(rpc, paths, { add: () => ++ref });
    const sc = scm.create("hg", "Mercurial", Uri.file("/ws"));
    sc.inputBox.placeholder = "Message (⌘Enter to commit)";
    sc.acceptInputCommand = { command: "hg.commit", title: "Commit" };
    const g = sc.createResourceGroup("changes", "Changes");
    g.resourceStates = [{ resourceUri: Uri.file("/ws/a.py"), decorations: { tooltip: "Modified" }, command: { command: "hg.open", title: "Open" } }, { resourceUri: Uri.file("/ws/old.py"), decorations: { strikeThrough: true } }];
    sc.count = 2;
    await tick();
    const last = sent.filter(([n]) => n === "$main.scm").at(-1)![1] as [string, number, { label: string; count: number; input: { placeholder: string }; acceptInputCommand: { ref: number }; groups: { resources: { path: string; strikeThrough?: boolean; command?: unknown }[] }[] }];
    expect(last[0]).toBe("upsert");
    expect(last[2]).toMatchObject({ label: "Mercurial", count: 2, input: { placeholder: "Message (⌘Enter to commit)" }, acceptInputCommand: { ref: expect.any(Number) } });
    expect(last[2].groups[0].resources.map((r) => [r.path, !!r.strikeThrough, !!r.command])).toEqual([
      ["a.py", false, true],
      ["old.py", true, false],
    ]);
    const changes: string[] = [];
    sc.inputBox.onDidChange((v: string) => changes.push(v));
    handlers.get("$scmInput")!([last[1], "fix bug"]);
    expect(sc.inputBox.value).toBe("fix bug");
    expect(changes).toEqual(["fix bug"]);
    sc.dispose();
    expect(sent.at(-1)).toEqual(["$main.scm", ["remove", last[1]]]);
  });
});

describe("extension test controllers", () => {
  it("sends the tree, runs the default profile on request and reports results", async () => {
    const { rpc, sent, handlers } = fakeRpc();
    const testing = new TestingService(rpc, paths);
    const ctrl = testing.create("jest", "Jest");
    const file = ctrl.createTestItem("math.test.js", "math.test.js", Uri.file("/ws/math.test.js"));
    const t1 = ctrl.createTestItem("adds", "adds numbers", Uri.file("/ws/math.test.js"));
    t1.range = { start: { line: 4 } } as never;
    file.children.add(t1);
    ctrl.items.add(file);
    let ran: unknown = null;
    ctrl.createRunProfile(
      "Run",
      1,
      (request: unknown) => {
        const req = request as { include?: { id: string }[] };
        ran = req.include?.map((i) => i.id) ?? "all";
        const run = ctrl.createTestRun(req);
        run.started(t1);
        run.failed(t1, { message: "expected 3", expectedOutput: "3", actualOutput: "4" }, 12);
        run.end();
      },
      true,
    );
    await tick();
    const tree = sent.filter(([n]) => n === "$main.tests").at(-1)![1] as [string, number, { canRun: boolean; items: { id: string; path: string; children: { id: string; line: number }[] }[] }];
    expect(tree[2].canRun).toBe(true);
    expect(tree[2].items[0]).toMatchObject({ id: "math.test.js", path: "math.test.js", children: [{ id: "adds", line: 4 }] });
    await handlers.get("$runTests")!([tree[1], ["adds"]]);
    expect(ran).toEqual(["adds"]);
    const states = sent.filter(([n]) => n === "$main.testState").map(([, a]) => [a[2], a[3]]);
    expect(states).toEqual([
      ["running", null],
      ["failed", "expected 3\nExpected: 3\nActual: 4"],
    ]);
    expect(sent.some(([n, a]) => n === "$main.testRun" && a[1] === "end")).toBe(true);
  });
});

describe("extension debug configuration providers", () => {
  it("offer starting points, and may change or stop a launch", async () => {
    const { rpc, handlers } = fakeRpc();
    const svc = new DebugConfigService(rpc, () => undefined);
    svc.register("node", {
      provideDebugConfigurations: () => [{ name: "Launch server", request: "launch", program: "server.js" }],
      resolveDebugConfiguration: (_f, c) => (c.name === "stop" ? undefined : { ...c, env: { DEBUG: "1" } }),
    });
    expect(await handlers.get("$provideDebugConfigurations")!([])).toEqual([{ type: "node", name: "Launch server", request: "launch", program: "server.js" }]);
    expect(await handlers.get("$resolveDebugConfiguration")!([{ type: "node", name: "x" }])).toEqual({ type: "node", name: "x", env: { DEBUG: "1" } });
    expect(await handlers.get("$resolveDebugConfiguration")!([{ type: "python", name: "y" }])).toEqual({ type: "python", name: "y" });
    expect(await handlers.get("$resolveDebugConfiguration")!([{ type: "node", name: "stop" }])).toBeNull();
  });
});
