/** What the native extension host self-test (apps/desktop/src/selftest.ts) drives. */
export { installExtension, loadInstalledExtensions, useExtensions } from "../extensions/service";
export { executeExtensionCommand, restartExtensionHosts } from "./hostService";
export { useExtHost, useExtStatusBar } from "./state";
export { ensureDocument, getDocument } from "../monaco/documents";
export { openFile, useWorkbench } from "../state/store";
export { monaco } from "../monaco/setup";
