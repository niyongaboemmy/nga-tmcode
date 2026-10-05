import { onDocumentChanged } from "../monaco/documents";
import { useWorkbench } from "../state/store";
import { TESTS_FILE, loadTests } from "./testService";

let wired = false;

/** Loads practice tests when a folder opens, and again whenever tests.json is saved. */
export function wireRunServices() {
  if (wired) return;
  wired = true;
  let root = useWorkbench.getState().workspace?.root ?? null;
  if (root) void loadTests();
  useWorkbench.subscribe((s) => {
    const next = s.workspace?.root ?? null;
    if (next !== root) {
      root = next;
      if (next) void loadTests();
    }
  });
  onDocumentChanged((path) => {
    if (path === TESTS_FILE && !useWorkbench.getState().dirty[path]) void loadTests();
  });
}
