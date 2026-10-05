import { openFile, workbench } from "../state/store";
import { codeEditorFor } from "./editors";

/** Opens `path` pinned and moves the cursor to line/column once its model is showing. */
export function revealInEditor(path: string, line?: number, column = 1) {
  openFile(path, { pinned: true });
  if (!line) return;
  const go = (n = 0) => {
    const ed = codeEditorFor(workbench.get().activeGroup);
    if (ed?.getModel()?.uri.path === `/${path}`) {
      ed.setPosition({ lineNumber: line, column });
      ed.revealLineInCenterIfOutsideViewport(line);
      ed.focus();
    } else if (n < 20) setTimeout(() => go(n + 1), 25);
  };
  go();
}
