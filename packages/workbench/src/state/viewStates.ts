/**
 * What the editor area remembers beyond the store: Monaco view state (cursor,
 * selections, scroll, folding) per "<group>:<path>" and split pane sizes per
 * grid branch. Saved with the folder's layout (store.ts scheduleLayoutSave),
 * kept out of zustand so dragging a sash or moving the cursor never re-renders.
 */
export const editorMemento = {
  viewStates: new Map<string, unknown>(),
  sizes: new Map<string, number[]>(),
  clear() {
    this.viewStates.clear();
    this.sizes.clear();
  },
  snapshot(): { sizes: Record<string, number[]>; viewStates: Record<string, unknown> } {
    return { sizes: Object.fromEntries(this.sizes), viewStates: Object.fromEntries(this.viewStates) };
  },
};
