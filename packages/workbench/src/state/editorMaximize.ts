import { create } from "zustand";

/**
 * View: Toggle Maximize Editor Group — one group fills the editor area while
 * the others wait hidden (parts/editor/EditorGrid). Cleared when that group
 * closes or another group gets focus from a command.
 */
export const useMaximizedGroup = create<{ group: number | null }>(() => ({ group: null }));
