import type { IDisposable, Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { revealInEditor } from "../monaco/reveal";
import { getPlatform, notify, useWorkbench } from "../state/store";
import { findFileRefs, findLocalUrls, portOf, toWorkspaceRef } from "./links";
import { openBrowser, openExternalUrl } from "./browser";

export interface EnhancedTerminal {
  search: SearchAddon;
  /** Feed every chunk written to the terminal so dev servers can be detected. */
  observe(data: string): void;
  dispose(): void;
}

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1?\])(:\d+)?/i.test(url);

async function exists(path: string) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  try {
    return (await getPlatform().fs.readDir(dir)).some((e) => e.path === path && e.kind === "file");
  } catch {
    return false;
  }
}

/** Ports already announced in this session, so a restarting dev server is not announced twice. */
const announced = new Set<number>();

/** The Run hub opens its own dev servers' browser, so the generic "available on port" toast stays quiet for them. */
export function claimServerPort(port: number) {
  announced.add(port);
}

function announceServer(url: string) {
  const port = portOf(url);
  if (port == null || announced.has(port)) return;
  announced.add(port);
  notify("info", `Your application running on port ${port} is available.`, [
    { label: "Open in Browser Preview", run: () => openBrowser(url) },
    { label: "Open in External Browser", run: () => void openExternalUrl(url) },
  ]);
}

/** VS Code's terminal conveniences: Ctrl/Cmd-click links, file:line links, find, wide-char widths, server detection. */
export function enhanceTerminal(term: Terminal): EnhancedTerminal {
  const search = new SearchAddon();
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((event, uri) => {
    event.preventDefault();
    if (isLocal(uri)) openBrowser(uri);
    else void openExternalUrl(uri);
  }));
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
  } catch {
    /* needs allowProposedApi; emoji widths fall back to Unicode 6 */
  }

  const fileLinks: IDisposable = term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const root = useWorkbench.getState().workspace?.root ?? "";
      const links = findFileRefs(line).flatMap((ref) => {
        const path = toWorkspaceRef(ref.path, root);
        if (!path) return [];
        return [
          {
            range: { start: { x: ref.start + 1, y }, end: { x: ref.start + ref.length, y } },
            text: line.slice(ref.start, ref.start + ref.length),
            decorations: { pointerCursor: true, underline: true },
            activate: () => {
              void exists(path).then((ok) =>
                ok ? revealInEditor(path, ref.line, ref.column) : notify("warning", `The file "${path}" does not exist in this folder.`),
              );
            },
          },
        ];
      });
      callback(links.length ? links : undefined);
    },
  });

  // Ctrl/Cmd+F inside the terminal opens Find instead of reaching the shell.
  term.attachCustomKeyEventHandler((e) => {
    const mod = getPlatform().os === "mac" ? e.metaKey : e.ctrlKey;
    if (e.type === "keydown" && mod && !e.altKey && e.key.toLowerCase() === "f") {
      window.dispatchEvent(new CustomEvent("tmcode:terminal-find"));
      return false;
    }
    return true;
  });

  let tail = "";
  return {
    search,
    observe(data) {
      // Keep a little of the previous chunk: URLs can be split across writes.
      const text = tail + data;
      tail = text.slice(-200);
      if (!/https?:\/\//.test(text)) return;
      for (const url of findLocalUrls(text)) if (/:\d{2,5}/.test(url)) announceServer(url);
    },
    dispose() {
      fileLinks.dispose();
    },
  };
}
