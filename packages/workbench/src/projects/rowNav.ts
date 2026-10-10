import { useLayoutEffect, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

/**
 * The list keyboard model of the Explorer for the Assignments and Projects
 * rows: one row is in the Tab order (roving tabindex), ↑/↓ move between rows,
 * Home/End jump to the first and last. Enter and Space are the rows' own.
 * Rows carry `data-row-nav` and render `tabIndex={-1}`.
 */
const ROW = "[data-row-nav]";

function rowsOf(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(ROW)];
}

function makeCurrent(root: HTMLElement, row: HTMLElement) {
  for (const r of rowsOf(root)) r.tabIndex = r === row ? 0 : -1;
}

export function useRowNav(ref: RefObject<HTMLElement | null>) {
  // After every render: exactly one row is tabbable (the last focused one if it is still there).
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const rows = rowsOf(root);
    if (rows.length && !rows.some((r) => r.tabIndex === 0)) rows[0]!.tabIndex = 0;
  });

  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const root = ref.current;
    const row = (e.target as HTMLElement).closest<HTMLElement>(ROW);
    if (root && row && root.contains(row)) makeCurrent(root, row);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const root = ref.current;
    if (!root || e.altKey || e.metaKey || e.ctrlKey) return;
    const target = e.target as HTMLElement;
    const rows = rowsOf(root);
    if (!rows.length) return;
    const row = target.closest<HTMLElement>(ROW);
    // From the filter box, ↓ goes to the first row.
    if (!row) {
      if (e.key === "ArrowDown" && target.tagName === "INPUT") {
        e.preventDefault();
        rows[0]!.focus();
      }
      return;
    }
    const i = rows.indexOf(row);
    const go = (n: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, n))]!;
      makeCurrent(root, next);
      next.focus();
      next.scrollIntoView?.({ block: "nearest" });
    };
    switch (e.key) {
      case "ArrowDown":
        go(i + 1);
        break;
      case "ArrowUp":
        go(i - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(rows.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return { onKeyDown, onFocus };
}
