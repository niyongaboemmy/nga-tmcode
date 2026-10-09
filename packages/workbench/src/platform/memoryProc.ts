import type { FileSystem, ProcHost } from "./types";

/**
 * Dev server / e2e only: a pretend `pytest` for the Testing view's framework
 * runs. It finds `def test_…` functions in test_*.py files and fails the ones
 * whose body has `assert False` or compares two different numbers
 * (`assert 4 == 5`), then writes the JUnit report pytest would. Any other
 * command answers "not found" like a shell would.
 */
export function createSimulatedProc(fs: FileSystem): ProcHost {
  let next = 0;
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await fs.readDir(dir).catch(() => []);
    const out: string[] = [];
    for (const e of entries) {
      const p = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === "dir" && !e.name.startsWith(".")) out.push(...(await walk(p)));
      else if (e.kind === "file" && /^test_.*\.py$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  return {
    async run(command, cwd, onEvent) {
      const id = ++next;
      setTimeout(async () => {
        if (!/pytest/.test(command)) {
          onEvent({ type: "stderr", data: `zsh: command not found: ${command.split(" ")[0]}\n` });
          onEvent({ type: "exit", code: 127 });
          return;
        }
        const join = (p: string) => (cwd ? `${cwd}/${p}` : p);
        const report = /--junitxml=(\S+)/.exec(command)?.[1];
        const only = /-k (\S+)/.exec(command)?.[1]?.replace(/^"|"$/g, "");
        const fileArg = command.split(" ").find((a) => /\.py$/.test(a));
        const files = fileArg ? [join(fileArg)] : await walk(cwd);
        const cases: string[] = [];
        let failed = 0;
        let total = 0;
        for (const file of files) {
          const lines = (await fs.readFile(file).catch(() => "")).split("\n");
          const mod = file.replace(/^.*\//, "").replace(/\.py$/, "");
          lines.forEach((l, i) => {
            const m = /^def (test\w*)\s*\(/.exec(l);
            if (!m || (only && m[1] !== only)) return;
            total++;
            let bad: { line: number; text: string } | null = null;
            for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || !lines[j]); j++) {
              const a = /assert (\d+) == (\d+)/.exec(lines[j]);
              if (/assert False/.test(lines[j]) || (a && a[1] !== a[2])) bad = { line: j + 1, text: lines[j].trim() };
              if (bad) break;
            }
            const rel = cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
            if (bad) {
              failed++;
              const msg = `AssertionError: ${bad.text}`;
              cases.push(`<testcase classname="${mod}" name="${m[1]}" time="0.001"><failure message="${esc(msg)}">${esc(`${rel}:${bad.line}: in ${m[1]}\n    ${bad.text}\nE   ${msg}`)}</failure></testcase>`);
              onEvent({ type: "stdout", data: "F" });
            } else {
              cases.push(`<testcase classname="${mod}" name="${m[1]}" time="0.001" />`);
              onEvent({ type: "stdout", data: "." });
            }
          });
        }
        if (report) {
          const path = join(report).split("/").reduce<string[]>((acc, part) => (part === ".." ? acc.slice(0, -1) : part === "." ? acc : [...acc, part]), []).join("/");
          const parts = path.split("/");
          for (let i = 1; i < parts.length; i++) await fs.createDir(parts.slice(0, i).join("/")).catch(() => {});
          await fs.writeFile(path, `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" tests="${total}" failures="${failed}">${cases.join("")}</testsuite></testsuites>`);
        }
        onEvent({ type: "stdout", data: `\n${total - failed} passed${failed ? `, ${failed} failed` : ""}\n` });
        onEvent({ type: "exit", code: total === 0 ? 5 : failed ? 1 : 0 });
      }, 50);
      return id;
    },
    async kill() {},
  };
}
