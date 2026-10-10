import * as monaco from "monaco-editor";
import { getPlatform, onEntryDeleted, onEntryRenamed, onWorkspaceChanged, workbench } from "../state/store";
import { codeEditorFor, onCodeEditor } from "./editors";
import { revealInEditor } from "./reveal";
import { isJump, NavHistory, type NavLocation } from "./navHistory";

/**
 * Editor navigation that must work from the first keystroke, not only once an
 * extension registers a provider (review V2):
 * - an editor opener, so Go to Definition / Peek / a reference into another
 *   workspace file opens that file in TMCode's editor;
 * - a link opener for `tmcode:` and web links;
 * - Go Back / Go Forward (⌃- / ⌃⇧- on macOS, Alt+← / Alt+→ elsewhere).
 */

const SCHEME = "tmcode";
const pathOf = (uri: monaco.Uri) => uri.path.replace(/^\//, "");

export const navHistory = new NavHistory();
/** Set while TMCode itself moves the cursor (going back), so that move is not recorded as a jump. */
let navigating = 0;

function locationOf(ed: monaco.editor.ICodeEditor | null | undefined): NavLocation | null {
  const model = ed?.getModel();
  const pos = ed?.getPosition();
  if (!model || !pos || model.uri.scheme !== SCHEME) return null;
  return { path: pathOf(model.uri), line: pos.lineNumber, column: pos.column };
}

function currentLocation() {
  return locationOf(codeEditorFor(workbench.get().activeGroup));
}

function go(target: NavLocation | null) {
  if (!target) return false;
  navigating++;
  revealInEditor(target.path, target.line, target.column);
  setTimeout(() => navigating--, 600);
  return true;
}

export function goBack() {
  return go(navHistory.goBack(currentLocation()));
}

export function goForward() {
  return go(navHistory.goForward(currentLocation()));
}

let installed = false;
/** Registers the openers and navigation history. Called by setupMonaco; idempotent. */
export function installNavigation() {
  if (installed) return;
  installed = true;
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      if (resource.scheme !== SCHEME) return false;
      navHistory.record(locationOf(source));
      const p = selectionOrPosition as (Partial<monaco.IRange> & Partial<monaco.IPosition>) | undefined;
      navigating++;
      revealInEditor(pathOf(resource), p?.startLineNumber ?? p?.lineNumber, p?.startColumn ?? p?.column);
      setTimeout(() => navigating--, 600);
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
    // Far moves inside one file (Go to Definition in the same file, a click 40 lines down) are jumps too.
    let last = locationOf(ed);
    ed.onDidChangeModel(() => {
      last = locationOf(ed);
    });
    ed.onDidChangeCursorPosition((e) => {
      const now = locationOf(ed);
      const from = last;
      last = now;
      if (!now || !from || from.path !== now.path || navigating) return;
      if (e.reason !== monaco.editor.CursorChangeReason.Explicit || e.source === "keyboard") return;
      if (isJump(from, now)) navHistory.record(from);
    });
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

  onWorkspaceChanged(() => navHistory.clear());
  onEntryRenamed((from, to) => navHistory.rename(from, to));
  onEntryDeleted((path) => navHistory.rename(path, null));
}
