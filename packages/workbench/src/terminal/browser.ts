import { getPlatform, openEditorInput } from "../state/store";

/** Opens a local dev server in TMCode's Simple Browser, beside the code. */
export function openBrowser(url: string, opts: { toSide?: boolean } = { toSide: true }) {
  let id = url;
  try {
    id = `browser:${new URL(url).host}`;
  } catch {
    /* keep the raw url */
  }
  openEditorInput({ kind: "browser", id, url, preview: false }, opts);
}

export async function openExternalUrl(url: string) {
  const p = getPlatform();
  if (p.openExternal) await p.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
