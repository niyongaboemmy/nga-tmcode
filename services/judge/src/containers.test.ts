import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kindById } from "../../../packages/runtimes/src/index.ts";
import {
  checkSafe,
  containerBody,
  containerConfig,
  ContainerConfigError,
  ContainerSandbox,
  containerToolchains,
  IMAGE_DIRS,
  offStatus,
  probeContainers,
  spawnContainer,
  statusFromExit,
  type ContainerConfig,
} from "./containers.ts";
import { demux, Demuxer, Docker } from "./docker.ts";
import { resolveProject, runProject } from "./project.ts";
import { tierFeatures } from "./server.ts";
import { availability, catalogView, detectView, resolveToolchains } from "./toolchains.ts";
import { FakeDocker, frame } from "./testkit/fakeDocker.ts";
import { LocalSandbox } from "./sandbox.ts";

/** Tier 3 without a Docker daemon: request building, availability and the box lifecycle against a fake Engine API. */

const workdir = mkdtempSync(join(tmpdir(), "tmj-ctest-"));
const cfgOf = (over: Partial<ContainerConfig> = {}): ContainerConfig => ({
  ...containerConfig({ JUDGE_CONTAINERS: "1", JUDGE_CONTAINER_UID: "1500", JUDGE_CONTAINER_GID: "1500", JUDGE_CONTAINER_WORKDIR: workdir }),
  ...over,
});
const limits = { cpuS: 5, wallS: 10, memoryMb: 256, processes: 32, outputKb: 64 };

describe("container bodies", () => {
  const cfg = cfgOf();
  const body = containerBody(cfg, {
    image: "nga-runner/dotnet-8:2026.10.1",
    argv: ["/usr/bin/dotnet", "run"],
    env: { DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    cwd: "src/App",
    limits,
    hostBox: "/run/tm-judge/boxes/box-1",
    mounts: [{ inside: "/caches/nuget-school", host: "/opt/tm-judge/caches/nuget-school" }],
  });
  const hc = body.HostConfig;

  it("sets every security flag", () => {
    expect(hc.Runtime).toBe("runsc");
    expect(hc.NetworkMode).toBe("none");
    expect(body.NetworkDisabled).toBe(true);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.Tmpfs["/tmp"]).toMatch(/^rw,nosuid,nodev,size=256m/);
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(hc.Privileged).toBe(false);
    expect(hc.PidsLimit).toBe(32);
    expect(hc.Memory).toBe(256 * 1024 * 1024);
    expect(hc.MemorySwap).toBe(hc.Memory);
    expect(hc.NanoCpus).toBe(1e9);
    expect(hc.Init).toBe(true);
    expect(body.User).toBe("1500:1500");
    expect(hc.Ulimits).toContainEqual({ Name: "fsize", Soft: 1024 * 1024, Hard: 1024 * 1024 });
    expect(hc.LogConfig.Type).toBe("none");
    expect(hc).not.toHaveProperty("CgroupParent");
    expect(containerBody({ ...cfg, cgroupParent: "tm-judge-containers.slice" }, { image: "x", argv: ["a"], env: {}, limits, hostBox: "/b", mounts: [] }).HostConfig.CgroupParent).toBe("tm-judge-containers.slice");
  });

  it("binds the box read-write and cache layers read-only", () => {
    expect(hc.Binds).toEqual(["/run/tm-judge/boxes/box-1:/box:rw", "/opt/tm-judge/caches/nuget-school:/caches/nuget-school:ro"]);
    expect(body.WorkingDir).toBe("/box/src/App");
    expect(body.Env).toContain("HOME=/box");
    expect(body.Env).toContain("DOTNET_CLI_TELEMETRY_OPTOUT=1");
    expect(body.Cmd).toEqual(["/usr/bin/dotnet", "run"]);
  });

  it("caps memory at the runner's maximum and joins a run network only when given one", () => {
    const b = containerBody({ ...cfg, memoryCapMb: 512 }, { image: "x", argv: ["a"], env: {}, limits: { ...limits, memoryMb: 4096 }, hostBox: "/b", mounts: [], network: "tmj-db-1", tty: true });
    expect(b.HostConfig.Memory).toBe(512 * 1024 * 1024);
    expect(b.HostConfig.NetworkMode).toBe("tmj-db-1");
    expect(b.NetworkDisabled).toBe(false);
    expect(b.Tty).toBe(true);
  });
});

describe("container settings", () => {
  it("is off unless JUDGE_CONTAINERS=1", () => {
    expect(containerConfig({}).enabled).toBe(false);
  });
  it("refuses runc unless JUDGE_ALLOW_RUNC=1", () => {
    expect(() => containerConfig({ JUDGE_CONTAINERS: "1", JUDGE_CONTAINER_RUNTIME: "runc", JUDGE_CONTAINER_UID: "1500", JUDGE_CONTAINER_GID: "1500" })).toThrow(ContainerConfigError);
    expect(containerConfig({ JUDGE_CONTAINERS: "1", JUDGE_CONTAINER_RUNTIME: "runc", JUDGE_ALLOW_RUNC: "1", JUDGE_CONTAINER_UID: "1500", JUDGE_CONTAINER_GID: "1500" }).runtime).toBe("runc");
  });
  it("never runs containers as root", () => {
    expect(() => checkSafe({ runtime: "runsc", uid: 0, gid: 0 }, {})).toThrow(/root/);
  });
  it("names an image for every container-tier runtime", () => {
    const cfg = cfgOf();
    for (const k of [...new Set(["csharp/console", "kotlin/gradle", "java/spring-boot", "flutter/app", "js/express", "python/flask", "sql/postgres", "sql/mysql"])]) {
      const rt = kindById(k)!.runtime;
      expect(IMAGE_DIRS[rt], k).toBeDefined();
      expect(cfg.images[rt]).toMatch(/^nga-runner\//);
    }
    expect(containerConfig({ JUDGE_CONTAINER_IMAGES: '{"dotnet-8":"registry.local/dotnet:8"}' }).images["dotnet-8"]).toBe("registry.local/dotnet:8");
  });
});

describe("exit status", () => {
  it("maps container exits to sandbox statuses", () => {
    expect(statusFromExit({ code: 0, oom: false, timedOut: false, outputOver: false }).status).toBe("ok");
    expect(statusFromExit({ code: 1, oom: false, timedOut: false, outputOver: false }).status).toBe("runtime-error");
    expect(statusFromExit({ code: 137, oom: true, timedOut: false, outputOver: false }).status).toBe("memory");
    expect(statusFromExit({ code: 137, oom: false, timedOut: true, outputOver: false }).status).toBe("timeout");
    expect(statusFromExit({ code: 137, oom: false, timedOut: false, outputOver: true }).status).toBe("output-limit");
    expect(statusFromExit({ code: 139, oom: false, timedOut: false, outputOver: false })).toEqual({ status: "signal", message: "Killed by SIGSEGV" });
    expect(statusFromExit({ code: null, oom: false, timedOut: false, outputOver: false, error: "boom" }).status).toBe("internal");
  });
});

describe("Docker stream framing", () => {
  it("demultiplexes frames split across chunks", () => {
    const out: string[] = [];
    const err: string[] = [];
    const d = new Demuxer((b) => out.push(b.toString()), (b) => err.push(b.toString()));
    const all = Buffer.concat([frame(1, "hello "), frame(2, "oops"), frame(1, "world")]);
    for (let i = 0; i < all.length; i += 3) d.push(all.subarray(i, i + 3));
    expect(out.join("")).toBe("hello world");
    expect(err.join("")).toBe("oops");
    expect(demux(all)).toEqual({ stdout: "hello world", stderr: "oops" });
  });
});

describe("probe", () => {
  it("reports why containers are unusable", async () => {
    const fake = new FakeDocker();
    const cfg = cfgOf();
    fake.reachable = false;
    expect((await probeContainers(new Docker(fake), cfg)).reason).toMatch(/not reachable/);
    fake.reachable = true;
    fake.runtimes = { runc: {} };
    expect((await probeContainers(new Docker(fake), cfg)).reason).toMatch(/runsc.*not registered/);
    fake.runtimes = { runc: {}, runsc: {} };
    expect((await probeContainers(new Docker(fake), cfg)).reason).toMatch(/no runner images/);
    fake.images.add(cfg.images["dotnet-8"]);
    const ok = await probeContainers(new Docker(fake), cfg);
    expect(ok.usable).toBe(true);
    expect(ok.images[cfg.images["dotnet-8"]]).toBe(true);
    expect(ok.images[cfg.postgresImage]).toBe(false);
    expect((await probeContainers(new Docker(fake), { ...cfg, enabled: false })).reason).toMatch(/off/);
  });
});

/** Toolchains with tier 3 "up" and these images built. */
async function tierWith(images: string[], fake = new FakeDocker()) {
  const cfg = cfgOf();
  for (const rt of images) fake.images.add(rt.includes(":") ? rt : cfg.images[rt]);
  const tc = resolveToolchains({ lookup: false });
  tc.containers = { config: cfg, status: await probeContainers(new Docker(fake), cfg) };
  return { tc, cfg, fake };
}

describe("catalog availability", () => {
  it("lists container kinds as unavailable while containers are off", () => {
    const tc = resolveToolchains({ lookup: false });
    tc.containers = { config: cfgOf({ enabled: false }), status: offStatus({ enabled: false, runtime: "runsc" }, "containers are off on this runner (JUDGE_CONTAINERS is not 1)") };
    const view = catalogView(tc);
    expect(view.kinds.some((k) => k.tier === "container")).toBe(false);
    expect(view.unavailable.find((u) => u.id === "csharp/console")?.reason).toMatch(/containers are off/);
    expect(tierFeatures(tc, "x".repeat(40))).toEqual([]);
  });

  it("lists a container kind once its image is built, and names the missing image otherwise", async () => {
    const { tc, cfg } = await tierWith(["dotnet-8"]);
    expect(availability(tc, kindById("csharp/console")!).available).toBe(true);
    const view = catalogView(tc);
    expect(view.kinds.find((k) => k.id === "csharp/console")).toMatchObject({ tier: "container", image: cfg.images["dotnet-8"] });
    expect(view.unavailable.find((u) => u.id === "kotlin/gradle")?.reason).toBe(`image ${cfg.images["kotlin-2"]} is not built on this runner`);
    // sql/postgres needs both its client image and the sidecar.
    expect(view.unavailable.find((u) => u.id === "sql/postgres")?.reason).toMatch(/not built/);
    expect(tierFeatures(tc, "")).toEqual(["containers", "pty"]);
  });

  it("turns on databases and previews only when their images and the preview secret exist", async () => {
    const { tc, cfg } = await tierWith(["postgres-16", "node-22", "postgres:16"]);
    expect(availability(tc, kindById("sql/postgres")!).available).toBe(true);
    expect(availability(tc, kindById("sql/mysql")!).reason).toMatch(/not built/);
    expect(tierFeatures(tc, "")).toEqual(["containers", "pty", "databases"]);
    expect(tierFeatures(tc, "s".repeat(32))).toEqual(["containers", "pty", "previews", "databases"]);
    expect(cfg.postgresImage).toBe("postgres:16");
  });

  it("detects a Spring Boot project as Maven for runs, Spring Boot for tests", async () => {
    const { tc } = await tierWith(["jdk-21"]);
    // Maven on the host (isolate tier) too.
    tc.runtimes.get("jdk-21")!.tools = { java: "/opt/x/java", javac: "/opt/x/javac", mvn: "/opt/x/mvn", gradle: "/opt/x/gradle" };
    const files = [
      { path: "pom.xml", content: "<project><parent><groupId>org.springframework.boot</groupId></parent></project>" },
      { path: "src/main/java/DemoApplication.java", content: "public class DemoApplication { public static void main(String[] a) {} }" },
    ];
    expect(detectView(tc, files).best).toBe("java/spring-boot");
    expect(resolveProject(tc, { files, actions: ["run"] }).kind.id).toBe("java/maven");
  });

  it("asks for an image-backed runtime before running a database next to a non-container kind", async () => {
    const { tc } = await tierWith(["python-3.12", "postgres:16"]);
    const files = [{ path: "main.py", content: "print(1)" }];
    expect(resolveProject(tc, { kind: "python/single", files, services: ["postgres"] })).toMatchObject({ container: true, services: ["postgres"] });
    expect(() => resolveProject(tc, { kind: "python/single", files, services: ["mysql"] })).toThrow(/mysql database image/);
    expect(() => resolveProject(tc, { kind: "c/single", files: [{ path: "main.c", content: "int main(){}" }], services: ["postgres"] })).toThrow(/container tier/);
    expect(() => resolveProject(tc, { kind: "python/single", files, services: ["redis"] })).toThrow(/services must be/);
  });
});

describe("container boxes (fake Engine API)", () => {
  const setup = async (images: string[]) => {
    const t = await tierWith(images);
    const sandbox = new ContainerSandbox(new Docker(t.fake), t.cfg);
    return { ...t, sandbox };
  };

  it("runs a step: stdin in, output out, container removed", async () => {
    const { sandbox, fake, cfg } = await setup(["python-3.12"]);
    fake.program = async (c) => {
      c.stdout(`got ${await c.input()}`);
      c.stderr("warn");
      c.exit(0);
    };
    const box = await sandbox.acquire({ image: cfg.images["python-3.12"] });
    await box.write("main.py", "print(input())");
    const r = await box.exec(["/usr/bin/python3.12", "main.py"], { stdin: "Ada", limits });
    expect(r).toMatchObject({ status: "ok", exitCode: 0, stdout: "got Ada", stderr: "warn" });
    expect(fake.containers.size).toBe(0);
    const created = fake.callsTo(/POST \/containers\/create/)[0].body;
    expect(created.HostConfig.Binds[0]).toMatch(/:\/box:rw$/);
    expect(await box.read("main.py")).toEqual(Buffer.from("print(input())"));
    await box.dispose();
  });

  it("stops a program at the output cap and at the wall clock", async () => {
    const { sandbox, fake, cfg } = await setup(["python-3.12"]);
    fake.program = (c) => c.stdout("x".repeat(80 * 1024));
    const box = await sandbox.acquire({ image: cfg.images["python-3.12"] });
    const over = await box.exec(["/usr/bin/python3.12", "-c", "spam"], { stdin: "", limits });
    expect(over.status).toBe("output-limit");
    expect(over.stdout.length).toBe(64 * 1024);
    fake.program = () => {};
    const slow = await box.exec(["/usr/bin/python3.12", "-c", "loop"], { stdin: "", limits: { ...limits, wallS: 0.05 } });
    expect(slow.status).toBe("timeout");
    expect(fake.callsTo(/kill\?signal=SIGKILL/).length).toBeGreaterThanOrEqual(2);
    fake.program = (c) => c.exit(137, { oom: true });
    expect((await box.exec(["/usr/bin/python3.12", "-c", "big"], { stdin: "", limits })).status).toBe("memory");
    await box.dispose();
  });

  it("runs a catalog project in the image with the catalog's tool paths", async () => {
    const { sandbox, fake, tc } = await setup(["dotnet-8"]);
    fake.program = async (c) => {
      if (c.body.Cmd[1] === "build") c.stdout("Build succeeded.\n");
      else c.stdout(`${Number((await c.input()).trim()) * 2}\n`);
      c.exit(0);
    };
    const r = await runProject(new LocalSandbox(), { toolchains: tc, containers: sandbox }, {
      kind: "csharp/console",
      files: [{ path: "App.csproj", content: "<Project/>" }, { path: "Program.cs", content: "static void Main(){}" }],
      tests: [{ id: "a", input: "2\n", expected_output: "4\n" }, { id: "b", input: "5\n", expected_output: "11\n" }],
    });
    expect(r.sandbox).toBe("container");
    expect(r.compile?.ok).toBe(true);
    expect(r.tests.map((t) => t.verdict)).toEqual(["accepted", "wrong-answer"]);
    const cmds = fake.callsTo(/POST \/containers\/create/).map((c) => c.body.Cmd.join(" "));
    expect(cmds[0]).toMatch(/^\/usr\/bin\/dotnet build --no-restore/);
    expect(cmds.slice(1)).toEqual(["/usr/bin/dotnet run --no-build", "/usr/bin/dotnet run --no-build"]);
    expect(containerToolchains(tc).runtimes.get("dotnet-8")!.tools.dotnet).toBe("/usr/bin/dotnet");
  });

  it("refuses a container kind when the runner has no container tier", async () => {
    const { tc } = await setup(["dotnet-8"]);
    await expect(runProject(new LocalSandbox(), { toolchains: tc }, { kind: "csharp/single", files: [{ path: "Program.cs", content: "" }] })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("spawns a PTY program: raw bytes, resize, signals", async () => {
    const { fake, cfg } = await setup(["python-3.12"]);
    const docker = new Docker(fake);
    fake.program = (c) => c.stdout("\x1b[1mhi\x1b[0m\r\n");
    const proc = spawnContainer({
      docker,
      create: () => docker.create({ Image: cfg.images["python-3.12"], Tty: true, HostConfig: { NetworkMode: "none" } }),
      cleanup: (id) => docker.remove(id),
      limits,
      tty: { cols: 120, rows: 30 },
    });
    const out: Buffer[] = [];
    proc.onStdout((b) => out.push(b));
    await proc.container;
    await new Promise((r) => setTimeout(r, 5));
    proc.write("x\n");
    proc.resize!(100, 40);
    proc.kill("SIGINT");
    const r = await proc.done;
    expect(Buffer.concat(out).toString()).toBe("\x1b[1mhi\x1b[0m\r\n");
    expect(r).toMatchObject({ status: "signal", exitCode: 130, message: "Killed by SIGINT" });
    expect(fake.callsTo(/resize\?h=30&w=120/).length).toBe(1);
    expect(fake.callsTo(/resize\?h=40&w=100/).length).toBe(1);
    expect(fake.callsTo(/kill\?signal=SIGINT/).length).toBe(1);
  });
});
