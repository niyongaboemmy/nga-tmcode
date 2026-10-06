// Real extensions' tree views and webviews through the bundled Node host:
// activates one extension against a folder (a git repository for GitLens and
// Git Graph), lists what it registered, shows its tree views (top level and
// one level down) and the webviews it creates. The command (if any) runs
// first, after activation.
//   node packages/exthost/test/views-real.mjs <unpacked extension dir> <workspace folder> [command to run] [view ids to show…]
import { resolve } from "node:path";
import { FakeWorkbench, describeExtension } from "./harness.mjs";

const [extDir, root, command, ...showViews] = process.argv.slice(2);
if (!extDir || !root) {
  console.error("usage: node views-real.mjs <extension dir> <workspace> [command] [view ids…]");
  process.exit(2);
}
const ext = describeExtension(resolve(extDir));
const wb = new FakeWorkbench({ root: resolve(root), extensions: [ext] });
const ui = () => wb.ui;
const label = (i) => `${i.label}${i.description ? ` — ${i.description}` : ""}${i.icon?.codicon ? ` [$(${i.icon.codicon})]` : i.icon ? ` [${JSON.stringify(i.icon.dark).slice(0, 90)}]` : ""}${i.collapsible ? (i.collapsible === 2 ? " ▾" : " ▸") : ""}`;

try {
  await wb.init;
  await wb.request("$startup");
  const views = Object.values(ext.manifest.contributes?.views ?? {}).flat().map((v) => v.id);
  for (const id of showViews.length ? showViews : views) await wb.request("$activateByEvent", [`onView:${id}`]).catch(() => {});
  await wb.waitFor(() => ["activated", "failed"].includes(wb.states.get(ext.id)?.state), "activation", 60000);
  console.log(`${ext.id}: ${wb.states.get(ext.id)?.state} ${wb.states.get(ext.id)?.error ?? ""}`);
  await new Promise((r) => setTimeout(r, 4000));
  if (command) {
    const before = ui().length;
    const res = await wb.request("$executeCommand", [command, []]).catch((e) => `error: ${e.message}`);
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`\n${command} → ${typeof res === "string" ? res : JSON.stringify(res ?? null)}`);
    for (const u of ui().slice(before)) {
      if (u[0] !== "$main.webview") continue;
      const data = u[1] === "html" ? `${String(u[3]).length} chars: ${String(u[3]).replace(/\s+/g, " ").slice(0, 200)}…` : JSON.stringify(u[3]).slice(0, 300);
      console.log(`  ${u[1]} ${u[2]} ${data}`);
    }
  }
  const trees = ui().filter((u) => u[0] === "$main.treeView" && u[1] === "register").map((u) => u[2]);
  const webviewViews = ui().filter((u) => u[0] === "$main.webviewView" && u[1] === "register").map((u) => u[2]);
  console.log(`tree views (${trees.length}): ${trees.join(", ")}`);
  console.log(`webview views (${webviewViews.length}): ${webviewViews.join(", ")}`);
  for (const id of trees.filter((t) => !showViews.length || showViews.includes(t))) {
    await wb.request("$treeVisible", [id, true]).catch(() => {});
    let roots = await wb.request("$treeChildren", [id, null]).catch((e) => `error: ${e.message}`);
    // Trees that load in the background report an empty list first, then refresh.
    for (let i = 0; i < 20 && Array.isArray(roots) && !roots.length; i++) {
      await new Promise((r) => setTimeout(r, 500));
      roots = await wb.request("$treeChildren", [id, null]).catch((e) => `error: ${e.message}`);
    }
    console.log(`\n▸ ${id}`);
    if (!Array.isArray(roots)) {
      console.log(`  ${roots}`);
      continue;
    }
    for (const r of roots.slice(0, 8)) {
      console.log(`  ${label(r)}`);
      if (r.collapsible) {
        const kids = await wb.request("$treeChildren", [id, r.handle]).catch((e) => `error: ${e.message}`);
        if (Array.isArray(kids)) for (const k of kids.slice(0, 6)) console.log(`    ${label(k)}`);
        else console.log(`    ${kids}`);
      }
    }
    const meta = ui().filter((u) => u[1] === "update" && u[2] === id).map((u) => JSON.stringify(u[3]));
    if (meta.length) console.log(`  meta: ${meta.slice(-3).join(" ")}`);
  }
  for (const id of webviewViews.filter((t) => !showViews.length || showViews.includes(t))) {
    const handle = await wb.request("$resolveWebviewView", [id]).catch((e) => `error: ${e.message}`);
    await new Promise((r) => setTimeout(r, 1500));
    const html = ui().filter((u) => u[1] === "html" && u[2] === handle).pop()?.[3] ?? "";
    console.log(`\n▸ webview view ${id}: ${handle}, html ${html.length} chars${html ? `: ${html.replace(/\s+/g, " ").slice(0, 160)}…` : ""}`);
  }
  const notes = wb.output.join("").split("\n").filter((l) => /not supported|error|failed/i.test(l)).slice(0, 15);
  if (notes.length) console.log(`\nlog:\n  ${notes.join("\n  ")}`);
} catch (e) {
  console.error(e);
  console.error(wb.logs.join("").slice(-3000));
} finally {
  await wb.close().catch(() => {});
}
