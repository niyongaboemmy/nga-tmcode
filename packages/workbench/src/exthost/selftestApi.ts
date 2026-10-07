/** What the native extension host self-test (apps/desktop/src/selftest.ts) drives. */
export { installExtension, loadInstalledExtensions, useExtensions } from "../extensions/service";
export { executeExtensionCommand, restartExtensionHosts } from "./hostService";
export { useExtHost, useExtStatusBar } from "./state";
export { ensureDocument, getDocument } from "../monaco/documents";
export { openFile, useWorkbench } from "../state/store";
export { monaco } from "../monaco/setup";
// Extensions end-to-end self-test (TMCODE_DEV_SELFTEST=extensions).
export { uninstallExtension, setExtensionEnabled } from "../extensions/service";
export { allThemes, useThemes } from "../themes/themeService";
export { allIconThemes, useIconTheme } from "../themes/iconThemes";
export { updateSetting, showView } from "../state/store";
export { executeCommand } from "../commands/registry";
export { codeEditorFor } from "../monaco/editors";
export { workbench } from "../state/store";
export { useWebviews, webviewMessageCounts } from "./views/webviews";
