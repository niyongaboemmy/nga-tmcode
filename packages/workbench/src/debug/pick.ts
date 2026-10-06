import { showQuickPick } from "../widgets/QuickPick";

export interface ValueItem<T> {
  label: string;
  description?: string;
  icon?: string;
  /** Separator label on the first item of a group. */
  group?: string;
  value: T;
}

/** The shared id-based quick pick, returning the chosen item's value. */
export async function pickValue<T>(items: ValueItem<T>[], opts: { placeholder?: string; title?: string } = {}): Promise<T | undefined> {
  const picked = await showQuickPick({
    ...opts,
    items: items.map((it, i) => ({ id: String(i), label: it.label, description: it.description, icon: it.icon, separator: it.group })),
  });
  return picked ? items[Number(picked.id)]?.value : undefined;
}
