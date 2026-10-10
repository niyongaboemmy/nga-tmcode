import type { OsKind } from "../platform/types";

/**
 * Keys the webview itself acts on when the page doesn't stop them: WebView2
 * (Windows) reloads on F5 / Ctrl+R, goes back on Alt+Left, prints on Ctrl+P,
 * opens the find bar on Ctrl+F, offers caret browsing on F7, and so on. The
 * workbench always swallows these (after its own commands had their chance),
 * so a key with no command here never reloads TMCode or loses unsaved work.
 * Pure: `chord` is the canonical form from commands/registry (`mod+shift+r`).
 */

export interface KeyContext {
  /** Focus is in a code editor (Monaco). */
  inEditor: boolean;
  /** Focus is in a text field (input, textarea, contenteditable). */
  inInput: boolean;
  /** Focus is in the terminal. */
  inTerminal: boolean;
  /** Developer tools may open (debug builds outside exams). */
  devtools: boolean;
}

/** Reload, view source, print, save page, open page, browser zoom: never the webview's. */
const ALWAYS = new Set([
  "f5",
  "shift+f5",
  "mod+f5",
  "mod+shift+f5",
  "mod+r",
  "mod+shift+r",
  "mod+u",
  "mod+p",
  "mod+shift+p",
  "mod+s",
  "mod+o",
  "mod+n",
  "mod+shift+n",
  "mod+t",
  "mod+shift+t",
  "mod+=",
  "mod+shift+=",
  "mod+-",
  "mod+0",
  "f7",
  "browserback",
  "browserforward",
  "browserrefresh",
]);

/** Developer tools: blocked unless they are allowed. */
const DEVTOOLS = new Set(["f12", "mod+shift+i", "mod+shift+j", "mod+shift+c", "mod+alt+i", "mod+alt+j", "mod+alt+c"]);

/** The browser's own find bar: editors, fields and the terminal have their own find. */
const FIND = new Set(["mod+f", "f3", "shift+f3", "mod+g", "mod+shift+g"]);

/** Back / forward / home navigation (Windows and Linux): text fields and editors keep them. */
const NAVIGATION = new Set(["alt+left", "alt+right", "alt+home"]);

export function isBrowserReservedKey(chord: string, os: OsKind, ctx: KeyContext): boolean {
  if (ALWAYS.has(chord)) return true;
  if (DEVTOOLS.has(chord)) return !ctx.devtools;
  if (FIND.has(chord)) return !ctx.inEditor && !ctx.inInput && !ctx.inTerminal;
  // macOS: ⌥← / ⌥→ move by word in every text field; WebKit never navigates on them.
  if (NAVIGATION.has(chord)) return os !== "mac" && !ctx.inEditor && !ctx.inInput;
  return false;
}

/**
 * Ctrl+wheel (a pinch on a trackpad): whole-window zoom steps instead of the
 * webview's page zoom. Wheel deltas add up until they make one step, at most
 * one step per `minGapMs`.
 */
export class WheelZoom {
  private acc = 0;
  private lastStep = -Infinity;
  private lastWheel = -Infinity;
  constructor(
    private step: (dir: 1 | -1) => void,
    private threshold = 60,
    private minGapMs = 120,
  ) {}

  wheel(deltaY: number, now: number) {
    if (now - this.lastWheel > 600) this.acc = 0;
    this.lastWheel = now;
    this.acc += deltaY;
    if (Math.abs(this.acc) < this.threshold || now - this.lastStep < this.minGapMs) return false;
    const dir = this.acc < 0 ? 1 : -1;
    this.acc = 0;
    this.lastStep = now;
    this.step(dir);
    return true;
  }
}
