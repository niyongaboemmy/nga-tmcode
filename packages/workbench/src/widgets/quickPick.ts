import { closeQuickInput, openQuickInput } from "../state/store";

/** One row of a generic quick pick (VS Code's `window.showQuickPick`). */
export interface PickItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  /** Codicon name. */
  icon?: string;
  /** Section header shown on the first row of a group. */
  group?: string;
}

export interface PickOptions {
  /** Enter on text that matches nothing returns it as `{ id: "custom", label: text }`. */
  allowCustom?: boolean;
}

interface PendingPick {
  title: string;
  items: PickItem[];
  options: PickOptions;
  resolve: (item: PickItem | undefined) => void;
}

let pending: PendingPick | null = null;

export function currentPick(): PendingPick | null {
  return pending;
}

/** Shows `items` in the quick input and resolves with the chosen one (undefined on Escape). */
export function showQuickPick(title: string, items: PickItem[], options: PickOptions = {}): Promise<PickItem | undefined> {
  pending?.resolve(undefined);
  return new Promise((resolve) => {
    pending = {
      title,
      items,
      options,
      resolve: (item) => {
        pending = null;
        resolve(item);
      },
    };
    openQuickInput("pick", String(Date.now()));
  });
}

/** Called when the quick input showing `pick` closes without a choice. */
export function cancelPick(pick: PendingPick | null) {
  if (pick && pending === pick) pick.resolve(undefined);
}

export function acceptPick(item: PickItem) {
  const p = pending;
  closeQuickInput();
  p?.resolve(item);
}
