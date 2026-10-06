import { registerCommand } from "../commands/registry";
import { revealView } from "../state/store";
import { extensionHost, extensionsBlocked, installFromVsix, loadInstalledExtensions, useExtensions, setExtensionEnabled } from "./service";
import { clearGalleryCache } from "./gallery";
import { setExtensionsQuery } from "./viewState";

const available = () => !!extensionHost() && !extensionsBlocked();

function show(query: string) {
  revealView("extensions");
  setExtensionsQuery(query, true);
}

/** VS Code's extension commands (ids match). Unavailable during exams. */
export function registerExtensionCommands() {
  registerCommand({ id: "workbench.view.extensions", title: "Show Extensions", category: "View", keybinding: "mod+shift+x", enabled: available, run: () => show("") });
  registerCommand({ id: "workbench.extensions.action.installExtensions", title: "Install Extensions", category: "Extensions", enabled: available, run: () => show("") });
  registerCommand({ id: "workbench.extensions.action.showInstalledExtensions", title: "Show Installed Extensions", category: "Extensions", enabled: available, run: () => show("@installed") });
  registerCommand({ id: "workbench.extensions.action.installVSIX", title: "Install from VSIX...", category: "Extensions", enabled: () => available() && !!extensionHost()?.installVsix, run: () => installFromVsix() });
  registerCommand({ id: "workbench.extensions.action.showRecommendedExtensions", title: "Show Recommended Extensions", category: "Extensions", enabled: available, run: () => show("@recommended") });
  registerCommand({ id: "workbench.extensions.action.showColorThemes", title: "Browse Color Themes in Marketplace", category: "Extensions", enabled: available, run: () => show('@category:"themes"') });
  registerCommand({
    id: "workbench.extensions.action.refreshExtension",
    title: "Refresh",
    category: "Extensions",
    enabled: available,
    run: () => {
      clearGalleryCache();
      void loadInstalledExtensions();
    },
  });
  registerCommand({
    id: "workbench.extensions.action.disableAll",
    title: "Disable All Installed Extensions",
    category: "Extensions",
    enabled: () => available() && useExtensions.getState().installed.some((e) => e.enabled),
    run: async () => {
      for (const e of useExtensions.getState().installed) if (e.enabled) await setExtensionEnabled(e.id, false);
    },
  });
  registerCommand({
    id: "workbench.extensions.action.enableAll",
    title: "Enable All Extensions",
    category: "Extensions",
    enabled: () => available() && useExtensions.getState().installed.some((e) => !e.enabled),
    run: async () => {
      for (const e of useExtensions.getState().installed) if (!e.enabled) await setExtensionEnabled(e.id, true);
    },
  });
}
