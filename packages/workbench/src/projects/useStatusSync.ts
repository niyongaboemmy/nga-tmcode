import { useEffect, useState } from "react";
import type { StatusView } from "./status";

/**
 * "Updating…" never lasts: when the two sources disagree, both are refreshed
 * once, quietly; if they still disagree after that (a server that keeps a
 * withdrawn link "submitted", say), the derived status stands on its own and
 * the screen stops waiting. Returns the view with `syncing` settled.
 */
export function useStatusSync(view: StatusView | null, key: string | number, refresh: () => Promise<unknown>): StatusView | null {
  const syncKey = view?.syncing ? `${key}:${view.status}` : null;
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!syncKey) return;
    let alive = true;
    void refresh()
      .catch(() => {})
      .finally(() => alive && setSettled(syncKey));
    return () => {
      alive = false;
    };
  }, [syncKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!view || !view.syncing || settled !== syncKey) return view;
  return { ...view, syncing: false };
}
