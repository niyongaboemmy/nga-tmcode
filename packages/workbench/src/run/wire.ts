import { onDocumentChanged } from "../monaco/documents";
import { onExternalChanges } from "../monaco/external";
import { useWorkbench } from "../state/store";
import { TESTS_FILES, loadTests } from "./testService";
import { wireTestEditor } from "../testing/editor";
import { wireRunHub } from "./runHub";

let wired = false;

/** Loads practice tests when a folder opens, and again whenever tests.json is saved. */
export function wireRunServices() {
  if (wired) return;
  wired = true;
  wireRunHub();
  wireTestEditor();
  let root = useWorkbench.getState().workspace?.root ?? null;
  if (root) void loadTests();
  useWorkbench.subscribe((s) => {
    const next = s.workspace?.root ?? null;
    if (next !== root) {
      root = next;
      if (next) void loadTests();
    }
  });
  onExternalChanges((paths) => {
    if (paths.some((p) => TESTS_FILES.includes(p) && !useWorkbench.getState().dirty[p])) void loadTests();
  });
  onDocumentChanged((path) => {
    if (TESTS_FILES.includes(path) && !useWorkbench.getState().dirty[path]) void loadTests();
  });
}
