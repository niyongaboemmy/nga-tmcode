import type { FileSystem, TerminalProfile, TerminalSession, TerminalSpawnOptions } from "./types";

/** The simulated shells (so the profile menu, labels and split can be tried in a browser). */
const SIM_PROFILES: TerminalProfile[] = [
  { id: "zsh", name: "zsh", path: "/bin/zsh", is_default: true },
  { id: "bash", name: "bash", path: "/bin/bash", is_default: false },
];

/**
 * Dev server / e2e only (`?terminal=sim`): a pretend shell over the in-memory
 * file system, so the Run hub's dev-server flow (start a task, wait for its
 * URL, open the browser, Stop with Ctrl+C, exit codes) can be exercised in a
 * browser. It knows a handful of commands; dev servers print a Vite-style
 * banner and keep running until interrupted.
 *
 * package.json scripts may steer it: "--port N" picks the port, "--fail" makes
 * the server crash on start (exit code 1), "--slow" waits 1.5 s before ready.
 */
export function createSimulatedTerminal(fs: FileSystem) {
  return {
    profiles: async () => SIM_PROFILES,
    async spawn(opts: TerminalSpawnOptions): Promise<TerminalSession> {
      const shell = SIM_PROFILES.find((p) => p.id === opts.profile)?.id ?? "zsh";
      const cwd = opts.cwd ?? "";
      let line = "";
      let busy: { interrupt: () => void } | null = null;
      let lineRunning = false;
      let lastCode = 0;
      let closed = false;
      const out = (s: string) => !closed && opts.onData(s.replace(/\n/g, "\r\n"));
      const prompt = () => out(`\x1b[32m${cwd || "practice-project"}\x1b[0m $ `);
      const exit = (code: number) => {
        if (closed) return;
        closed = true;
        opts.onExit(code);
      };

      const readScripts = async () => {
        try {
          const pkg = JSON.parse(await fs.readFile(cwd ? `${cwd}/package.json` : "package.json")) as { scripts?: Record<string, string> };
          return pkg.scripts ?? {};
        } catch {
          return {};
        }
      };

      /** A long-running dev server: prints its URL and waits for Ctrl+C. */
      const server = (script: string) =>
        new Promise<number>((resolve) => {
          const port = Number(/--port[ =](\d+)/.exec(script)?.[1] ?? 5173);
          const timer = setTimeout(
            () => {
              if (/--fail/.test(script)) {
                out(`\x1b[31merror when starting dev server:\nError: Port ${port} is already in use\x1b[0m\n`);
                busy = null;
                resolve(1);
                return;
              }
              out(`\n  \x1b[32m\x1b[1mVITE\x1b[0m v6.0.0  ready in 312 ms\n\n  ➜  Local:   http://localhost:${port}/\n  ➜  Network: use --host to expose\n`);
            },
            /--slow/.test(script) ? 1500 : 400,
          );
          busy = {
            interrupt: () => {
              clearTimeout(timer);
              out("^C\n");
              busy = null;
              resolve(130);
            },
          };
        });

      /** Runs one simple command; resolves with its exit code. */
      const runOne = async (cmd: string): Promise<number> => {
        const words = cmd.trim().split(/\s+/);
        const pm = words[0];
        if (!pm) return 0;
        if (["npm", "pnpm", "yarn", "bun"].includes(pm)) {
          if (words[1] === "install" || words[1] === "i") {
            await wait(250);
            out("\nadded 42 packages, and audited 43 packages in 1s\n\nfound 0 vulnerabilities\n");
            return 0;
          }
          const name = words[1] === "run" ? words[2] : words[1];
          const script = name ? (await readScripts())[name] : undefined;
          if (!script) {
            out(`${pm} error Missing script: "${name ?? ""}"\n`);
            return 1;
          }
          out(`\n> ${name}\n> ${script}\n\n`);
          if (/(^|\s)(vite|next|ng|react-scripts|nodemon|node|webpack|astro)\b/.test(script) && !/\bbuild\b/.test(script)) return server(script);
          await wait(300);
          out(/build/.test(script) ? "✓ 12 modules transformed.\n✓ built in 412ms\n" : "done\n");
          return /--fail/.test(script) ? 1 : 0;
        }
        if (/^python3?$/.test(pm) && words[1] === "manage.py" && words[2] === "runserver") return server("django --port 8000");
        if (pm === "echo") {
          out(`${words.slice(1).join(" ")}\n`);
          return 0;
        }
        if (pm === "true") return 0;
        if (pm === "false") return 1;
        out(`${shell}: command not found: ${pm} (simulated terminal)\n`);
        return 127;
      };

      /** "a && b; c" with the usual meaning. */
      const runLine = async (text: string) => {
        for (const part of text.split(";")) {
          for (const c of part.split("&&")) {
            const t = c.trim();
            if (t === "exit" || t.startsWith("exit ")) {
              exit(t === "exit" ? lastCode : Number(t.slice(5)) || 0);
              return;
            }
            lastCode = await runOne(t);
            if (lastCode !== 0) break;
          }
        }
        prompt();
      };

      setTimeout(() => {
        out("Simulated terminal (browser build)\n");
        prompt();
      }, 30);

      return {
        write(data) {
          if (closed) return;
          for (const ch of data) {
            if (ch === "\x03") {
              if (busy) busy.interrupt();
              else if (!lineRunning) {
                out("^C\n");
                line = "";
                prompt();
              }
            } else if (lineRunning) {
              continue;
            } else if (ch === "\r") {
              const cmd = line;
              line = "";
              out("\n");
              lineRunning = true;
              void runLine(cmd).finally(() => {
                lineRunning = false;
              });
            } else if (ch === "\x7f") {
              if (line) {
                line = line.slice(0, -1);
                out("\b \b");
              }
            } else if (ch >= " ") {
              line += ch;
              out(ch);
            }
          }
        },
        resize() {},
        busy: async () => !!busy || lineRunning,
        kill() {
          busy?.interrupt();
          exit(lastCode || 130);
        },
      };
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
