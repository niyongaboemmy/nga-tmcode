import { PREVIEW_MESSAGE_KEY, composeReactPage, injectIntoHead, loadTests, runTests, shimTag, useWorkbench, type Platform } from "@tmcode/workbench";

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
