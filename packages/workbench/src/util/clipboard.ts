import { getPlatform } from "../state/store";

/** Text to the system clipboard: the desktop's native clipboard, else the browser's. */
export async function writeClipboardText(text: string) {
  const clip = getPlatform().clipboard;
  if (clip) await clip.writeText(text);
  else await navigator.clipboard.writeText(text);
}
