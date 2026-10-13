import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { get } from "node:http";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containerConfig, ContainerSandbox, probeContainers } from "./containers.ts";
import { Docker, unixTransport } from "./docker.ts";
import { runProject } from "./project.ts";
import { containerLauncher, PreviewManager } from "./previews.ts";
import { LocalSandbox } from "./sandbox.ts";
import { resolveToolchains } from "./toolchains.ts";

/**
 * Tier 3 against a real Docker daemon. Skipped unless `docker` is installed,
 * the daemon answers and gVisor's runsc is registered (or JUDGE_TEST_ALLOW_RUNC=1
 * on a development machine). Image-specific tests also skip until
 * services/judge/images/build-images.sh has built that image.
 */
const cfg = containerConfig({
  ...process.env,
  JUDGE_CONTAINERS: "1",
  ...(process.env.JUDGE_TEST_ALLOW_RUNC === "1" ? { JUDGE_CONTAINER_RUNTIME: process.env.JUDGE_CONTAINER_RUNTIME ?? "runc", JUDGE_ALLOW_RUNC: "1" } : {}),
});
const hasDockerCli = spawnSync("sh", ["-c", "command -v docker"]).status === 0;
const hasSocket = existsSync(cfg.socket);
const docker = new Docker(unixTransport(cfg.socket));
const status = hasDockerCli && hasSocket ? await probeContainers(docker, cfg) : null;
const up = !!status?.runtime_registered;
const has = (rt: string) => up && !!status?.images[cfg.images[rt] ?? rt];

const STARTERS = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/runtimes/starters");
function starter(language: string, id: string) {
  const dir = join(STARTERS, language, id);
  const files: { path: string; content: string }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const full = join(d, n);
      if (statSync(full).isDirectory()) walk(full);
      else if (n !== "starter.json" && n !== "README.md" && n !== ".gitignore") files.push({ path: relative(dir, full), content: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return files;
}

const tc = resolveToolchains({ lookup: false });
if (status) tc.containers = { config: cfg, status };
const sandbox = new ContainerSandbox(docker, cfg);
const limits = { cpuS: 5, wallS: 10, memoryMb: 256, processes: 64, outputKb: 256 };

describe.skipIf(!up)("tier 3 on a real Docker (runtime: " + cfg.runtime + ")", () => {
  it.skipIf(!has("python-3.12"))("runs a program with stdin, no network, a read-only root and a writable /box", async () => {
    const box = await sandbox.acquire({ image: cfg.images["python-3.12"] });
    try {
      await box.write(
        "main.py",
        [
          "import os, socket",
          "print(input().upper())",
          "try:\n  socket.create_connection(('1.1.1.1', 80), timeout=2); print('NET')\nexcept OSError: print('no-net')",
          "try:\n  open('/etc/x', 'w'); print('RW-ROOT')\nexcept OSError: print('ro-root')",
          "open('/box/out.txt', 'w').write('ok'); print(os.getuid() != 0)",
        ].join("\n"),
      );
      const r = await box.exec(["/usr/bin/python3", "main.py"], { stdin: "ada\n", limits });
      expect(r.status).toBe("ok");
      expect(r.stdout.split("\n").slice(0, 4)).toEqual(["ADA", "no-net", "ro-root", "True"]);
      expect((await box.read("out.txt"))?.toString()).toBe("ok");
      const slow = await box.exec(["/usr/bin/python3", "-c", "while True: pass"], { stdin: "", limits: { ...limits, wallS: 1 } });
      expect(slow.status).toBe("timeout");
    } finally {
      await box.dispose();
    }
  });

  it.skipIf(!has("python-3.12"))("gives a PTY session raw terminal output", async () => {
    const box = await sandbox.acquire({ image: cfg.images["python-3.12"] });
    try {
      const p = box.spawn(["/usr/bin/python3", "-c", "import sys; print(sys.stdout.isatty()); input()"], { limits, tty: { cols: 80, rows: 24 } });
      const out: Buffer[] = [];
      p.onStdout((b) => out.push(b));
      await new Promise((r) => setTimeout(r, 1500));
      p.write("x\n");
      const r = await p.done;
      expect(r.status).toBe("ok");
      expect(Buffer.concat(out).toString()).toMatch(/True/);
    } finally {
      await box.dispose();
    }
  });

  it.skipIf(!has("postgres-16") || !has("postgres:16"))("runs the sql/postgres starter against a per-run database", async () => {
    const files = starter("sql", "sql-postgres-select");
    const io = JSON.parse(files.find((f) => f.path === ".nga/tests.json")!.content);
    const r = await runProject(new LocalSandbox(), { toolchains: tc, containers: sandbox }, { kind: "sql/postgres", files, tests: io.tests });
    expect(r.tests.map((t) => t.verdict)).toEqual(["accepted"]);
  }, 180_000);

  it.skipIf(!has("mysql-8.4") || !has("mysql:8.4"))("runs the sql/mysql starter against a per-run database", async () => {
    const files = starter("sql", "sql-mysql-select");
    const io = JSON.parse(files.find((f) => f.path === ".nga/tests.json")!.content);
    const r = await runProject(new LocalSandbox(), { toolchains: tc, containers: sandbox }, { kind: "sql/mysql", files, tests: io.tests });
    expect(r.tests.map((t) => t.verdict)).toEqual(["accepted"]);
  }, 240_000);

  it.skipIf(!has("node-22"))("previews the Express starter through the proxy target", async () => {
    const m = new PreviewManager(containerLauncher({ toolchains: tc, containers: sandbox }));
    const { id } = m.create({ kind: "js/express", files: starter("javascript", "js-express-api") });
    try {
      let target = null;
      for (let i = 0; i < 240 && !target; i++) {
        try {
          target = m.target(id);
        } catch (e) {
          if ((e as { code?: string }).code !== "PREVIEW_NOT_READY") throw e;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      expect(target).not.toBeNull();
      const status = await new Promise<number>((resolve) => get({ host: target!.host, port: target!.port, path: "/" }, (res) => resolve(res.statusCode ?? 0)).on("error", () => resolve(0)));
      expect(status).toBeGreaterThan(0);
    } finally {
      await m.remove(id);
    }
  }, 180_000);
});

it("tier-3 integration tests run only where Docker is available", () => {
  expect(up || !status?.runtime_registered).toBe(true);
  if (!up) console.log(`[tier 3] skipped: ${!hasDockerCli ? "docker is not installed" : !hasSocket ? `no socket at ${cfg.socket}` : (status?.reason ?? "runtime not registered")}`);
});
