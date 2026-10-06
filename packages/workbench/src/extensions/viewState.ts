import { create } from "zustand";

/** The Extensions view's search box (commands such as "Show Installed Extensions" set it). */
export const useExtensionsView = create<{ query: string; focusSeq: number }>()(() => ({ query: "", focusSeq: 0 }));

export function setExtensionsQuery(query: string, focus = false) {
  useExtensionsView.setState((s) => ({ query, focusSeq: focus ? s.focusSeq + 1 : s.focusSeq }));
}
