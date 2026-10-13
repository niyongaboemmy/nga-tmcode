/**
 * Where projects live on disk. Most projects run anywhere (TMCode starts their own server), so they go
 * to the Projects Folder (~/TMCode Projects, or the "projects.folder" setting). PHP websites are
 * different: students who use XAMPP, MAMP, WAMP or Laragon need them in that server's web folder
 * (htdocs/www), where Apache and MySQL serve them at http://localhost/<folder>. TMCode finds those
 * folders, offers them for PHP work, serves the project from there, and can move a project later.
 */
import type { WebRoot } from "../platform/types";
import type { ProjectInfo, RunAction } from "../run/projectKind";
import { getPlatform, notify, useWorkbench } from "../state/store";
import { showQuickPick } from "../widgets/QuickPick";

let roots: WebRoot[] | null = null;

/** This computer's web-server folders (cached; `refresh` scans again). */
export async function webRoots(refresh = false): Promise<WebRoot[]> {
  const host = getPlatform().account;
  if (!host?.webRoots) return [];
  if (!roots || refresh) roots = await host.webRoots().catch(() => []);
  return roots;
}

/** The last scan's web-server folders (empty until webRoots() ran). */
export const knownWebRoots = () => roots ?? [];

/** Work that wants a web server: PHP (not Laravel's own `artisan serve` alone, but it works there too). */
export function wantsWebServer(hint: { language?: string | null; templateId?: string | null }): boolean {
  const lang = (hint.language ?? "").trim().toLowerCase();
  return lang === "php" || /^(php|laravel|wordpress)(-|$)/.test(hint.templateId ?? "");
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** The web server that serves `root` (a folder inside its document root), with the folder's address. */
export function servedBy(root: string | null | undefined, list: WebRoot[] = knownWebRoots()): { server: string; url: string } | null {
  if (!root) return null;
  const r = norm(root);
  for (const w of list) {
    const base = norm(w.path);
    const caseless = /^[a-z]:\//i.test(base);
    const inside = caseless ? r.toLowerCase().startsWith(`${base.toLowerCase()}/`) : r.startsWith(`${base}/`);
    if (inside) {
      const rel = r.slice(base.length + 1).split("/").map(encodeURIComponent).join("/");
      return { server: w.server, url: `${norm(w.url)}/${rel}` };
    }
  }
  return null;
}

/**
 * Projects served by the computer's web server get "Open in XAMPP (http://localhost/shop/)" first:
 * the page as Apache serves it (with MySQL), instead of PHP's built-in server.
 */
export function withWebServer(projects: ProjectInfo[], served: { server: string; url: string } | null): ProjectInfo[] {
  if (!served) return projects;
  return projects.map((p) => {
    if (p.kind !== "php" && p.kind !== "laravel" && p.kind !== "static-site") return p;
    const path = [p.dir, p.kind === "laravel" ? "public" : ""].filter(Boolean).join("/");
    const url = `${served.url}${path ? `/${path}` : ""}/`;
    const open: RunAction = {
      id: `openBrowser:${p.dir}:webserver`,
      kind: "openBrowser",
      label: `Open in ${served.server} (${url.replace(/^https?:\/\//, "")})`,
      icon: "server",
      description: `Served by ${served.server} (Apache): start it in its control panel`,
      url,
      needs: "none",
      practiceOnly: true,
    };
    // A loose folder of PHP exercises stays loose (each file runs on its own); a site runs from the server.
    return { ...p, actions: p.kind === "static-site" ? [...p.actions, open] : [open, ...p.actions] };
  });
}

const settings = () => useWorkbench.getState().settings;

/** The Projects Folder setting (undefined: TMCode's default, ~/TMCode Projects). */
export function projectsFolder(): string | undefined {
  return (settings()["projects.folder"] ?? "").trim() || undefined;
}

/**
 * Where a new project goes. `undefined`: the Projects Folder; a path: that folder; `null`: cancelled.
 * PHP work offers the web server's folder when this computer has one (Settings › Projects: PHP Websites);
 * `ask` (New Project from Template) always lets the student choose.
 */
export async function chooseBase(opts: { name: string; language?: string | null; templateId?: string | null; ask?: boolean }): Promise<string | undefined | null> {
  const folder = projectsFolder();
  const host = getPlatform().account;
  const php = wantsWebServer(opts);
  const mode = settings()["projects.phpLocation"] ?? "ask";
  const servers = php && mode !== "projectsFolder" ? await webRoots() : [];
  if (php && mode === "webServer" && servers.length) return servers[0].path;
  if (!servers.length && !opts.ask) return folder;
  const defaultPath = folder ?? (await host?.defaultBase?.().catch(() => undefined)) ?? "~/TMCode Projects";
  const pick = await showQuickPick({
    title: `Where should "${opts.name}" go?`,
    placeholder: servers.length ? "A PHP website can run on this computer's web server (Apache, MySQL) or on PHP's own server" : "Choose where the project folder is created",
    items: [
      ...servers.map((r, i) => ({
        id: `root:${i}`,
        label: `${r.server} web folder`,
        description: r.path,
        detail: `Served by ${r.server} at ${r.url}/… (start Apache in ${r.server}; MySQL works as usual)`,
        icon: "server",
        separator: i === 0 ? "web server" : undefined,
      })),
      { id: "default", label: "Projects Folder", description: defaultPath, detail: php ? "Runs with PHP's built-in server (php -S): nothing else to start" : "Where TMCode keeps your projects", icon: "folder", separator: servers.length ? "TMCode" : undefined },
      ...(host?.pickBase ? [{ id: "pick", label: "Choose a Folder…", detail: "Any folder on this computer", icon: "folder-opened", pinLast: true }] : []),
    ],
  });
  if (!pick) return null;
  if (pick.id === "default") return folder;
  if (pick.id === "pick") return (await host!.pickBase!(`Where should "${opts.name}" go?`)) ?? null;
  return servers[Number(pick.id.slice(5))]?.path;
}

/**
 * Projects: Move This Project… — the open project's folder moves (into a web server's folder, another
 * drive…); TMCode reopens it there and remembers the new place, and Task Mentor keeps it as it was.
 */
export async function moveOpenProject() {
  const p = getPlatform();
  const ws = useWorkbench.getState().workspace;
  if (!ws || !p.account?.moveFolder) return notify("info", "Open a project folder first.");
  const servers = await webRoots(true);
  const pick = await showQuickPick({
    title: `Move "${ws.name}" to…`,
    items: [
      ...servers.map((r, i) => ({ id: `root:${i}`, label: `${r.server} web folder`, description: r.path, detail: `Served at ${r.url}/${ws.name}`, icon: "server" })),
      { id: "default", label: "Projects Folder", description: projectsFolder() ?? (await p.account.defaultBase?.().catch(() => undefined)) ?? "~/TMCode Projects", icon: "folder" },
      ...(p.account.pickBase ? [{ id: "pick", label: "Choose a Folder…", icon: "folder-opened", pinLast: true }] : []),
    ],
  });
  if (!pick) return;
  const base = pick.id === "pick" ? await p.account.pickBase!(`Move "${ws.name}" to…`) : pick.id === "default" ? (projectsFolder() ?? (await p.account.defaultBase!())) : servers[Number(pick.id.slice(5))]?.path;
  if (!base) return;
  const { confirmLeaveWorkspace, openRecent } = await import("../state/store");
  if (!(await confirmLeaveWorkspace())) return;
  try {
    const moved = await p.account.moveFolder(ws.root, base);
    const { rememberMovedFolder } = await import("./service");
    await rememberMovedFolder(ws.root, moved);
    await openRecent(moved);
    notify("info", `Moved "${ws.name}" to ${moved}.`, undefined, { kind: "result" });
  } catch (e) {
    notify("error", `Could not move the project: ${(e as Error).message ?? e}`);
  }
}
