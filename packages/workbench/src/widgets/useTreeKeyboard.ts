import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * VS Code's list keyboard model for a flattened tree (Search results,
 * Problems): ↑/↓ move, → expands or goes to the first child, ← collapses or
 * goes to the parent, Home/End, Enter opens, Delete dismisses. Focus stays on
 * the tree; the focused row is announced through aria-activedescendant.
 */
export interface TreeKeyRow {
  id: string;
  /** Id of the parent row (null at the top level). */
  parent: string | null;
  /** Expandable rows have children; `expanded` says whether they show. */
  expandable: boolean;
  expanded: boolean;
}

export interface TreeKeyboardOptions {
  onToggle(id: string, open: boolean): void;
  onOpen(id: string, opts: { pinned: boolean }): void;
  onDelete?(id: string): void;
}

export function treeRowDomId(prefix: string, id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  return `${prefix}-${(h >>> 0).toString(36)}-${id.length}`;
}

export function useTreeKeyboard(prefix: string, rows: TreeKeyRow[], opts: TreeKeyboardOptions) {
  const [focused, setFocused] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const current = rows.some((r) => r.id === focused) ? focused : null;

  useEffect(() => {
    if (!current) return;
    ref.current?.querySelector(`#${CSS.escape(treeRowDomId(prefix, current))}`)?.scrollIntoView({ block: "nearest" });
  }, [current, prefix]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!rows.length || e.altKey || e.metaKey || e.ctrlKey) return;
    const idx = current ? rows.findIndex((r) => r.id === current) : -1;
    const row = idx >= 0 ? rows[idx] : null;
    const go = (i: number) => setFocused(rows[Math.max(0, Math.min(rows.length - 1, i))].id);
    switch (e.key) {
      case "ArrowDown":
        go(idx + 1);
        break;
      case "ArrowUp":
        go(idx < 0 ? rows.length - 1 : idx - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(rows.length - 1);
        break;
      case "ArrowRight":
        if (!row) go(0);
        else if (row.expandable && !row.expanded) opts.onToggle(row.id, true);
        else if (row.expandable) go(idx + 1);
        break;
      case "ArrowLeft":
        if (row?.expandable && row.expanded) opts.onToggle(row.id, false);
        else if (row?.parent) setFocused(row.parent);
        break;
      case "Enter":
      case " ":
        if (!row) return;
        if (row.expandable) opts.onToggle(row.id, !row.expanded);
        else opts.onOpen(row.id, { pinned: e.key === "Enter" });
        break;
      case "Delete":
      case "Backspace":
        if (!row || !opts.onDelete) return;
        // Focus the next row (or the previous at the end) before the row goes away.
        {
          let next = idx + 1;
          while (next < rows.length && rows[next].parent === row.id) next++;
          const target = rows[next] ?? rows[idx - 1];
          opts.onDelete(row.id);
          setFocused(target && target.id !== row.parent ? target.id : (row.parent ?? null));
        }
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return {
    focused: current,
    setFocused,
    treeProps: {
      ref,
      tabIndex: 0,
      role: "tree" as const,
      onKeyDown,
      onFocus: () => {
        if (!current && rows.length) setFocused(rows[0].id);
      },
      "aria-activedescendant": current ? treeRowDomId(prefix, current) : undefined,
    },
    rowProps: (id: string) => ({
      id: treeRowDomId(prefix, id),
      "aria-selected": current === id,
      "data-focused": current === id ? "true" : undefined,
    }),
  };
}
