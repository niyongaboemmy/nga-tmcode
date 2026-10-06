import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { MarkdownDTO, TreeItemDTO } from "@tmcode/exthost";
import { openContextMenu, type ContextMenuItem } from "../../state/store";
import { FileIcon, FolderIcon, Codicon } from "../../widgets/icons";
import { ExtIcon, commandIcon } from "./ExtIcon";
import { itemActions, type ViewMenuItem } from "./model";
import { childrenOf, resolveTooltip, runItemCommand, runItemMenuCommand, selectItems, setCheckbox, toggleExpanded, useTree, type TreeModel } from "./trees";

/** A MarkdownString as plain text for a native tooltip. */
export function plainText(md: string | MarkdownDTO | undefined): string | undefined {
  if (md === undefined) return undefined;
  const v = typeof md === "string" ? md : md.value;
  return v
    .replace(/\$\([\w~-]+\)\s?/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Row {
  item: TreeItemDTO;
  depth: number;
  expanded: boolean;
}

function rowsOf(t: TreeModel): { rows: Row[]; loading: boolean; error?: string } {
  const rows: Row[] = [];
  let loading = false;
  let error: string | undefined;
  const walk = (parent: string, depth: number) => {
    const c = childrenOf(t, parent);
    if (!c || c.state === "loading") {
      loading = true;
      if (!c || parent === "") return;
    }
    if (c.state === "error") {
      error ??= c.message;
      return;
    }
    if (c.state !== "done") return;
    for (const h of c.handles) {
      const item = t.items.get(h);
      if (!item) continue;
      const expanded = !!item.collapsible && t.expanded.has(h);
      rows.push({ item, depth, expanded });
      if (expanded) walk(h, depth + 1);
    }
  };
  walk("", 0);
  return { rows, loading, error };
}

function Label({ item }: { item: TreeItemDTO }) {
  const label = item.label.replace(/\$\(([\w-]+)\)/g, "");
  if (!item.highlights?.length) return <span className="tm-tree-label">{label}</span>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of [...item.highlights].sort((x, y) => x[0] - y[0])) {
    if (a > at) parts.push(label.slice(at, a));
    parts.push(<mark key={a}>{label.slice(Math.max(a, at), b)}</mark>);
    at = Math.max(at, b);
  }
  parts.push(label.slice(at));
  return <span className="tm-tree-label tm-ext-tree-highlights">{parts}</span>;
}

function ItemIcon({ item, expanded }: { item: TreeItemDTO; expanded: boolean }) {
  if (item.icon) return <ExtIcon icon={item.icon} className="tm-ext-tree-icon" />;
  if (item.resource) return item.resource.folder ? <FolderIcon open={expanded} name={item.resource.name} /> : <FileIcon path={item.resource.path ?? item.resource.name} />;
  return null;
}

function inlineButtons(viewId: string, item: TreeItemDTO, actions: ViewMenuItem[]) {
  return actions
    .filter((a) => a.group === "inline")
    .map((a) => {
      const icon = commandIcon(a.cmd.icon, a.cmd.extensionId);
      return (
        <button
          key={a.cmd.command}
          type="button"
          className="tm-action tm-ext-inline-action"
          title={a.cmd.title}
          aria-label={a.cmd.title}
          onClick={(e) => {
            e.stopPropagation();
            runItemMenuCommand(viewId, a.cmd.command, item.handle);
          }}
        >
          {icon ? <ExtIcon icon={icon} /> : <span className="tm-ext-action-text">{a.cmd.title}</span>}
        </button>
      );
    });
}

function contextItems(viewId: string, item: TreeItemDTO, actions: ViewMenuItem[]): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  let group: string | null = null;
  for (const a of actions) {
    if (a.group === "inline") continue;
    if (group !== null && a.group !== group) out.push({ kind: "separator" });
    group = a.group;
    out.push({ kind: "item", label: a.cmd.title, run: () => runItemMenuCommand(viewId, a.cmd.command, item.handle) });
  }
  return out;
}

/** An extension's tree view (TreeDataProvider) in a side bar pane. */
export function ExtTreeView({ viewId, empty }: { viewId: string; empty: ReactNode }) {
  const t = useTree(viewId);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!t?.scrollTo) return;
    const h = t.scrollTo;
    t.scrollTo = null;
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-handle="${CSS.escape(h)}"]`)?.scrollIntoView({ block: "nearest" }));
  });
  if (!t) return null;
  const { rows, loading, error } = rowsOf(t);
  if (error && !rows.length) return <div className="tm-view-hint tm-ext-view-error">{error}</div>;
  if (!rows.length && !loading) return <>{empty}</>;
  const sel = new Set(t.selection);

  const onClick = (e: MouseEvent, row: Row) => {
    const h = row.item.handle;
    if (t.options.canSelectMany && (e.metaKey || e.ctrlKey)) {
      selectItems(viewId, sel.has(h) ? t.selection.filter((x) => x !== h) : [...t.selection, h], h);
      return;
    }
    if (t.options.canSelectMany && e.shiftKey && t.focus) {
      const a = rows.findIndex((r) => r.item.handle === t.focus);
      const b = rows.findIndex((r) => r.item.handle === h);
      if (a >= 0 && b >= 0) {
        selectItems(viewId, rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.item.handle), h);
        return;
      }
    }
    selectItems(viewId, [h], h);
    if (row.item.command) runItemCommand(viewId, h);
    else if (row.item.collapsible) toggleExpanded(viewId, h);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const i = rows.findIndex((r) => r.item.handle === t.focus);
    const row = rows[i];
    const move = (to: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (r) selectItems(viewId, [r.item.handle], r.item.handle);
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i < 0 ? 0 : i - 1);
    else if (e.key === "ArrowRight" && row?.item.collapsible) {
      if (!row.expanded) toggleExpanded(viewId, row.item.handle, true);
      else move(i + 1);
    } else if (e.key === "ArrowLeft" && row) {
      if (row.expanded) toggleExpanded(viewId, row.item.handle, false);
      else {
        for (let j = i - 1; j >= 0; j--) if (rows[j].depth < row.depth) return move(j);
      }
    } else if ((e.key === "Enter" || e.key === " ") && row) {
      if (row.item.command) runItemCommand(viewId, row.item.handle);
      else if (row.item.collapsible) toggleExpanded(viewId, row.item.handle);
    } else return;
    e.preventDefault();
  };

  return (
    <div ref={ref} className="tm-ext-tree tm-scroll" role="tree" aria-label={viewId} aria-multiselectable={t.options.canSelectMany} tabIndex={0} onKeyDown={onKeyDown} data-testid={`ext-tree-${viewId}`}>
      {loading && <div className="tm-ext-progress" aria-hidden />}
      {rows.map((row) => {
        const { item, depth, expanded } = row;
        const actions = itemActions(viewId, item.contextValue, { listMultiSelection: t.selection.length > 1 });
        const inline = inlineButtons(viewId, item, actions);
        return (
          <div
            key={item.handle}
            data-handle={item.handle}
            className={`tm-list-row tm-tree-row tm-ext-tree-row ${sel.has(item.handle) ? "is-selected" : ""} ${t.focus === item.handle ? "is-focused" : ""}`}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={item.collapsible ? expanded : undefined}
            aria-selected={sel.has(item.handle)}
            style={{ paddingLeft: 4 + depth * 8 }}
            title={plainText(item.tooltip) ?? [item.label, item.description].filter(Boolean).join(" — ")}
            onMouseEnter={(e) => {
              if (!item.resolvable) return;
              const el = e.currentTarget;
              void resolveTooltip(viewId, item.handle).then((tip) => {
                const text = plainText(tip);
                if (text) el.title = text;
              });
            }}
            onClick={(e) => onClick(e, row)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!sel.has(item.handle)) selectItems(viewId, [item.handle], item.handle);
              const items = contextItems(viewId, item, actions);
              if (items.length) openContextMenu(e.clientX, e.clientY, items);
            }}
          >
            <span
              className="tm-twistie"
              onClick={(e) => {
                if (!item.collapsible) return;
                e.stopPropagation();
                toggleExpanded(viewId, item.handle);
              }}
            >
              {item.collapsible ? <Codicon name={expanded ? "chevron-down" : "chevron-right"} /> : null}
            </span>
            {item.checkbox && (
              <input
                type="checkbox"
                className="tm-ext-tree-checkbox"
                checked={item.checkbox.checked}
                title={item.checkbox.tooltip}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setCheckbox(viewId, item.handle, e.target.checked)}
              />
            )}
            <ItemIcon item={item} expanded={expanded} />
            <Label item={item} />
            {item.description && <span className="tm-ext-tree-desc">{item.description}</span>}
            {inline.length > 0 && <span className="tm-ext-inline-actions">{inline}</span>}
          </div>
        );
      })}
    </div>
  );
}
