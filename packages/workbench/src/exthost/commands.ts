import { registerCommand } from "../commands/registry";
import { extensionHost, extensionsBlocked, useExtensions } from "../extensions/service";
import { openEditorInput } from "../state/store";
import { showQuickPick } from "../widgets/QuickPick";
import { restartExtensionHosts } from "./hostService";
import { useExtHost } from "./state";

/** VS Code's "Developer: Restart Extension Host" and "Developer: Show Running Extensions". */
export function registerExtHostCommands() {
  const available = () => !!extensionHost() && !extensionsBlocked();
  registerCommand({
    id: "workbench.action.restartExtensionHost",
    title: "Restart Extension Host",
    category: "Developer",
    enabled: available,
    run: () => restartExtensionHosts(true),
  });
  registerCommand({
    id: "workbench.action.showRuntimeExtensions",
    title: "Show Running Extensions",
    category: "Developer",
    enabled: available,
    run: async () => {
      const { runtime, cannotRun, status, nodeInfo } = useExtHost.getState();
      const code = useExtensions.getState().installed.filter((e) => e.manifest.hasCode);
      const items = code.map((e) => {
        const r = runtime[e.id];
        const state = !e.enabled ? "Disabled" : cannotRun[e.id] ? "Cannot run here" : r?.state === "activated" ? `Activated in ${r.activationTime ?? 0}ms` : r?.state === "activating" ? "Activating…" : r?.state === "failed" ? "Failed" : "Not activated";
        return {
          id: e.id,
          label: e.manifest.displayName,
          description: state,
          detail: r?.state === "failed" ? r.error : cannotRun[e.id] ?? (r?.reason ? `${r.host === "node" ? "Node.js" : "Web Worker"} host · activated by ${r.reason}` : e.id),
          icon: r?.state === "failed" || cannotRun[e.id] ? "error" : r?.state === "activated" ? "pass" : "circle-large-outline",
        };
      });
      const picked = await showQuickPick({
        title: `Running Extensions — host ${status}${nodeInfo ? ` (${nodeInfo})` : ""}`,
        placeholder: items.length ? "Select an extension to see its details" : "No installed extension runs code",
        items,
        matchOnDescription: true,
      });
      if (picked) openEditorInput({ kind: "extension", id: `extension:${picked.id}`, extensionId: picked.id, preview: false });
    },
  });
}
