import { PREVIEW_MESSAGE_KEY, composeReactPage, getPlatformForSelfTest, injectIntoHead, loadTests, parseLaunchLink, runTests, shimTag, startExam, submitExam, useExam, useWorkbench, type Platform } from "@tmcode/workbench";

/**
 * Debug-build self-test (TMCODE_DEV_SELFTEST=1): exercises the runner,
 * visible tests and both preview kinds inside the real webview and writes
 * every result to the app log. Expects the demo project as the workspace.
 */
export async function runSelfTest(platform: Platform, log: (msg: string) => void) {
  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      log(`selftest ${name}: ${await fn()}`);
    } catch (e) {
      log(`selftest ${name}: FAILED ${String((e as Error)?.message ?? e)}`);
    }
  };

  await step("toolchains", async () => (await platform.runner!.detect(true)).map((t) => `${t.tool}=${t.version}`).join("; "));

  // Extensions (Rust: Open VSX only, unpacked under app data): search, install, read, refuse escapes, uninstall.
  await step("extensions", async () => {
    const ext = platform.extensions!;
    const hits = JSON.parse(await ext.fetch("https://open-vsx.org/api/-/search?query=dracula&size=3", "text")) as { totalSize: number };
    const details = JSON.parse(await ext.fetch("https://open-vsx.org/api/dracula-theme/theme-dracula", "text")) as { files: { download: string; icon: string } };
    const icon = await ext.fetch(details.files.icon, "base64");
    const stored = await ext.install("dracula-theme.theme-dracula", details.files.download);
    const theme = JSON.parse(await ext.readFile(stored.id, "theme/dracula.json", "text").catch(() => "{}")) as { colors?: object };
    const escape = await ext.readFile(stored.id, "../../device-id", "text").then(() => "READ OUTSIDE!", () => "refused");
    const offsite = await ext.fetch("https://example.com/", "text").then(() => "FETCHED OFFSITE!", () => "refused");
    const listed = (await ext.list()).map((e) => `${e.id}@${e.version}`).join(",");
    await ext.uninstall(stored.id);
    const after = (await ext.list()).length;
    return `search ${hits.totalSize} hits; icon ${icon.length}b64; installed ${stored.id}@${stored.version}; theme colors ${Object.keys(theme.colors ?? {}).length}; escape ${escape}; offsite ${offsite}; listed [${listed}]; after uninstall ${after}`;
  });

  await step("python run", async () => {
    let out = "";
    await new Promise<void>((resolve, reject) => {
      platform
        .runner!.start({ entry: "main.py", build: [], run: { tool: "python", args: ["-u", "{entry}"] }, mode: "pipe", stdin: "2\n80\n90\n" }, (e) => {
          if (e.type === "stdout") out += e.data;
          if (e.type === "exit") e.code === 0 ? resolve() : reject(new Error(`exit ${e.code}`));
          if (e.type === "error") reject(new Error(e.message));
        })
        .catch(reject);
    });
    return JSON.stringify(out.trim());
  });

  await step("visible tests", async () => {
    await loadTests();
    await runTests();
    const items = useWorkbench.getState().tests.items;
    return `${items.filter((t) => t.status === "passed").length}/${items.length} passed`;
  });

  const loadInFrame = (url: string, expectConsole?: string) =>
    new Promise<string>((resolve, reject) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
      frame.style.cssText = "position:fixed;left:-2000px;width:800px;height:600px";
      const seen: string[] = [];
      const timer = setTimeout(() => done(new Error(`timeout; console=${JSON.stringify(seen)}`)), 15000);
      const onMsg = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow || !e.data?.[PREVIEW_MESSAGE_KEY]) return;
        if (e.data.kind === "console") seen.push(`${e.data.level}:${e.data.text}`);
        if (e.data.kind === "loaded" && !expectConsole) done(null, `loaded title=${JSON.stringify(e.data.title)}`);
        if (expectConsole && seen.some((s) => s.includes(expectConsole))) done(null, `console ok (${seen.join(" | ")})`);
      };
      const done = (err: Error | null, msg?: string) => {
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        frame.remove();
        err ? reject(err) : resolve(msg!);
      };
      window.addEventListener("message", onMsg);
      frame.src = url;
      document.body.appendChild(frame);
    });

  await step("static preview", async () => {
    const html = await platform.fs.readFile("web/index.html");
    const url = await platform.preview!.publish("web", "index.html", { "index.html": injectIntoHead(html, shimTag()) }, { internet: false });
    return `${url} → ${await loadInFrame(url)}`;
  });

  await step("react preview", async () => {
    const html = await platform.fs.readFile("react-app/index.html");
    const page = await composeReactPage(html, "index.html", (p) => platform.fs.readFile(`react-app/${p}`).catch(() => null));
    const url = await platform.preview!.publish("react-app", "index.html", { "index.html": injectIntoHead(page, shimTag()) }, { internet: false });
    return `${url} → ${await loadInFrame(url, "render 0")}`;
  });

  log("selftest done");
}

/**
 * Exam self-test (TMCODE_DEV_LAUNCH=<tmcode:// link to the mock Task Mentor>):
 * launch → package → solve task 1 on disk → snapshot/sync through Rust HTTP
 * and the on-disk journal → submit → results, all inside the real webview.
 */
export async function runExamSelfTest(link: string, log: (msg: string) => void) {
  const parsed = parseLaunchLink(link);
  if (!parsed) return log("exam selftest: bad link");
  await startExam(parsed.api, parsed.ticket);
  const st = useExam.getState();
  if (st.phase !== "active") return log(`exam selftest: FAILED to start: ${st.error}`);
  log(`exam selftest started: ${st.quiz?.title}; tasks=${st.tasks.map((t) => t.folder).join(",")}; root=${useWorkbench.getState().workspace?.root}`);
  const t1 = st.tasks[0];
  await getPlatformForSelfTest().fs.writeFile(t1.entry, "const [a, b] = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(a + b);\n");
  await submitExam({ auto: true });
  for (let i = 0; i < 30 && useExam.getState().results?.status !== "released"; i++) await new Promise((r) => setTimeout(r, 1000));
  const r = useExam.getState().results;
  log(`exam selftest result: phase=${useExam.getState().phase} score=${r?.score}/${r?.max_score} questions=${JSON.stringify(r?.questions?.map((q) => [q.question_id, q.points]))}`);
}

/**
 * Git self-test (TMCODE_DEV_SELFTEST=git, TMCODE_DEV_WORKSPACE=<a scratch git repository>):
 * every local git command through Rust in the real webview. Never touches a remote.
 */
export async function runGitSelfTest(platform: Platform, log: (msg: string) => void) {
  const git = platform.git;
  if (!git) return log("git selftest: FAILED no git host");
  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      log(`git selftest ${name}: ${await fn()}`);
    } catch (e) {
      log(`git selftest ${name}: FAILED ${String((e as Error)?.message ?? e)}`);
    }
  };
  await step("info", async () => JSON.stringify(await git.info(true)));
  await step("status", async () => {
    const s = await git.status();
    return s ? `branch=${s.branch} upstream=${s.upstream} ahead=${s.ahead} behind=${s.behind} entries=${s.entries.map((e) => `${e.x}${e.y}:${e.path}`).join(",")}` : "no repository";
  });
  await step("write+stage", async () => {
    await platform.fs.writeFile("selftest.txt", `selftest ${new Date().toISOString()}\n`);
    await git.stage(["selftest.txt"]);
    const s = await git.status();
    return s?.entries.find((e) => e.path === "selftest.txt")?.x ?? "missing";
  });
  await step("show index", async () => JSON.stringify((await git.show("selftest.txt", "index"))?.slice(0, 9)));
  await step("commit", async () => {
    await git.commit({ message: "TMCode git self-test" });
    return (await git.log(1))[0]?.subject ?? "no commit";
  });
  await step("branches", async () => (await git.branches()).map((b) => `${b.current ? "*" : ""}${b.name}`).join(","));
  await step("check-ignore", async () => JSON.stringify(await git.checkIgnore(["node_modules/", "selftest.txt"])));
  await step("github user", async () => JSON.stringify((await git.github?.user())?.login ?? null));
  log("git selftest done");
}
