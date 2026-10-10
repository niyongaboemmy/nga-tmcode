import * as monaco from "monaco-editor";
import { getPlatform } from "../state/store";
import { onCodeEditor } from "./editors";
import { revealInEditor } from "./reveal";

/**
 * Editor navigation that must work from the first keystroke, not only once an
 * extension registers a provider (review V2):
 * - an editor opener, so Go to Definition / Peek / a reference into another
 *   workspace file opens that file in TMCode's editor;
 * - a link opener for `tmcode:` and web links;
 * - Go Back / Go Forward keys inside the editor (⌃- / ⌃⇧- on macOS, Alt+← /
 *   Alt+→ elsewhere). There is one history: commands/navigation.ts records every
 *   move and owns the Go menu and palette entries; these keys only call it.
 */

const SCHEME = "tmcode";
const pathOf = (uri: monaco.Uri) => uri.path.replace(/^\//, "");

// One history for the whole workbench (commands/navigation.ts). Imported lazily: it imports the editor modules.
export function goBack() {
  void import("../commands/navigation").then((m) => m.navigateBack());
}

export function goForward() {
  void import("../commands/navigation").then((m) => m.navigateForward());
}

let installed = false;
/** Registers the openers and navigation history. Called by setupMonaco; idempotent. */
export function installNavigation() {
  if (installed) return;
  installed = true;
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== SCHEME) return false;
      const p = selectionOrPosition as (Partial<monaco.IRange> & Partial<monaco.IPosition>) | undefined;
      revealInEditor(pathOf(resource), p?.startLineNumber ?? p?.lineNumber, p?.startColumn ?? p?.column);
      return true;
    },
  });
  monaco.editor.registerLinkOpener({
    open(resource) {
      if (resource.scheme === SCHEME) {
        revealInEditor(pathOf(resource));
        return true;
      }
      const platform = (() => {
        try {
          return getPlatform();
        } catch {
          return null;
        }
      })();
      if ((resource.scheme === "http" || resource.scheme === "https") && platform?.openExternal) {
        void platform.openExternal(resource.toString(true));
        return true;
      }
      return false;
    },
  });

  onCodeEditor((ed) => {
    // Monaco reads KeyMod.WinCtrl by its own OS detection (the user agent), so choose the keys by the same rule.
    const mac = navigator.userAgent.includes("Macintosh");
    const { KeyMod, KeyCode } = monaco;
    ed.addAction({
      id: "workbench.action.navigateBack",
      label: "Go Back",
      keybindings: [mac ? KeyMod.WinCtrl | KeyCode.Minus : KeyMod.Alt | KeyCode.LeftArrow],
      run: () => void goBack(),
    });
    ed.addAction({
      id: "workbench.action.navigateForward",
      label: "Go Forward",
      keybindings: [mac ? KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Minus : KeyMod.Alt | KeyCode.RightArrow],
      run: () => void goForward(),
    });
  });
}
