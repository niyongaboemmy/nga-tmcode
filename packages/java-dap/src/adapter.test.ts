// @vitest-environment node
// End-to-end tests: real javac + JVM, the bundled adapter, a tiny DAP client.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DapReader, encodeMessage, type DapMessage } from "./dap";

const hasJdk = spawnSync("javac", ["-version"]).status === 0;
const here = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT = 30_000;

const SOURCES: Record<string, string> = {
  "src/Main.java": `import com.example.Util;
import java.util.*;

public class Main {
    static int counter = 7;

    static class Point {
        int x;
        int y;
        String label;
        Point(int x, int y, String label) { this.x = x; this.y = y; this.label = label; }
    }

    static int square(int n) {
        int result = n * n; // @square
        return result;
    }

    public static void main(String[] args) {
        int x = 41; // @entry
        double d = 2.5;
        char c = 'q';
        boolean flag = true;
        long big = 1234567890123L;
        String name = "Ada";
        int[] nums = {1, 2, 3};
        Point p = new Point(3, 4, "home");
        List<String> list = new ArrayList<>(List.of("a", "b"));
        Map<String, Integer> ages = new HashMap<>();
        ages.put("ann", 12);
        int y = square(x); // @call
        int sum = 0; // @after
        for (int i = 0; i < 5; i++) {
            sum += i; // @loop
        }
        System.out.println("sum=" + sum + " twice=" + Util.twice(sum));
    }
}
`,
  "src/com/example/Util.java": `package com.example;

public class Util {
    public static int twice(int v) {
        int doubled = v * 2; // @twice
        return doubled;
    }
}
`,
  "src/Crash.java": `public class Crash {
    static int divide(int a, int b) {
        return a / b; // @divide
    }

    public static void main(String[] args) {
        int[] values = new int[2];
        System.out.println("before");
        System.out.println(divide(10, values.length - 2));
    }
}
`,
  "src/Echo.java": `import java.util.Scanner;

public class Echo {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        String name = in.nextLine();
        String greeting = "hello " + name; // @greet
        System.out.println(greeting);
        System.exit(5);
    }
}
`,
  "src/Exit.java": `public class Exit {
    public static void main(String[] args) {
        System.out.println("bye");
        System.exit(7);
    }
}
`,
  "src/Caught.java": `public class Caught {
    public static void main(String[] args) {
        int total = 0;
        for (int i = 0; i < 4; i++) {

            total += i; // @tally
        }
        try {
            Integer.parseInt("abc"); // @parse
        } catch (NumberFormatException e) {
            System.out.println("caught " + e.getMessage());
        }
        System.out.println("total=" + total);
    }
}
`,
  "src/Views.java": `import java.util.*;

public class Views {
    enum Color { RED, GREEN }
    static class Base { int id = 1; String tag = "base"; }
    static class Child extends Base { String tag = "child"; double w = 0.5; }

    public static void main(String[] args) {
        Color color = Color.GREEN;
        Integer boxed = 99;
        StringBuilder sb = new StringBuilder("ab").append('c');
        TreeMap<String, Integer> tree = new TreeMap<>(Map.of("b", 2, "a", 1));
        Set<Integer> set = new HashSet<>(List.of(5));
        Set<String> linked = new LinkedHashSet<>(List.of("x", "y"));
        LinkedList<String> chain = new LinkedList<>(List.of("p", "q"));
        int[] big = new int[150];
        big[149] = 7;
        Child child = new Child();
        String none = null;
        System.out.println(color); // @views
    }
}
`,
  "src/Forever.java": `public class Forever {
    public static void main(String[] args) throws Exception {
        for (int i = 0; ; i++) {
            System.out.println("tick " + i);
            Thread.sleep(200);
        }
    }
}
`,
};

let work: string;
let bundle: string;
let classes: string;
let src: string;

/** The 1-based line of the `// @marker` comment in a fixture. */
function lineOf(file: string, marker: string): number {
  const lines = SOURCES[file].split("\n");
  const i = lines.findIndex((l) => l.includes(`// @${marker}`));
  if (i < 0) throw new Error(`no marker ${marker} in ${file}`);
  return i + 1;
}

type Ev = { event: string; body: any };

class Client {
  private seq = 1;
  private pending = new Map<number, (m: any) => void>();
  private events: Ev[] = [];
  private waiters: { name: string; pred: (b: any) => boolean; resolve: (e: Ev) => void }[] = [];
  readonly output: string[] = [];
  readonly adapter: ChildProcess;
  onReverse?: (command: string, args: any) => Promise<any>;
  stderr = "";

  constructor() {
    this.adapter = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] });
    const reader = new DapReader((m) => this.onMessage(m));
    this.adapter.stdout!.on("data", (d: Buffer) => reader.feed(d));
    this.adapter.stderr!.on("data", (d: Buffer) => (this.stderr += d.toString()));
  }

  private onMessage(m: DapMessage) {
    if (m.type === "response") {
      this.pending.get(m.request_seq as number)?.(m);
      return;
    }
    if (m.type === "request") {
      const req = m as any;
      void (async () => {
        try {
          const body = await this.onReverse!(req.command, req.arguments);
          this.write({ seq: this.seq++, type: "response", request_seq: req.seq, command: req.command, success: true, body });
        } catch (e) {
          this.write({ seq: this.seq++, type: "response", request_seq: req.seq, command: req.command, success: false, message: String(e) });
        }
      })();
      return;
    }
    const ev = { event: m.event as string, body: (m as any).body };
    if (ev.event === "output") this.output.push(ev.body.output);
    const w = this.waiters.findIndex((x) => x.name === ev.event && x.pred(ev.body));
    if (w >= 0) {
      const [waiter] = this.waiters.splice(w, 1);
      waiter.resolve(ev);
    } else this.events.push(ev);
  }

  private write(m: object) {
    this.adapter.stdin!.write(encodeMessage(m));
  }

  async request(command: string, args: object = {}): Promise<any> {
    const seq = this.seq++;
    const r: any = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${command} timed out\n${this.stderr}`)), TIMEOUT);
      this.pending.set(seq, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.write({ seq, type: "request", command, arguments: args });
    });
    if (!r.success) throw new Error(`${command} failed: ${r.message}`);
    return r.body;
  }

  /** The next (not yet consumed) event with this name. */
  event(name: string, pred: (b: any) => boolean = () => true): Promise<any> {
    const i = this.events.findIndex((e) => e.event === name && pred(e.body));
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0].body);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ${name} event within ${TIMEOUT} ms; output: ${this.output.join("")}\n${this.stderr}`)), TIMEOUT);
      this.waiters.push({
        name,
        pred,
        resolve: (e) => {
          clearTimeout(t);
          resolve(e.body);
        },
      });
    });
  }

  async waitOutput(text: string) {
    const deadline = Date.now() + TIMEOUT;
    while (!this.output.join("").includes(text)) {
      if (Date.now() > deadline) throw new Error(`output never contained ${text}: ${this.output.join("")}`);
      await this.event("output");
    }
  }

  /** initialize + launch + breakpoints + configurationDone. */
  async start(launch: object, breakpoints: Record<string, { line: number; condition?: string }[]> = {}, exceptions: string[] = [], caps: object = {}) {
    await this.request("initialize", { adapterID: "java", linesStartAt1: true, columnsStartAt1: true, ...caps });
    const initialized = this.event("initialized");
    await this.request("launch", { cwd: work, classPaths: [classes], sourcePaths: [src], ...launch });
    await initialized;
    const results: Record<string, any[]> = {};
    for (const [file, bps] of Object.entries(breakpoints)) {
      results[file] = (await this.request("setBreakpoints", { source: { path: path.join(work, file) }, breakpoints: bps })).breakpoints;
    }
    await this.request("setExceptionBreakpoints", { filters: exceptions });
    await this.request("configurationDone");
    return results;
  }

  async topFrame(threadId: number) {
    const { stackFrames } = await this.request("stackTrace", { threadId, startFrame: 0, levels: 20 });
    return stackFrames[0];
  }

  async locals(frameId: number): Promise<Record<string, any>> {
    const { scopes } = await this.request("scopes", { frameId });
    const { variables } = await this.request("variables", { variablesReference: scopes[0].variablesReference });
    return Object.fromEntries(variables.map((v: any) => [v.name, v]));
  }

  async children(ref: number): Promise<Record<string, any>> {
    const { variables } = await this.request("variables", { variablesReference: ref });
    return Object.fromEntries(variables.map((v: any) => [v.name, v]));
  }

  async evaluate(expression: string, frameId: number, context = "watch"): Promise<string> {
    return (await this.request("evaluate", { expression, frameId, context })).result;
  }

  async close() {
    if (this.adapter.exitCode === null) {
      try {
        await Promise.race([this.request("disconnect", { terminateDebuggee: true }), new Promise((r) => setTimeout(r, 5000))]);
      } catch {
        // already gone
      }
      this.adapter.kill();
    }
  }
}

const clients: Client[] = [];
function client() {
  const c = new Client();
  clients.push(c);
  return c;
}

describe.skipIf(!hasJdk)("java-dap against a real JVM", () => {
  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "java-dap-test-"));
    src = path.join(work, "src");
    classes = path.join(work, "classes");
    for (const [file, text] of Object.entries(SOURCES)) {
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      fs.writeFileSync(path.join(work, file), text);
    }
    execFileSync("javac", ["-g", "-d", classes, ...Object.keys(SOURCES).map((f) => path.join(work, f))]);
    bundle = path.join(work, "java-dap.cjs");
    execFileSync(process.execPath, [path.join(here, "..", "build.mjs"), "--out", bundle]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  it("stops at a breakpoint, shows locals, evaluates, and steps in/out/over", async () => {
    const c = client();
    const callLine = lineOf("src/Main.java", "call");
    const stopped = c.event("stopped");
    const set = await c.start({ mainClass: "Main" }, { "src/Main.java": [{ line: callLine }] });
    expect(set["src/Main.java"][0]).toMatchObject({ line: callLine });

    const stop = await stopped;
    expect(stop.reason).toBe("breakpoint");
    expect((await c.event("breakpoint")).breakpoint).toMatchObject({ verified: true, line: callLine });
    const frame = await c.topFrame(stop.threadId);
    expect(frame.source.path).toBe(path.join(work, "src/Main.java"));
    expect(frame.line).toBe(callLine);
    expect(frame.name).toBe("Main.main(String[])");

    const v = await c.locals(frame.id);
    expect(v.x).toMatchObject({ value: "41", type: "int" });
    expect(v.d.value).toBe("2.5");
    expect(v.c.value).toBe("'q'");
    expect(v.flag.value).toBe("true");
    expect(v.big.value).toBe("1234567890123");
    expect(v.name).toMatchObject({ value: '"Ada"', type: "String" });
    expect(v.args).toMatchObject({ value: "[]", type: "String[]" });
    expect(v.nums).toMatchObject({ value: "[1, 2, 3]", type: "int[]" });
    expect(v.nums.variablesReference).toBeGreaterThan(0);
    const nums = await c.children(v.nums.variablesReference);
    expect(Object.keys(nums)).toEqual(["[0]", "[1]", "[2]"]);
    expect(nums["[2]"].value).toBe("3");
    expect(v.p.type).toBe("Main$Point");
    const p = await c.children(v.p.variablesReference);
    expect(p.x.value).toBe("3");
    expect(p.y.value).toBe("4");
    expect(p.label.value).toBe('"home"');
    expect(v.list.value).toBe("ArrayList (size=2)");
    const list = await c.children(v.list.variablesReference);
    expect(Object.values(list).map((e: any) => e.value)).toEqual(['"a"', '"b"']);
    const ages = await c.children(v.ages.variablesReference);
    expect(ages['"ann"'].value).toBe("12");
    expect(v.y).toBeUndefined(); // not declared yet

    const { scopes } = await c.request("scopes", { frameId: frame.id });
    const statics = await c.children(scopes[1].variablesReference);
    expect(statics.counter.value).toBe("7");

    expect(await c.evaluate("x + 1", frame.id)).toBe("42");
    expect(await c.evaluate("p.x", frame.id)).toBe("3");
    expect(await c.evaluate("p.x * 2 == 6 && !flag == false", frame.id)).toBe("true");
    expect(await c.evaluate("nums[1] + nums.length", frame.id)).toBe("5");
    expect(await c.evaluate("name.length()", frame.id)).toBe("3");
    expect(await c.evaluate("name + \"!\" + x", frame.id)).toBe('"Ada!41"');
    expect(await c.evaluate("7 / 2 + d", frame.id)).toBe("5.5");
    expect(await c.evaluate("counter", frame.id)).toBe("7");
    expect(await c.evaluate("list.get(1)", frame.id)).toBe('"b"');
    expect(await c.evaluate("p", frame.id, "hover")).toMatch(/^Main\$Point/);
    await expect(c.evaluate("nope + 1", frame.id)).rejects.toThrow(/cannot find symbol: nope/);

    // Step into square().
    let next = c.event("stopped");
    await c.request("stepIn", { threadId: stop.threadId });
    expect((await next).reason).toBe("step");
    let top = await c.topFrame(stop.threadId);
    expect(top.name).toBe("Main.square(int)");
    expect(top.line).toBe(lineOf("src/Main.java", "square"));
    expect((await c.locals(top.id)).n.value).toBe("41");

    // Step out back to main (still on the call line).
    next = c.event("stopped");
    await c.request("stepOut", { threadId: stop.threadId });
    expect((await next).reason).toBe("step");
    top = await c.topFrame(stop.threadId);
    expect(top.name).toBe("Main.main(String[])");
    expect(top.line).toBe(callLine);

    // Step over to the next line: y is now assigned.
    next = c.event("stopped");
    await c.request("next", { threadId: stop.threadId });
    expect((await next).reason).toBe("step");
    top = await c.topFrame(stop.threadId);
    expect(top.line).toBe(lineOf("src/Main.java", "after"));
    expect((await c.locals(top.id)).y.value).toBe("1681");

    const exited = c.event("exited");
    const terminated = c.event("terminated");
    await c.request("continue", { threadId: stop.threadId });
    expect((await exited).exitCode).toBe(0);
    await terminated;
    expect(c.output.join("")).toContain("sum=10 twice=20");
  }, 90_000);

  it("honours a conditional breakpoint inside a loop", async () => {
    const c = client();
    const loop = lineOf("src/Main.java", "loop");
    const stopped = c.event("stopped");
    await c.start({ mainClass: "Main" }, { "src/Main.java": [{ line: loop, condition: "i == 3" }] });
    const stop = await stopped;
    const frame = await c.topFrame(stop.threadId);
    expect(frame.line).toBe(loop);
    const v = await c.locals(frame.id);
    expect(v.i.value).toBe("3");
    expect(v.sum.value).toBe("3");
    const exited = c.event("exited");
    await c.request("continue", { threadId: stop.threadId });
    expect((await exited).exitCode).toBe(0);
    // It never stopped again.
    expect(c.output.join("")).toContain("sum=10");
  }, 60_000);

  it("stops in a class inside a package (src/com/example/Util.java)", async () => {
    const c = client();
    const line = lineOf("src/com/example/Util.java", "twice");
    const stopped = c.event("stopped");
    await c.start({ mainClass: "Main" }, { "src/com/example/Util.java": [{ line }] });
    const stop = await stopped;
    const frame = await c.topFrame(stop.threadId);
    expect(frame.source.path).toBe(path.join(work, "src/com/example/Util.java"));
    expect(frame.line).toBe(line);
    expect(frame.name).toBe("Util.twice(int)");
    expect((await c.locals(frame.id)).v.value).toBe("10");
    const { stackFrames } = await c.request("stackTrace", { threadId: stop.threadId });
    expect(stackFrames[1].source.path).toBe(path.join(work, "src/Main.java"));
    const exited = c.event("exited");
    await c.request("continue", { threadId: stop.threadId });
    expect((await exited).exitCode).toBe(0);
  }, 60_000);

  it("stops on an uncaught exception with its message", async () => {
    const c = client();
    const stopped = c.event("stopped");
    await c.start({ mainClass: "Crash" }, {}, ["uncaught"]);
    const stop = await stopped;
    expect(stop.reason).toBe("exception");
    expect(stop.text).toBe("java.lang.ArithmeticException: / by zero");
    const info = await c.request("exceptionInfo", { threadId: stop.threadId });
    expect(info).toMatchObject({ exceptionId: "java.lang.ArithmeticException", description: "/ by zero", breakMode: "unhandled" });
    const frame = await c.topFrame(stop.threadId);
    expect(frame.line).toBe(lineOf("src/Crash.java", "divide"));
    const v = await c.locals(frame.id);
    expect(v["<exception>"].type).toBe("ArithmeticException");
    expect(v.b.value).toBe("0");
    const exited = c.event("exited");
    await c.request("continue", { threadId: stop.threadId });
    expect((await exited).exitCode).toBe(1);
    expect(c.output.join("")).toContain("before");
  }, 60_000);

  it("reports the exit code and program output (internal console)", async () => {
    const c = client();
    const exited = c.event("exited");
    await c.start({ mainClass: "Exit" });
    expect((await exited).exitCode).toBe(7);
    await c.event("terminated");
    expect(c.output.join("")).toContain("bye\n");
    expect(c.output.join("")).not.toContain("Listening for transport");
  }, 60_000);

  it("stops on entry", async () => {
    const c = client();
    const stopped = c.event("stopped");
    await c.start({ mainClass: "Main", stopOnEntry: true });
    const stop = await stopped;
    expect(stop.reason).toBe("entry");
    expect((await c.topFrame(stop.threadId)).line).toBe(lineOf("src/Main.java", "entry"));
    await c.request("terminate");
    await c.event("terminated");
  }, 60_000);

  it("runs in the client's terminal via runInTerminal so the program can read stdin", async () => {
    const c = client();
    let program: ChildProcess | undefined;
    let programOut = "";
    let runArgs: any;
    c.onReverse = async (command, args) => {
      expect(command).toBe("runInTerminal");
      runArgs = args;
      program = spawn(args.args[0], args.args.slice(1), { cwd: args.cwd, stdio: ["pipe", "pipe", "inherit"] });
      program.stdout!.on("data", (d: Buffer) => (programOut += d.toString()));
      program.stdin!.write("Bob\n");
      return { processId: program.pid };
    };
    const greet = lineOf("src/Echo.java", "greet");
    const stopped = c.event("stopped");
    await c.start({ mainClass: "Echo", console: "integratedTerminal" }, { "src/Echo.java": [{ line: greet }] }, [], { supportsRunInTerminalRequest: true });
    expect(runArgs.kind).toBe("integrated");
    expect(runArgs.args).toContain("Echo");
    const stop = await stopped;
    const frame = await c.topFrame(stop.threadId);
    expect(frame.line).toBe(greet);
    expect((await c.locals(frame.id)).name.value).toBe('"Bob"');
    const exited = c.event("exited");
    await c.request("continue", { threadId: stop.threadId });
    expect((await exited).exitCode).toBe(5);
    await c.event("terminated");
    const code = await new Promise((r) => (program!.exitCode !== null ? r(program!.exitCode) : program!.on("exit", r)));
    expect(code).toBe(5);
    expect(programOut).toContain("hello Bob");
    expect(c.output.join("")).not.toContain("hello Bob"); // the terminal owns stdout
  }, 60_000);

  it("terminate kills the JVM", async () => {
    const c = client();
    let program: ChildProcess | undefined;
    c.onReverse = async (_command, args) => {
      program = spawn(args.args[0], args.args.slice(1), { cwd: args.cwd, stdio: ["ignore", "pipe", "inherit"] });
      return { processId: program.pid };
    };
    await c.start({ mainClass: "Forever", console: "integratedTerminal" }, {}, [], { supportsRunInTerminalRequest: true });
    await new Promise<void>((resolve) => {
      program!.stdout!.on("data", (d: Buffer) => d.toString().includes("tick 1") && resolve());
    });
    const gone = new Promise((r) => (program!.exitCode !== null ? r(program!.exitCode) : program!.on("exit", r)));
    const terminated = c.event("terminated");
    await c.request("terminate");
    await terminated;
    await gone;
    expect(program!.exitCode).not.toBeNull();
  }, 60_000);

  it("terminate kills a JVM it spawned itself, and pause shows where it was", async () => {
    const c = client();
    await c.start({ mainClass: "Forever" });
    await c.waitOutput("tick 1");
    const stopped = c.event("stopped");
    await c.request("pause", { threadId: 1 });
    const stop = await stopped;
    expect(stop.reason).toBe("pause");
    const { threads } = await c.request("threads");
    expect(threads.map((t: any) => t.name)).toContain("main");
    const exited = c.event("exited");
    await c.request("terminate");
    expect(typeof (await exited).exitCode).toBe("number");
    await c.event("terminated");
  }, 60_000);

  it("supports hit counts, logpoints, setVariable, blank-line breakpoints and caught exceptions", async () => {
    const c = client();
    const tally = lineOf("src/Caught.java", "tally");
    const stopped = c.event("stopped");
    const set = await c.start(
      { mainClass: "Caught" },
      {
        "src/Caught.java": [
          { line: tally, hitCondition: ">= 3" } as any,
          { line: tally - 1, logMessage: "i is {i}, total {total}" } as any, // a blank line: moves down to `total += i`
        ],
      },
      ["caught"],
    );
    expect(set["src/Caught.java"]).toHaveLength(2);
    expect((await c.event("breakpoint", (b) => b.breakpoint.id === set["src/Caught.java"][1].id)).breakpoint).toMatchObject({ verified: true, line: tally });
    const stop = await stopped;
    expect(stop.reason).toBe("breakpoint");
    const frame = await c.topFrame(stop.threadId);
    const v = await c.locals(frame.id);
    expect(v.i.value).toBe("2"); // third hit
    const { scopes } = await c.request("scopes", { frameId: frame.id });
    const changed = await c.request("setVariable", { variablesReference: scopes[0].variablesReference, name: "total", value: "100" });
    expect(changed.value).toBe("100");
    expect(await c.evaluate("total + i", frame.id)).toBe("102");

    // The next stop is the caught NumberFormatException (the hit count keeps matching at i == 3 first).
    let next = c.event("stopped");
    await c.request("continue", { threadId: stop.threadId });
    expect((await next).reason).toBe("breakpoint");
    next = c.event("stopped");
    await c.request("continue", { threadId: stop.threadId });
    const ex = await next;
    expect(ex.reason).toBe("exception");
    expect(ex.text).toBe('java.lang.NumberFormatException: For input string: "abc"');
    expect((await c.request("exceptionInfo", { threadId: ex.threadId })).breakMode).toBe("always");

    const exited = c.event("exited");
    await c.request("continue", { threadId: stop.threadId });
    expect((await exited).exitCode).toBe(0);
    const out = c.output.join("");
    expect(out).toMatch(/i is 0, total 0/);
    expect(out).toContain("caught For input string");
    expect(out).toContain("total=");
  }, 60_000);

  it("attaches to a JVM started with -agentlib:jdwp", async () => {
    const net = await import("node:net");
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as any).port;
        s.close(() => resolve(p));
      });
    });
    const jvm = spawn("java", [`-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${port},quiet=y`, "-cp", classes, "Main"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    jvm.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    const c = client();
    await c.request("initialize", { adapterID: "java" });
    const initialized = c.event("initialized");
    await c.request("attach", { port, sourcePaths: [src] });
    await initialized;
    const line = lineOf("src/com/example/Util.java", "twice");
    await c.request("setBreakpoints", { source: { path: path.join(src, "com/example/Util.java") }, breakpoints: [{ line }] });
    const stopped = c.event("stopped");
    await c.request("configurationDone");
    const stop = await stopped;
    expect((await c.topFrame(stop.threadId)).line).toBe(line);
    const exited = c.event("exited");
    await c.request("continue", { threadId: stop.threadId });
    expect((await exited).exitCode).toBe(0);
    await new Promise((r) => (jvm.exitCode !== null ? r(null) : jvm.on("exit", r)));
    expect(out).toContain("twice=20");
  }, 60_000);

  it("shows enums, boxed values, builders, collections, chunked arrays and inherited fields", async () => {
    const c = client();
    const stopped = c.event("stopped");
    await c.start({ mainClass: "Views" }, { "src/Views.java": [{ line: lineOf("src/Views.java", "views") }] });
    const stop = await stopped;
    const frame = await c.topFrame(stop.threadId);
    const v = await c.locals(frame.id);
    expect(v.color).toMatchObject({ value: "GREEN", type: "Views$Color" });
    expect(v.boxed).toMatchObject({ value: "99", type: "Integer", variablesReference: 0 });
    expect(v.sb.value).toBe('"abc"');
    expect(v.none).toMatchObject({ value: "null", type: "String" });
    expect(v.tree.value).toBe("TreeMap (size=2)");
    const tree = await c.request("variables", { variablesReference: v.tree.variablesReference });
    expect(tree.variables.map((x: any) => [x.name, x.value])).toEqual([
      ['"a"', "1"],
      ['"b"', "2"],
    ]);
    expect(v.set.value).toBe("HashSet (size=1)");
    expect(Object.values(await c.children(v.set.variablesReference)).map((x: any) => x.value)).toEqual(["5"]);
    expect(Object.values(await c.children(v.linked.variablesReference)).map((x: any) => x.value)).toEqual(['"x"', '"y"']);
    expect(Object.values(await c.children(v.chain.variablesReference)).map((x: any) => x.value)).toEqual(['"p"', '"q"']);
    expect(v.big).toMatchObject({ value: "int[150]", indexedVariables: 150 });
    const chunks = await c.children(v.big.variablesReference);
    expect(Object.keys(chunks)).toEqual(["[0..99]", "[100..149]"]);
    const tail = await c.children(chunks["[100..149]"].variablesReference);
    expect(tail["[149]"]).toMatchObject({ value: "7", evaluateName: "big[149]" });
    const child = await c.children(v.child.variablesReference);
    expect(child.tag.value).toBe('"child"');
    expect(child["tag (Base)"].value).toBe('"base"');
    expect(child.id.value).toBe("1");
    expect(child.w.value).toBe("0.5");
    const set2 = await c.request("setVariable", { variablesReference: v.child.variablesReference, name: "tag (Base)", value: '"changed"' });
    expect(set2.value).toBe('"changed"');
    expect(await c.evaluate("((Object) child) == null", frame.id).catch(() => "unsupported")).toBe("unsupported");
    expect(await c.evaluate("child.w * 4 + boxed", frame.id)).toBe("101.0");
    expect(await c.evaluate("color.name()", frame.id)).toBe('"GREEN"');
    expect(await c.evaluate("big[149] > 6 ? \"yes\" : \"no\"", frame.id)).toBe('"yes"');
    await expect(c.evaluate("big[150]", frame.id)).rejects.toThrow(/out of bounds/);
    await expect(c.evaluate("none.length()", frame.id)).rejects.toThrow(/NullPointerException/);
    const exited = c.event("exited");
    await c.request("continue", { threadId: stop.threadId });
    expect((await exited).exitCode).toBe(0);
  }, 60_000);
});
