// pm2 process for tm-judge (see install.sh). The token lives in /opt/apps/tm-judge/.judge.env.
const fs = require("node:fs");
const path = require("node:path");

const appDir = path.resolve(__dirname, "../../..");
const envFile = path.join(appDir, ".judge.env");
const fromFile = fs.existsSync(envFile)
  ? Object.fromEntries(
      fs
        .readFileSync(envFile, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
    )
  : {};

module.exports = {
  apps: [
    {
      name: "tm-judge",
      cwd: path.join(appDir, "services/judge"),
      // Plain JavaScript built by install.sh (scripts/build.mjs).
      script: "dist/server.mjs",
      max_memory_restart: "150M",
      env: {
        NODE_ENV: "production",
        JUDGE_HOST: "127.0.0.1",
        JUDGE_PORT: "5010",
        // Two sandboxes at a time on this 2-vCPU shared box.
        JUDGE_CONCURRENCY: "2",
        JUDGE_SANDBOX: "isolate",
        ...fromFile,
      },
    },
  ],
};
