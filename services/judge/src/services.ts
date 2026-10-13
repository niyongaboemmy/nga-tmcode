/**
 * Per-run databases (tier 3, docs/PROTOCOL.md §5.9). A run that asks for
 * `services: ["postgres"]` or `["mysql"]` (or whose kind does) gets:
 *   - its own internal Docker network (`Internal: true`: no route out),
 *   - a sidecar from the pinned postgres:16 / mysql:8.4 image under gVisor,
 *     data on tmpfs, read-only rootfs, capabilities dropped to what the
 *     image's entrypoint needs to switch to its own user,
 *   - schema.sql + seed.sql from the project loaded once,
 *   - a fresh `app` database before every step / I/O test (PostgreSQL: a copy
 *     of the seeded template; MySQL: schema + seed replayed),
 *   - DATABASE_URL and PG* / MYSQL_* variables for the program (user
 *     `student`, never a superuser),
 * and everything is removed when the run ends.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerConfig } from "./containers.ts";
import { LABEL } from "./containers.ts";
import type { Docker } from "./docker.ts";
import { removeTree } from "./sandbox.ts";

export type ServiceName = "postgres" | "mysql";
export const SERVICES: ServiceName[] = ["postgres", "mysql"];

export const DB_USER = "student";
export const DB_NAME = "app";
export const DB_ALIAS = "db";
const PORTS: Record<ServiceName, number> = { postgres: 5432, mysql: 3306 };
/** Where the project's schema.sql / seed.sql are mounted in the sidecar. */
const SEED_DIR: Record<ServiceName, string> = { postgres: "/docker-entrypoint-initdb.d", mysql: "/nga-seed" };

export function parseServices(v: unknown): ServiceName[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((s) => !SERVICES.includes(s as ServiceName))) {
    throw Object.assign(new Error(`services must be a list of ${SERVICES.join(", ")}.`), { status: 400, code: "INVALID_REQUEST" });
  }
  const list = [...new Set(v as ServiceName[])];
  if (list.length > 1) throw Object.assign(new Error("At most one database service per run."), { status: 400, code: "INVALID_REQUEST" });
  return list;
}

/** The network for one run: internal (no egress), labelled for clean-up. */
export function networkBody(name: string) {
  return {
    Name: name,
    Driver: "bridge",
    Internal: true,
    CheckDuplicate: true,
    Labels: { [LABEL]: "net" },
    Options: { "com.docker.network.bridge.enable_icc": "true", "com.docker.network.bridge.enable_ip_masquerade": "false" },
  };
}

export interface ServiceSecrets {
  /** The image's admin (postgres superuser / mysql root): only the judge uses it, inside the sidecar. */
  admin: string;
  /** The program's own user. */
  student: string;
}

/** POST /containers/create body for a database sidecar (pure). */
export function serviceBody(cfg: Pick<ContainerConfig, "runtime" | "postgresImage" | "mysqlImage"> & { cgroupParent?: string | null }, name: ServiceName, o: { network: string; seedDir: string; secrets: ServiceSecrets; memoryMb?: number }) {
  const memory = (o.memoryMb ?? (name === "mysql" ? 640 : 384)) * 1024 * 1024;
  const pg = name === "postgres";
  return {
    Image: pg ? cfg.postgresImage : cfg.mysqlImage,
    Env: pg
      ? [`POSTGRES_USER=judge`, `POSTGRES_PASSWORD=${o.secrets.admin}`, "POSTGRES_DB=seed", "PGDATA=/var/lib/postgresql/data/pgdata"]
      : [`MYSQL_ROOT_PASSWORD=${o.secrets.admin}`, `MYSQL_USER=${DB_USER}`, `MYSQL_PASSWORD=${o.secrets.student}`, `MYSQL_DATABASE=${DB_NAME}`],
    Cmd: pg
      ? ["postgres", "-c", "fsync=off", "-c", "full_page_writes=off", "-c", "synchronous_commit=off", "-c", "shared_buffers=16MB", "-c", "max_connections=20", "-c", "statement_timeout=10s", "-c", "listen_addresses=*"]
      : ["mysqld", "--innodb-buffer-pool-size=32M", "--innodb-log-buffer-size=4M", "--performance-schema=OFF", "--skip-log-bin", "--max-connections=20", "--max-execution-time=10000"],
    Labels: { [LABEL]: "service" },
    HostConfig: {
      Runtime: cfg.runtime,
      NetworkMode: o.network,
      ReadonlyRootfs: true,
      Tmpfs: pg
        ? { "/var/lib/postgresql/data": "rw,size=256m", "/var/run/postgresql": "rw,size=8m", "/tmp": "rw,size=32m" }
        : { "/var/lib/mysql": "rw,size=384m", "/var/run/mysqld": "rw,size=8m", "/tmp": "rw,size=64m", "/var/lib/mysql-files": "rw,size=1m" },
      Binds: [`${o.seedDir}:${SEED_DIR[name]}:ro`],
      // The entrypoints start as root, chown the data folder and switch to their own user (gosu).
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      PidsLimit: 256,
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: 1e9,
      ShmSize: 64 * 1024 * 1024,
      LogConfig: { Type: "none", Config: {} },
      ...(cfg.cgroupParent ? { CgroupParent: cfg.cgroupParent } : {}),
    },
    NetworkingConfig: { EndpointsConfig: { [o.network]: { Aliases: [DB_ALIAS] } } },
  };
}

/** What the program sees (DATABASE_URL + the client tools' own variables). */
export function serviceEnv(name: ServiceName, host: string, password: string): Record<string, string> {
  const port = PORTS[name];
  if (name === "postgres") {
    return {
      DATABASE_URL: `postgres://${DB_USER}:${password}@${host}:${port}/${DB_NAME}`,
      PGHOST: host,
      PGPORT: String(port),
      PGUSER: DB_USER,
      PGPASSWORD: password,
      PGDATABASE: DB_NAME,
    };
  }
  return {
    DATABASE_URL: `mysql://${DB_USER}:${password}@${host}:${port}/${DB_NAME}`,
    MYSQL_HOST: host,
    MYSQL_TCP_PORT: String(port),
    MYSQL_USER: DB_USER,
    MYSQL_PWD: password,
    MYSQL_PASSWORD: password,
    MYSQL_DATABASE: DB_NAME,
  };
}

/** Files placed in the sidecar's seed folder: the project's schema/seed, plus (PostgreSQL) the student role. */
export function seedFiles(name: ServiceName, files: { path: string; content: string }[], studentPassword: string) {
  const get = (p: string) => files.find((f) => f.path === p)?.content;
  const out: { path: string; content: string }[] = [];
  const schema = get("schema.sql");
  const seed = get("seed.sql");
  if (schema !== undefined) out.push({ path: "01-schema.sql", content: schema });
  if (seed !== undefined) out.push({ path: "02-seed.sql", content: seed });
  if (name === "postgres") {
    out.push({
      path: "99-student.sql",
      content: [
        `CREATE ROLE ${DB_USER} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${studentPassword}';`,
        `GRANT ALL ON SCHEMA public TO ${DB_USER};`,
        `GRANT ALL ON ALL TABLES IN SCHEMA public TO ${DB_USER};`,
        `GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};`,
        "",
      ].join("\n"),
    });
  }
  return out;
}

/** Commands (run inside the sidecar) that check readiness and give a fresh `app` database. */
export function serviceCommands(name: ServiceName) {
  if (name === "postgres") {
    // Admin commands over the server's unix socket (local connections are trusted inside the sidecar).
    const psql = (sql: string) => ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "judge", "-d", "postgres", "-c", sql];
    return {
      // The init server listens on the socket only; TCP answers once init is done.
      ready: ["pg_isready", "-q", "-h", "127.0.0.1", "-U", "judge", "-d", "seed"],
      fresh: [psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`), psql(`CREATE DATABASE ${DB_NAME} TEMPLATE seed OWNER ${DB_USER}`)],
    };
  }
  // The admin password comes from the sidecar's own environment (never on a command line we log).
  const sh = (script: string) => ["sh", "-c", script];
  const root = 'mysql --protocol=TCP -h127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD"';
  return {
    ready: sh(`mysqladmin --protocol=TCP -h127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" ping --silent`),
    fresh: [
      sh(
        `set -e; ${root} -e "DROP DATABASE IF EXISTS ${DB_NAME}; CREATE DATABASE ${DB_NAME}; GRANT ALL ON ${DB_NAME}.* TO '${DB_USER}'@'%';"; ` +
          `for f in ${SEED_DIR.mysql}/01-schema.sql ${SEED_DIR.mysql}/02-seed.sql; do if [ -f "$f" ]; then ${root} ${DB_NAME} < "$f"; fi; done`,
      ),
    ],
  };
}

export interface ServiceHandle {
  name: ServiceName;
  network: string;
  env: Record<string, string>;
  /** A fresh `app` database (before each step / I/O test). */
  fresh(): Promise<void>;
  dispose(): Promise<void>;
}

export class ServiceError extends Error {
  /** The database's own output (schema errors), for the run's compile output. */
  output: string;
  constructor(message: string, output = "") {
    super(message);
    this.output = output;
  }
}

export interface StartOptions {
  readyTimeoutMs?: number;
  pollMs?: number;
  /** An existing network to join (previews) instead of a new one. */
  network?: string;
}

/** Creates the network (unless given), starts the sidecar, waits until it answers, loads the seed. */
export async function startService(docker: Docker, cfg: ContainerConfig, name: ServiceName, files: { path: string; content: string }[], o: StartOptions = {}): Promise<ServiceHandle> {
  const runId = randomBytes(6).toString("hex");
  const ownNetwork = !o.network;
  const network = o.network ?? `tmj-db-${runId}`;
  const secrets: ServiceSecrets = { admin: randomBytes(18).toString("base64url"), student: randomBytes(18).toString("base64url") };
  await mkdir(cfg.workdir, { recursive: true, mode: 0o711 });
  const seedDir = await mkdtemp(join(cfg.workdir, "seed-"));
  // The sidecar's own user (postgres / mysql) must read these.
  await chmod(seedDir, 0o755);
  for (const f of seedFiles(name, files, secrets.student)) {
    await writeFile(join(seedDir, f.path), f.content);
    await chmod(join(seedDir, f.path), 0o644);
  }
  let id: string | null = null;
  const dispose = async () => {
    if (id) await docker.remove(id).catch(() => {});
    id = null;
    if (ownNetwork) await docker.removeNetwork(network).catch(() => {});
    await removeTree(seedDir).catch(() => {});
  };
  try {
    if (ownNetwork) await docker.createNetwork(networkBody(network));
    id = await docker.create(serviceBody(cfg, name, { network, seedDir, secrets }), `tmj-${name}-${runId}`);
    await docker.start(id);
    const cmds = serviceCommands(name);
    const deadline = Date.now() + (o.readyTimeoutMs ?? (name === "mysql" ? 90_000 : 45_000));
    for (;;) {
      const r = await docker.exec(id, cmds.ready, { timeoutMs: 10_000 }).catch(() => null);
      if (r?.exitCode === 0) break;
      const st = await docker.inspect(id).then((i) => i.State).catch(() => null);
      if (st && !st.Running) throw new ServiceError(`The ${name} database stopped while starting (schema.sql or seed.sql may have an error).`);
      if (Date.now() > deadline) throw new ServiceError(`The ${name} database did not start in time.`);
      await new Promise((r2) => setTimeout(r2, o.pollMs ?? 500));
    }
    const ip = (await docker.inspect(id)).NetworkSettings?.Networks?.[network]?.IPAddress || DB_ALIAS;
    const handle: ServiceHandle = {
      name,
      network,
      env: serviceEnv(name, ip, secrets.student),
      async fresh() {
        for (const c of cmds.fresh) {
          const r = await docker.exec(id!, c, { timeoutMs: 60_000 });
          if (r.exitCode !== 0) throw new ServiceError(`Could not prepare the ${name} database.`, `${r.stdout}${r.stderr}`.replace(/mysql: \[Warning\][^\n]*\n?/g, "").trim());
        }
      },
      dispose,
    };
    return handle;
  } catch (e) {
    await dispose();
    throw e;
  }
}
