import type { ViewId } from "../state/store";
import type { ViewContainer } from "../exthost/views/model";

/** One icon of the activity bar: a built-in view or an extension's view container. */
export interface BarItem {
  key: string;
  view?: { id: ViewId; icon: string; label: string; command: string };
  container?: ViewContainer;
}

/**
 * What fits in the activity bar (`capacity` icons, More included when needed):
 * everything while it fits; otherwise the first ones, the open view always
 * among them, and the rest under More — each item exactly once.
 */
export function splitBar(items: BarItem[], capacity: number, active: string | null): { shown: BarItem[]; overflow: BarItem[] } {
  const unique = items.filter((it, i) => items.findIndex((x) => x.key === it.key) === i);
  if (unique.length <= capacity) return { shown: unique, overflow: [] };
  const room = Math.max(1, capacity - 1); // one place for More
  let shown = unique.slice(0, room);
  const open = active ? unique.find((it) => it.key === active) : undefined;
  if (open && !shown.includes(open)) shown = [...shown.slice(0, room - 1), open];
  return { shown, overflow: unique.filter((it) => !shown.includes(it)) };
}
