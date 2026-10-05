import { describe, expect, it } from "vitest";
import { DapSession } from "./dapSession";
import { PyError, createSimulatedDebugHost, evaluate, execute, SIMULATED_ROOT } from "./fakeAdapter";
import { GUIDES, guideForPath, missingToolchain, toolsForPath } from "./installGuide";

describe("the simulated Python interpreter", () => {
  it("evaluates expressions and runs simple statements", () => {
    const vars = new Map();
    expect(execute("total = 2 + 3 * 4", vars)).toBeNull();
    expect(vars.get("total")).toBe(14);
    execute("nums = [1, 2]", vars);
    execute("nums.append(total)", vars);
    expect(evaluate("sum(nums) // 2", vars)).toBe(8);
    expect(execute('print("total is", total, nums)', vars)).toBe("total is 14 [1, 2, 14]\n");
    execute("total += 1  # comment", vars);
    expect(evaluate("total > 10 and not False", vars)).toBe(true);
    expect(() => evaluate("missing + 1", vars)).toThrow(PyError);
    expect(() => evaluate("1 / 0", vars)).toThrow(/division by zero/);
  });
});

/** Drives the simulated adapter through a real DapSession over the framed transport. */
async function session(files: Record<string, string>) {
  const host = createSimulatedDebugHost(async (p) => {
    if (!(p in files)) throw new Error(`no ${p}`);
    return files[p];
  }, { delay: 0 });
  let dap!: DapSession;
  const conn = await host.start("python", {}, (e) => e.type === "message" && dap.handleMessage(e.message));
  dap = new DapSession({ send: (m) => conn.send(m) }, "python");
  return { host, dap, conn };
}

describe("the simulated debug session", () => {
  it("stops at a breakpoint, shows variables, evaluates, steps and finishes", async () => {
    const src = "a = 1\n\nb = a + 41\nnames = ['x', 'y']\nprint('b =', b)\n";
    const { host, dap } = await session({ "main.py": src });
    const prepared = await host.prepare({ entry: "main.py", build: [], run: { tool: "python", args: [] } }, () => {});
    expect(prepared.entry).toBe(`${SIMULATED_ROOT}/main.py`);
    const caps = await dap.initialize("debugpy", { runInTerminal: false });
    expect(caps.supportsConfigurationDoneRequest).toBe(true);

    const output: string[] = [];
    dap.on("output", (b) => output.push(b.output));
    const initialized = dap.once("initialized");
    await dap.launch({ program: prepared.entry });
    await initialized;
    // Line 2 is blank: the breakpoint moves to line 3.
    const bps = await dap.setBreakpoints({ path: prepared.entry }, [{ line: 2 }]);
    expect(bps[0]).toMatchObject({ verified: true, line: 3 });
    const stopped = dap.once("stopped");
    await dap.configurationDone();
    expect((await stopped).reason).toBe("breakpoint");

    const [frame] = await dap.stackTrace(1);
    expect(frame).toMatchObject({ line: 3, source: { path: prepared.entry } });
    const [scope] = await dap.scopes(frame.id);
    expect((await dap.variables(scope.variablesReference)).map((v) => [v.name, v.value])).toEqual([["a", "1"]]);
    expect((await dap.evaluate("a * 10", frame.id, "repl")).result).toBe("10");
    await expect(dap.evaluate("nope", frame.id, "watch")).rejects.toThrow("NameError");

    const stepped = dap.once("stopped");
    await dap.next(1);
    expect((await stepped).reason).toBe("step");
    expect((await dap.stackTrace(1))[0].line).toBe(4);
    const vars = await dap.variables(scope.variablesReference);
    expect(vars.find((v) => v.name === "b")).toMatchObject({ value: "42", type: "int" });

    const step2 = dap.once("stopped");
    await dap.next(1);
    await step2;
    const names = (await dap.variables(scope.variablesReference)).find((v) => v.name === "names")!;
    expect(names.variablesReference).toBeGreaterThan(0);
    expect((await dap.variables(names.variablesReference)).map((v) => v.value)).toEqual(["'x'", "'y'", "2"]);

    const exited = dap.once("exited");
    const terminated = dap.once("terminated");
    await dap.continue(1);
    expect((await exited).exitCode).toBe(0);
    await terminated;
    expect(output.join("")).toBe("b = 42\n");
  });

  it("honours conditions and logpoints", async () => {
    const src = "n = 1\nn = 2\nn = 3\nn = 4\n";
    const { dap } = await session({ "loop.py": src });
    await dap.initialize("debugpy", { runInTerminal: false });
    const initialized = dap.once("initialized");
    await dap.launch({ program: `${SIMULATED_ROOT}/loop.py` });
    await initialized;
    const logs: string[] = [];
    dap.on("output", (b) => b.category === "console" && logs.push(b.output));
    await dap.setBreakpoints({ path: `${SIMULATED_ROOT}/loop.py` }, [{ line: 2, logMessage: "n is {n}" }, { line: 4, condition: "n == 3" }, { line: 3, condition: "n == 99" }]);
    const stopped = dap.once("stopped");
    await dap.configurationDone();
    await stopped;
    expect((await dap.stackTrace(1))[0].line).toBe(4);
    expect(logs).toEqual(["n is 1\n"]);
  });

  it("stops on an uncaught exception when asked to", async () => {
    const { dap } = await session({ "bad.py": "x = 1\ny = x / 0\n" });
    await dap.initialize("debugpy", { runInTerminal: false });
    const initialized = dap.once("initialized");
    await dap.launch({ program: `${SIMULATED_ROOT}/bad.py` });
    await initialized;
    await dap.setExceptionBreakpoints(["uncaught"]);
    const stopped = dap.once("stopped");
    await dap.configurationDone();
    const b = await stopped;
    expect(b.reason).toBe("exception");
    expect(b.text).toContain("ZeroDivisionError");
  });
});

describe("install guides", () => {
  it("covers Python, Node, Java, C/C++, Go and more for every OS", () => {
    for (const id of ["python", "node", "java", "c", "cpp", "go", "rust"]) expect(GUIDES.some((g) => g.id === id)).toBe(true);
    for (const g of GUIDES) for (const os of ["windows", "mac", "linux"] as const) expect(g.steps[os].length).toBeGreaterThan(0);
  });

  it("finds the guide and the missing tools for a file", () => {
    expect(guideForPath("src/app.ts")?.id).toBe("node");
    expect(guideForPath("main.go")?.id).toBe("go");
    expect(guideForPath("index.html")).toBeNull();
    expect(toolsForPath("Main.java")).toEqual(["javac", "java"]);
    expect(toolsForPath("main.c")).toEqual(["cc"]);
    const have = [{ tool: "python", path: "/usr/bin/python3", version: "3.12" }];
    expect(missingToolchain("main.py", have)).toBeNull();
    expect(missingToolchain("Main.java", have)).toMatchObject({ guide: { id: "java" }, missing: ["javac", "java"] });
    // Languages TMCode can't run get the guide with nothing "missing".
    expect(missingToolchain("main.go", have)).toMatchObject({ guide: { id: "go" }, missing: [] });
    // Unknown until toolchains are detected.
    expect(missingToolchain("Main.java", null)).toBeNull();
  });
});
