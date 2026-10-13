import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { containerConfig, ContainerSandbox, probeContainers } from "./containers.ts";
import { Docker } from "./docker.ts";
import { resolvePrograms } from "./judge.ts";
import { containerLauncher } from "./previews.ts";
import { LocalSandbox } from "./sandbox.ts";
import { SessionManager, type SessionEvent } from "./sessions.ts";
import { resolveToolchains } from "./toolchains.ts";
import { FakeDocker } from "./testkit/fakeDocker.ts";

/** PTY sessions and the preview launcher against a fake Engine API. */

const workdir = mkdtempSync(join(tmpdir(), "tmj-ptest-"));
const cfg = containerConfig({ JUDGE_CONTAINERS: "1", JUDGE_CONTAINER_UID: "1500", JUDGE_CONTAINER_GID: "1500", JUDGE_CONTAINER_WORKDIR: workdir });

async function setup(images: string[]) {
  const fake = new FakeDocker();
  for (const rt of images) fake.images.add(cfg.images[rt] ?? rt);
  const tc = resolveToolchains({ lookup: false });
  tc.containers = { config: cfg, status: await probeContainers(new Docker(fake), cfg) };
  const containers = new ContainerSandbox(new Docker(fake), cfg);
  const m = new SessionManager(new LocalSandbox(), resolvePrograms(), tc, {}, containers);
  return { fake, tc, containers, m };
}

function listen(m: SessionManager, id: string) {
  const events: SessionEvent[] = [];
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const waiters: [(e: SessionEvent[]) => boolean, () => void][] = [];
  const res = {
    writeHead() {},
    write(chunk: string) {
      const x = /^event: (\w+)\ndata: (.*)\n\n$/s.exec(chunk);
      if (x) events.push({ event: x[1], data: JSON.parse(x[2]) } as SessionEvent);
      for (const w of [...waiters]) if (w[0](events)) w[1]();
      return true;
    },
    end: () => done(),
    on() {},
  };
  m.subscribe(id, res as unknown as ServerResponse);
  const until = (pred: (e: SessionEvent[]) => boolean) => (pred(events) ? Promise.resolve() : new Promise<void>((r) => waiters.push([pred, r])));
  return { events, finished, until };
}

describe("PTY sessions", () => {
  it("refuses pty without a container tier, and resize on a pipes session", async () => {
    const tc = resolveToolchains({ lookup: false });
    const m = new SessionManager(new LocalSandbox(), resolvePrograms(), tc);
    expect(() => m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "" }], pty: true })).toThrow(expect.objectContaining({ status: 409, code: "PTY_UNAVAILABLE" }));
  });

  it("refuses pty for a kind without a container image", async () => {
    const { m } = await setup(["python-3.12"]);
    expect(() => m.create({ kind: "c/single", files: [{ path: "main.c", content: "int main(){}" }], pty: true })).toThrow(expect.objectContaining({ code: "PTY_UNAVAILABLE" }));
  });

  it("runs a profile program on a terminal: raw bytes, typed lines, resize, Ctrl+C", async () => {
    const { m, fake } = await setup(["python-3.12"]);
    let container: { stdin: Buffer[] } | null = null;
    fake.program = (c) => {
      container = c;
      c.stdout("\x1b[32mName? \x1b[0m");
    };
    const { id } = m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "input('Name? ')" }], pty: true });
    const s = listen(m, id);
    await s.until((e) => e.some((x) => x.event === "stdout"));
    m.stdin(id, { data: "Ada\n" });
    m.resize(id, { cols: 100, rows: 40 });
    m.signal(id, { name: "SIGINT" });
    await s.finished;
    expect(s.events.find((e) => e.event === "stdout")?.data).toEqual({ data: "\x1b[32mName? \x1b[0m" });
    expect(Buffer.concat(container!.stdin).toString()).toBe("Ada\n");
    expect(s.events.at(-1)).toMatchObject({ event: "exit", data: { code: 130, signal: "SIGINT", verdict: "runtime-error" } });
    const created = fake.callsTo(/POST \/containers\/create/)[0].body;
    expect(created.Tty).toBe(true);
    expect(created.Cmd).toEqual(["/usr/bin/python3", "-u", "main.py"]);
    expect(created.Env).toEqual(expect.arrayContaining(["TERM=xterm-256color", "COLUMNS=120", "LINES=30"]));
    expect(fake.callsTo(/resize\?h=30&w=120/).length).toBe(1);
    expect(fake.callsTo(/resize\?h=40&w=100/).length).toBe(1);
    expect(fake.callsTo(/kill\?signal=SIGINT/).length).toBe(1);
    expect(() => m.resize(id, { cols: 80, rows: 24 })).toThrow(expect.objectContaining({ code: "SESSION_ENDED" }));
  });

  it("validates terminal sizes and refuses resize without a terminal", async () => {
    const { m, fake } = await setup(["python-3.12", "dotnet-8"]);
    fake.program = () => {};
    expect(() => m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "" }], pty: true, cols: 5 })).toThrow(/cols must be/);
    const { id } = m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "" }], pty: true });
    expect(() => m.resize(id, { cols: 9999, rows: 10 })).toThrow(/cols must be/);
    expect(() => m.resize(id, {})).toThrow(/resize needs/);
    await m.remove(id);
    // A container-tier kind without pty runs on pipes in a container: no terminal to resize.
    const p = m.create({ kind: "csharp/single", files: [{ path: "Program.cs", content: "" }] });
    expect(() => m.resize(p.id, { cols: 80, rows: 24 })).toThrow(expect.objectContaining({ code: "NOT_A_TERMINAL" }));
    await m.remove(p.id);
  });
});

describe("preview launcher", () => {
  it("builds in the image on the preview's internal network and reports a failed build", async () => {
    const { tc, containers, fake } = await setup(["typescript"]);
    fake.program = (c) => {
      c.stderr("error TS2304: Cannot find name 'x'.\n");
      c.exit(2);
    };
    const launch = containerLauncher({ toolchains: tc, containers })(
      { kind: "ts/nest", files: [{ path: "package.json", content: "{}" }, { path: "src/main.ts", content: "x" }] },
      "pv1",
      { stage: (n) => stages.push(n), log: (_s, d) => logs.push(d) },
    );
    const stages: string[] = [];
    const logs: string[] = [];
    await expect(launch.ready).rejects.toThrow(/step failed/);
    await launch.stop();
    expect(logs.join("")).toMatch(/TS2304/);
    const net = fake.callsTo(/POST \/networks\/create/)[0].body;
    expect(net).toMatchObject({ Name: "tmj-pv-pv1", Internal: true });
    expect(fake.callsTo(/POST \/containers\/create/)[0].body.HostConfig.NetworkMode).toBe("tmj-pv-pv1");
    expect(fake.networks.size).toBe(0);
    expect(fake.containers.size).toBe(0);
  });

  it("refuses kinds without a server", async () => {
    const { tc, containers } = await setup(["dotnet-8"]);
    expect(() => containerLauncher({ toolchains: tc, containers })({ kind: "csharp/console", files: [{ path: "a.csproj", content: "" }] }, "x", { stage() {}, log() {} })).toThrow(/no web server/);
  });
});
