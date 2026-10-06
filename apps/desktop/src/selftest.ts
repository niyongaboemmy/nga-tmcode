import { exthostForSelfTest, projectsForSelfTest as P, DapSession, runUiProbe, PREVIEW_MESSAGE_KEY, composeReactPage, getPlatformForSelfTest, injectIntoHead, loadTests, parseLaunchLink, runTests, shimTag, startExam, submitExam, useExam, useWorkbench, type Platform } from "@tmcode/workbench";

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

  // Run and Debug through the Rust DAP bridge: debugpy stops on a breakpoint in main.py.
  await step("debug python", async () => {
    const dbg = platform.debug;
    if (!dbg) return "no debug host";
    const probe = await dbg.probe("python");
    if (!probe.available) return `skipped: ${probe.message}`;
    const source = await platform.fs.readFile("main.py");
    const line = source.split("\n").findIndex((l) => l.startsWith("def ")) + 1;
    const prepared = await dbg.prepare({ entry: "main.py", build: [], run: { tool: "python", args: ["-u", "{entry}"] } }, () => {});
    let dap: DapSession | null = null;
    const conn = await dbg.start("python", {}, (e) => e.type === "message" && dap?.handleMessage(e.message));
    dap = new DapSession({ send: (m) => conn.send(m) }, "python");
    try {
      await dap.initialize("debugpy", { runInTerminal: false });
      const initialized = dap.once("initialized", 30_000);
      const launched = dap.launch({ type: "python", request: "launch", name: "selftest", program: prepared.entry, python: [prepared.program], cwd: prepared.cwd, console: "internalConsole", justMyCode: true });
      await initialized;
      const bps = await dap.setBreakpoints({ path: prepared.entry }, [{ line }]);
      const stopped = dap.once("stopped", 30_000);
      await dap.configurationDone();
      await launched;
      const b = await stopped;
      const [frame] = await dap.stackTrace(b.threadId ?? 1);
      return `${probe.detail}; breakpoint verified=${bps[0]?.verified}; stopped (${b.reason}) at ${frame?.source?.name}:${frame?.line}`;
    } finally {
      await dap.disconnect(true).catch(() => {});
      conn.stop();
    }
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

/**
 * Debug-build UI self-test (TMCODE_DEV_SELFTEST=ui): opens a file and the
 * terminal in the real webview and logs what the user would see (cursor,
 * current line, token colours, glyph alignment, CSP refusals, typing stalls).
 */
export async function runUiSelfTest(log: (msg: string) => void) {
  try {
    const checks = await runUiProbe({ file: "web/index.html", bigFile: "web/big.js", terminal: true });
    for (const c of checks) log(`selftest ui ${c.name}: ${c.ok ? "ok" : "FAILED"} ${c.detail}`);
    log(`selftest ui: ${checks.filter((c) => !c.ok).length} failed of ${checks.length}`);
  } catch (e) {
    log(`selftest ui: FAILED ${String((e as Error)?.message ?? e)}`);
  }
}

/**
 * Task Mentor projects self-test (TMCODE_DEV_SELFTEST=projects, debug builds):
 * TMCODE_DEV_MIS_TOKEN signs in through Task Mentor's real /auth/exchange,
 * then a Task Mentor project is created from the open folder, saved, edited,
 * saved again, and fetched into a second, empty folder (TMCODE_DEV_SECOND_FOLDER).
 */
export async function runProjectsSelfTest(platform: Platform, log: (msg: string) => void) {
  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      log(`projects selftest ${name}: ${await fn()}`);
      return true;
    } catch (e) {
      log(`projects selftest ${name}: FAILED ${String((e as Error)?.message ?? e)}`);
      return false;
    }
  };
  const host = platform.account!;
  const until = async (cond: () => boolean, ms = 20_000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
    if (!cond()) throw new Error("timed out");
  };
  let projectId = 0;
  await step("sign in", async () => {
    const s = await host.status(true);
    P.useProjects.setState({ account: s });
    if (!s.signed_in) throw new Error(s.error ?? "not signed in");
    return `${s.user?.name ?? s.user?.email} (local id ${s.user?.id}) via ${s.tm_api}; permissions ${s.user?.permissions.length}`;
  });
  await step("create + first save", async () => {
    await platform.fs.writeFile("selftest-project.txt", `created ${new Date().toISOString()}\n`).catch(async () => {
      await platform.fs.createFile("selftest-project.txt");
      await platform.fs.writeFile("selftest-project.txt", `created ${new Date().toISOString()}\n`);
    });
    const project = await P.createProject({ name: `Self-test ${Date.now()}`, kind: "tm", language: "python" });
    if (!project) throw new Error("not created");
    projectId = project.id;
    await P.connectFolder(project);
    const rev = await P.saveToTaskMentor({ message: "self-test first save", quiet: true });
    if (!rev) throw new Error(`save failed: ${P.useProjects.getState().syncMessage}`);
    return `project ${project.id} revision ${rev.number}: ${rev.file_count} files, ${rev.size_bytes} bytes; state ${P.useProjects.getState().sync}`;
  });
  await step("edit + save (only the changed blob uploads)", async () => {
    await platform.fs.writeFile("selftest-project.txt", `edited ${Date.now()}\n`);
    await P.checkSync();
    const before = P.useProjects.getState().plan;
    const rev = await P.saveToTaskMentor({ quiet: true });
    if (!rev) throw new Error("save failed");
    return `changes ${JSON.stringify(before?.localChanges)} → revision ${rev.number}; state ${P.useProjects.getState().sync}`;
  });
  await step("presence", async () => {
    const res = await P.api<{ presence: { online: boolean; state: { file: string | null } }[] }>("PUT", `/projects/${projectId}/presence`, { device_id: "selftest-device", app_version: platform.version, state: { open: true, file: "selftest-project.txt", dirty: 0, sync: "synced" } });
    return `online=${res.presence.some((p) => p.online)}`;
  });
  await step("list", async () => {
    await P.refreshProjects();
    const mine = P.useProjects.getState().mine ?? [];
    const me = mine.find((p) => p.id === projectId);
    return `${mine.length} project(s); this one head r${me?.head?.number} online=${me?.presence?.online}`;
  });
  // The copy goes next to the test workspace, never into the user's ~/TMCode Projects.
  const root = useWorkbench.getState().workspace?.root ?? "";
  const second = root.slice(0, Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\")));
  await step("get latest into a second folder", async () => {
    const folder = await host.newFolder(`selftest-copy-${Date.now()}`, second);
    const ws = await platform.openPath!(folder);
    const { setWorkspace } = await import("@tmcode/workbench");
    await setWorkspace(ws);
    await until(() => P.useProjects.getState().binding === null);
    const { project } = await P.api<{ project: Parameters<typeof P.connectFolder>[0] }>("GET", `/projects/${projectId}`);
    await P.connectFolder(project);
    await P.pullFromTaskMentor({ quiet: true });
    const text = await platform.fs.readFile("selftest-project.txt");
    return `${folder}: selftest-project.txt = ${JSON.stringify(text.trim())}; state ${P.useProjects.getState().sync}`;
  });
  log("projects selftest done");
}

/**
 * Extension host self-test (TMCODE_DEV_SELFTEST=exthost, TMCODE_DEV_WORKSPACE=<folder with app.js>):
 * installs real extensions from Open VSX, runs them in the Node.js extension
 * host and checks they work: Code Formatter & Minifier's Beautify/Minify
 * commands and Path Intellisense's completions.
 */
export async function runExthostSelfTest(platform: Platform, log: (msg: string) => void) {
  const X = exthostForSelfTest;
  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      log(`exthost selftest ${name}: ${await fn()}`);
    } catch (e) {
      log(`exthost selftest ${name}: FAILED ${String((e as Error)?.message ?? e)}`);
    }
  };
  const wait = async (what: string, pred: () => boolean, ms = 60_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  // Debug builds share the user's app data: remember what to put back afterwards.
  const ext = platform.extensions!;
  const hadTrust = await platform.store.get<boolean>("extensions.codeTrustAcknowledged");
  const before = new Set((await ext.list()).map((e) => e.id));
  // The one-time trust notice counts as accepted (it is a dialog nobody can click here).
  await platform.store.set("extensions.codeTrustAcknowledged", true);
  for (const id of ["lyuwenhan.code-formatter-and-minifier", "christian-kohler.path-intellisense"]) {
    await step(`install ${id}`, async () => {
      const [ns, name] = id.split(".");
      const d = JSON.parse(await ext.fetch(`https://open-vsx.org/api/${ns}/${name}`, "text")) as { version: string; displayName: string; files: { download: string } };
      // Through Rust directly (errors are reported here), twice on a slow network.
      let last: unknown;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await ext.install(id, d.files.download);
          await X.loadInstalledExtensions();
          return `v${d.version}${attempt > 1 ? ` (attempt ${attempt})` : ""}`;
        } catch (e) {
          last = e;
        }
      }
      throw last;
    });
  }
  await step("node host", async () => {
    await wait("the extension host", () => X.useExtHost.getState().status === "running");
    return X.useExtHost.getState().nodeInfo ?? "?";
  });
  await step("code formatter & minifier", async () => {
    X.openFile("app.js", { pinned: true });
    const id = "lyuwenhan.code-formatter-and-minifier";
    await wait("activation", () => !!X.useExtHost.getState().runtime[id]?.state && X.useExtHost.getState().runtime[id]?.state !== "activating");
    const rt = X.useExtHost.getState().runtime[id];
    if (rt?.state !== "activated") throw new Error(`state ${rt?.state}: ${rt?.error}`);
    const model = await X.ensureDocument("app.js");
    const before = model.getValue();
    await X.executeExtensionCommand("minifier.beautify", [{ $path: "app.js" }]);
    await wait("beautified text", () => model.getValue() !== before, 20_000);
    const beautified = model.getValue();
    await X.executeExtensionCommand("minifier.minify", [{ $path: "app.js" }]);
    await wait("minified text", () => model.getValue() !== beautified, 20_000);
    return `activated in ${rt.activationTime}ms; beautify → ${beautified.split("\n").length} lines; minify → ${JSON.stringify(model.getValue().slice(0, 60))}`;
  });
  await step("path intellisense", async () => {
    const id = "christian-kohler.path-intellisense";
    await wait("activation", () => X.useExtHost.getState().runtime[id]?.state === "activated");
    const model = await X.ensureDocument("main.js");
    model.setValue("import x from './'\n");
    // Through Monaco's own suggest: trigger at the slash and read the widget's items.
    X.openFile("main.js", { pinned: true });
    await new Promise((r) => setTimeout(r, 800));
    const editor = X.monaco.editor.getEditors().find((e) => e.getModel() === model);
    if (!editor) throw new Error("no editor for main.js");
    editor.focus();
    editor.setPosition({ lineNumber: 1, column: 18 });
    editor.trigger("selftest", "editor.action.triggerSuggest", {});
    let labels: string[] = [];
    await wait("suggestions", () => {
      labels = [...document.querySelectorAll(".suggest-widget .monaco-list-row")].map((e) => e.getAttribute("aria-label") ?? e.textContent ?? "");
      return labels.length > 0;
    }, 15_000).catch((e) => {
      const host = X.useWorkbench.getState().output.filter((l) => l.channel === "Extension Host" || l.channel === "Path Intellisense").slice(-8).map((l) => l.text);
      throw new Error(`${(e as Error).message}; host log: ${host.join(" | ")}`);
    });
    return `suggestions: ${labels.join(", ")}`;
  });
  await step("cleanup", async () => {
    const added = (await ext.list()).map((e) => e.id).filter((id) => !before.has(id));
    for (const id of added) await ext.uninstall(id);
    if (!hadTrust) await platform.store.set("extensions.codeTrustAcknowledged", false);
    return `removed ${added.join(", ") || "nothing"}`;
  });
  log("exthost selftest done");
}
