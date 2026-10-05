import { create } from "zustand";
import { workbench } from "./store";

/**
 * Zen Mode (Ctrl+K Z): only the editor. Side bar and panel visibility are
 * remembered and restored on exit; activity bar, status bar and title chrome
 * are hidden by CSS from the root's data-zen attribute.
 */
export const useZen = create<{ on: boolean; prev: { sidebar: boolean; panel: boolean } | null }>(() => ({ on: false, prev: null }));

export function toggleZenMode(force?: boolean) {
  const z = useZen.getState();
  const on = force ?? !z.on;
  if (on === z.on) return;
  const s = workbench.get();
  if (on) {
    useZen.setState({ on: true, prev: { sidebar: s.sidebarVisible, panel: s.panelVisible } });
    workbench.set({ sidebarVisible: false, panelVisible: false });
  } else {
    workbench.set({ sidebarVisible: z.prev?.sidebar ?? true, panelVisible: z.prev?.panel ?? false });
    useZen.setState({ on: false, prev: null });
  }
}
