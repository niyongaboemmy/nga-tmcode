import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { containerConfig, ContainerSandbox, probeContainers, type ContainerConfig } from "./containers.ts";
import { Docker } from "./docker.ts";
import { runProject } from "./project.ts";
import { LocalSandbox } from "./sandbox.ts";
import { networkBody, parseServices, seedFiles, serviceBody, serviceCommands, serviceEnv, startService } from "./services.ts";
import { resolveToolchains } from "./toolchains.ts";
import { FakeDocker } from "./testkit/fakeDocker.ts";

/** Per-run databases: sidecar wiring against a fake Engine API. */

const workdir = mkdtempSync(join(tmpdir(), "tmj-stest-"));
const cfg: ContainerConfig = containerConfig({ JUDGE_CONTAINERS: "1", JUDGE_CONTAINER_UID: "1500", JUDGE_CONTAINER_GID: "1500", JUDGE_CONTAINER_WORKDIR: workdir });
const secrets = { admin: "ADMINPW", student: "STUDENTPW" };
const project = [
  { path: "schema.sql", content: "CREATE TABLE t (x int);" },
  { path: "seed.sql", content: "INSERT INTO t VALUES (1);" },
  { path: "main.sql", content: "-- dialect: postgres\nSELECT x FROM t;" },
];

describe("sidecar bodies", () => {
  it("runs PostgreSQL on tmpfs, on the run network only, with dropped capabilities", () => {
    const b = serviceBody(cfg, "postgres", { network: "tmj-db-1", seedDir: "/w/seed-1", secrets });
    expect(b.Image).toBe("postgres:16");
    expect(b.HostConfig.Runtime).toBe("runsc");
    expect(b.HostConfig.NetworkMode).toBe("tmj-db-1");
    expect(b.HostConfig.ReadonlyRootfs).toBe(true);
    expect(Object.keys(b.HostConfig.Tmpfs)).toContain("/var/lib/postgresql/data");
    expect(b.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(b.HostConfig.CapAdd).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]);
    expect(b.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(b.HostConfig.Memory).toBe(b.HostConfig.MemorySwap);
    expect(b.HostConfig.Binds).toEqual(["/w/seed-1:/docker-entrypoint-initdb.d:ro"]);
    expect(b.Env).toContain("POSTGRES_PASSWORD=ADMINPW");
    expect(b.Cmd).toContain("statement_timeout=10s");
    expect(b.NetworkingConfig.EndpointsConfig["tmj-db-1"].Aliases).toEqual(["db"]);
  });

  it("runs MySQL with a non-root user for the program", () => {
    const b = serviceBody(cfg, "mysql", { network: "n", seedDir: "/w/s", secrets });
    expect(b.Image).toBe("mysql:8.4");
    expect(b.Env).toEqual(expect.arrayContaining(["MYSQL_USER=student", "MYSQL_PASSWORD=STUDENTPW", "MYSQL_DATABASE=app"]));
    expect(b.HostConfig.Binds).toEqual(["/w/s:/nga-seed:ro"]);
    expect(Object.keys(b.HostConfig.Tmpfs)).toContain("/var/lib/mysql");
  });

  it("uses an internal network (no egress)", () => {
    expect(networkBody("tmj-db-1")).toMatchObject({ Name: "tmj-db-1", Internal: true, Driver: "bridge" });
  });

  it("gives the program DATABASE_URL and the clients' own variables", () => {
    expect(serviceEnv("postgres", "172.30.0.2", "pw")).toEqual({
      DATABASE_URL: "postgres://student:pw@172.30.0.2:5432/app",
      PGHOST: "172.30.0.2",
      PGPORT: "5432",
      PGUSER: "student",
      PGPASSWORD: "pw",
      PGDATABASE: "app",
    });
    expect(serviceEnv("mysql", "db", "pw")).toMatchObject({ DATABASE_URL: "mysql://student:pw@db:3306/app", MYSQL_HOST: "db", MYSQL_PWD: "pw" });
  });

  it("seeds from schema.sql and seed.sql, and makes PostgreSQL's program role NOSUPERUSER", () => {
    const pg = seedFiles("postgres", project, "pw");
    expect(pg.map((f) => f.path)).toEqual(["01-schema.sql", "02-seed.sql", "99-student.sql"]);
    expect(pg[2].content).toMatch(/CREATE ROLE student LOGIN NOSUPERUSER/);
    expect(seedFiles("mysql", [], "pw")).toEqual([]);
  });

  it("gives every test a fresh database", () => {
    expect(serviceCommands("postgres").fresh.map((c) => c.at(-1))).toEqual(["DROP DATABASE IF EXISTS app WITH (FORCE)", "CREATE DATABASE app TEMPLATE seed OWNER student"]);
    expect(serviceCommands("mysql").fresh[0][2]).toMatch(/DROP DATABASE IF EXISTS app; CREATE DATABASE app;.*01-schema\.sql.*02-seed\.sql/);
    // The admin password never appears on a command line.
    expect(JSON.stringify(serviceCommands("mysql"))).not.toMatch(/ADMINPW/);
  });

  it("accepts one known service", () => {
    expect(parseServices(undefined)).toEqual([]);
    expect(parseServices(["postgres", "postgres"])).toEqual(["postgres"]);
    expect(() => parseServices(["postgres", "mysql"])).toThrow(/one database/);
    expect(() => parseServices("postgres")).toThrow(/list/);
  });
});

describe("sidecar lifecycle", () => {
  it("starts, waits until ready, freshens and cleans up", async () => {
    const fake = new FakeDocker();
    fake.images.add("postgres:16");
    fake.program = () => {}; // a server keeps running
    let readyChecks = 0;
    fake.execResult = (cmd) => (cmd[0] === "pg_isready" ? { exitCode: ++readyChecks < 3 ? 2 : 0 } : { exitCode: 0 });
    const docker = new Docker(fake);
    const h = await startService(docker, cfg, "postgres", project, { pollMs: 1 });
    expect(readyChecks).toBe(3);
    expect(h.network).toMatch(/^tmj-db-/);
    expect(fake.networks.has(h.network)).toBe(true);
    expect(h.env.PGHOST).toMatch(/^172\.30\.0\./);
    await h.fresh();
    expect(fake.callsTo(/POST \/containers\/c\d+\/exec/).map((c) => c.body.Cmd.at(-1))).toContain("CREATE DATABASE app TEMPLATE seed OWNER student");
    const seedDir = fake.callsTo(/POST \/containers\/create/)[0].body.HostConfig.Binds[0].split(":")[0];
    expect(existsSync(join(seedDir, "01-schema.sql"))).toBe(true);
    await h.dispose();
    expect(fake.containers.size).toBe(0);
    expect(fake.networks.size).toBe(0);
    expect(existsSync(seedDir)).toBe(false);
  });

  it("reports a sidecar that dies while loading the seed", async () => {
    const fake = new FakeDocker();
    fake.images.add("mysql:8.4");
    fake.program = (c) => c.exit(1);
    fake.execResult = () => ({ exitCode: 1 });
    await expect(startService(new Docker(fake), cfg, "mysql", project, { pollMs: 1 })).rejects.toThrow(/stopped while starting/);
    expect(fake.networks.size).toBe(0);
  });

  it("runs sql/postgres with the database wired in, fresh per I/O test", async () => {
    const fake = new FakeDocker();
    fake.images.add("postgres:16");
    fake.images.add(cfg.images["postgres-16"]);
    const tc = resolveToolchains({ lookup: false });
    tc.containers = { config: cfg, status: await probeContainers(new Docker(fake), cfg) };
    fake.program = (c) => {
      if (c.body.Image === "postgres:16") return; // the sidecar keeps running
      c.stdout(c.body.Env.find((e: string) => e.startsWith("DATABASE_URL="))!.replace(/:[^:@]+@/, ":***@") + "\n");
      c.exit(0);
    };
    const r = await runProject(new LocalSandbox(), { toolchains: tc, containers: new ContainerSandbox(new Docker(fake), cfg) }, {
      kind: "sql/postgres",
      files: project,
      tests: [{ id: "a", input: "" }, { id: "b", input: "" }],
    });
    expect(r.services).toEqual(["postgres"]);
    expect(r.tests.map((t) => t.stdout.trim())).toEqual(["DATABASE_URL=postgres://student:***@172.30.0.1:5432/app", "DATABASE_URL=postgres://student:***@172.30.0.1:5432/app"]);
    const runs = fake.callsTo(/POST \/containers\/create/).filter((c) => c.body.Image === cfg.images["postgres-16"]);
    expect(runs.map((c) => c.body.Cmd)).toEqual([
      ["/usr/bin/psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-P", "border=2", "-P", "footer=off", "-f", "main.sql"],
      ["/usr/bin/psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-P", "border=2", "-P", "footer=off", "-f", "main.sql"],
    ]);
    // The program joined the run's network, not "none".
    expect(runs[0].body.HostConfig.NetworkMode).toMatch(/^tmj-db-/);
    // fresh() once at the start and again before the second test.
    expect(fake.callsTo(/POST \/containers\/c\d+\/exec/).filter((c) => /CREATE DATABASE/.test(c.body.Cmd.at(-1))).length).toBe(2);
    expect(fake.containers.size).toBe(0);
    expect(fake.networks.size).toBe(0);
  });
});
