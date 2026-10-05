import { describe, expect, it } from "vitest";
import { normalizeOutput as protocolNormalize } from "../../../packages/protocol/src/output";
import { judge, normalizeOutput, resolvePrograms, validate, type RunRequest } from "./judge.ts";
import { extraMounts, IsolateSandbox, LocalSandbox, parseMeta, statusFromMeta, type Sandbox } from "./sandbox.ts";

/**
 * Runs against the local (unsandboxed) driver by default; CI on Linux sets
 * JUDGE_TEST_SANDBOX=isolate to run the same cases — plus the containment
 * ones — inside real isolate boxes.
 */
const useIsolate = process.env.JUDGE_TEST_SANDBOX === "isolate";
const sandbox: Sandbox = useIsolate ? new IsolateSandbox(process.env.ISOLATE_BIN ?? "isolate", 2) : new LocalSandbox();
const programs = resolvePrograms();
const has = (...p: string[]) => p.every((x) => programs.has(x));
const run = (req: Omit<RunRequest, "tests"> & { tests?: RunRequest["tests"] }) =>
  judge(sandbox, programs, { tests: [{ id: "1", input: "", expected_output: undefined }], ...req } as RunRequest);

describe("normalizeOutput", () => {
  it("is the same rule as the protocol package", () => {
    for (const s of ["a\r\nb\r\n", "x  \n\n", "", "  lead"]) expect(normalizeOutput(s)).toBe(protocolNormalize(s));
  });
});

describe("request validation", () => {
  it("refuses bad paths, unknown languages and missing entries", () => {
    const base = { language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "" }], tests: [{ id: "1", input: "" }] };
    expect(() => validate({ ...base, language: "cobol" })).toThrow(/Unsupported language/);
    expect(() => validate({ ...base, files: [{ path: "../x.py", content: "" }] })).toThrow(/Invalid file path/);
    expect(() => validate({ ...base, files: [{ path: "/etc/passwd", content: "" }] })).toThrow(/Invalid file path/);
    expect(() => validate({ ...base, entry: "other.py" })).toThrow(/Entry/);
    expect(() => validate({ ...base, tests: [] })).toThrow(/No tests/);
  });
});

describe("extra mounts", () => {
  it("mounts toolchains installed outside the system folders", () => {
    expect(extraMounts("/usr/bin/python3")).toEqual([]);
    expect(extraMounts("/opt/hostedtoolcache/node/24.1.0/x64/bin/node")).toEqual(["/opt/hostedtoolcache/node/24.1.0/x64"]);
    expect(extraMounts("/home/u/.nvm/versions/node/v22.1.0/bin/node")).toEqual(["/home/u/.nvm/versions/node/v22.1.0"]);
    expect(extraMounts("./main")).toEqual([]);
  });
});

describe("isolate meta parsing", () => {
  const limits = { cpuS: 1, wallS: 2, memoryMb: 64, processes: 8, outputKb: 64 };
  it("maps statuses", () => {
    expect(statusFromMeta(parseMeta("status:TO\ntime:1.01\n"), false, limits)).toBe("timeout");
    expect(statusFromMeta(parseMeta("status:RE\nexitcode:1\n"), false, limits)).toBe("runtime-error");
    expect(statusFromMeta(parseMeta("status:SG\nexitsig:9\ncg-oom-killed:1\n"), false, limits)).toBe("memory");
    expect(statusFromMeta(parseMeta("status:SG\nexitsig:25\n"), false, limits)).toBe("output-limit");
    expect(statusFromMeta(parseMeta("time:0.01\nexitcode:0\n"), false, limits)).toBe("ok");
  });
});

describe.runIf(has("python3"))("python-3", () => {
  const files = [{ path: "main.py", content: "a, b = map(int, input().split())\nprint(a + b)\n" }];
  it("accepts correct output and flags wrong answers per test", async () => {
    const r = await judge(sandbox, programs, {
      language: "python-3",
      entry: "main.py",
      files,
      tests: [
        { id: "ok", input: "2 3\n", expected_output: "5\n" },
        { id: "wrong", input: "2 3\n", expected_output: "6\n" },
      ],
    });
    expect(r.tests.map((t) => [t.id, t.verdict, t.passed])).toEqual([
      ["ok", "accepted", true],
      ["wrong", "wrong-answer", false],
    ]);
  });

  it("reports runtime errors with stderr", async () => {
    const r = await run({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "print(1/0)\n" }] });
    expect(r.tests[0].verdict).toBe("runtime-error");
    expect(r.tests[0].stderr).toContain("ZeroDivisionError");
  });

  it("stops infinite loops", async () => {
    const r = await run({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "while True: pass\n" }], limits: { time_s: 1, wall_s: 2 } });
    expect(r.tests[0].verdict).toBe("time-limit");
  });

  it("stops runaway output", async () => {
    const r = await run({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "while True: print('x' * 1000)\n" }], limits: { output_kb: 64, wall_s: 5 } });
    expect(r.tests[0].verdict).toBe("output-limit");
  });
});

describe.runIf(has("gcc"))("c17", () => {
  it("compiles once and runs each test", async () => {
    const r = await judge(sandbox, programs, {
      language: "c17",
      entry: "main.c",
      files: [
        { path: "main.c", content: '#include <stdio.h>\nint add(int,int);\nint main(void){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",add(a,b));return 0;}\n' },
        { path: "add.c", content: "int add(int a, int b) { return a + b; }\n" },
      ],
      tests: [
        { id: "1", input: "2 3", expected_output: "5" },
        { id: "2", input: "-1 1", expected_output: "0" },
      ],
    });
    expect(r.compile?.ok).toBe(true);
    expect(r.tests.every((t) => t.passed)).toBe(true);
  });

  it("returns compiler errors and fails every test", async () => {
    const r = await run({ language: "c17", entry: "main.c", files: [{ path: "main.c", content: "int main(void) { return 0 }\n" }] });
    expect(r.compile?.ok).toBe(false);
    expect(r.compile?.output).toMatch(/main\.c:1:/);
    expect(r.tests[0].passed).toBe(false);
  });
});

describe.runIf(has("javac", "java"))("java-21", () => {
  it("runs the class named after the entry file", async () => {
    const r = await judge(sandbox, programs, {
      language: "java-21",
      entry: "Main.java",
      files: [{ path: "Main.java", content: "public class Main { public static void main(String[] a) { System.out.println(new java.util.Scanner(System.in).nextInt() * 2); } }\n" }],
      tests: [{ id: "1", input: "21\n", expected_output: "42\n" }],
    });
    expect(r.tests[0].verdict).toBe("accepted");
  });
});

describe.runIf(has("node"))("node-22", () => {
  it("reads stdin", async () => {
    const r = await judge(sandbox, programs, {
      language: "node-22",
      entry: "main.js",
      files: [{ path: "main.js", content: "const n = Number(require('fs').readFileSync(0, 'utf8')); console.log(n * n);\n" }],
      tests: [{ id: "1", input: "7\n", expected_output: "49\n" }],
    });
    expect(r.tests[0].verdict).toBe("accepted");
  });
});

// Containment: only meaningful inside a real sandbox.
describe.runIf(useIsolate && has("python3"))("isolate containment", () => {
  const py = (code: string, limits?: RunRequest["limits"]) => run({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: code }], limits });

  it("enforces the memory limit", async () => {
    const r = await py("x = bytearray(600 * 1024 * 1024)\nprint(len(x))\n", { memory_mb: 128 });
    expect(["memory-limit", "runtime-error"]).toContain(r.tests[0].verdict);
    expect(r.tests[0].stdout).not.toContain("629145600");
  });

  it("has no network", async () => {
    const r = await py("import socket\ns = socket.create_connection(('1.1.1.1', 80), timeout=2)\nprint('connected')\n");
    expect(r.tests[0].stdout).not.toContain("connected");
  });

  it("contains fork bombs", async () => {
    const r = await py("import os\nwhile True:\n    os.fork()\n", { time_s: 2, wall_s: 3 });
    expect(r.tests[0].verdict).not.toBe("accepted");
  });

  it("cannot read host secrets or write outside the box", async () => {
    const r = await py(
      "import os\nfor p in ['/etc/shadow', '/root', '/opt/apps']:\n    try:\n        print(p, 'READ', len(os.listdir(p)) if os.path.isdir(p) else len(open(p).read()))\n    except Exception as e:\n        print(p, 'DENIED')\ntry:\n    open('/tmp/escape', 'w').write('x'); print('WROTE')\nexcept Exception:\n    print('NOWRITE')\n",
    );
    const out = r.tests[0].stdout;
    expect(out).toContain("/etc/shadow DENIED");
    expect(out).not.toMatch(/\/opt\/apps READ/);
  });
});
