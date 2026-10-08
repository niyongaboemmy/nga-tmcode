import { onDocumentChanged } from "../monaco/documents";
import { onExternalChanges } from "../monaco/external";
import { useWorkbench } from "../state/store";
import { TESTS_FILE, loadTests } from "./testService";
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
    if (paths.includes(TESTS_FILE) && !useWorkbench.getState().dirty[TESTS_FILE]) void loadTests();
  });
  onDocumentChanged((path) => {
    if (path === TESTS_FILE && !useWorkbench.getState().dirty[path]) void loadTests();
  });
}
