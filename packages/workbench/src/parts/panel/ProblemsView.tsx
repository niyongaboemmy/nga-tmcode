import { useMemo, useState } from "react";
import { revealInEditor } from "../../monaco/reveal";
import { useWorkbench, type Problem } from "../../state/store";
import { basename, dirname } from "../../util/paths";
import { Codicon, FileIcon } from "../../widgets/icons";
import { useTreeKeyboard, type TreeKeyRow } from "../../widgets/useTreeKeyboard";

/** The Problems list: files and their problems, with VS Code's tree keyboard model (↑/↓/←/→, Enter opens). */
export function ProblemsView({ filter }: { filter: string }) {
  const problems = useWorkbench((s) => s.problems);
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  const byFile = useMemo(() => {
    const q = filter.toLowerCase();
    const map = new Map<string, Problem[]>();
    for (const p of problems) {
      if (q && !`${p.message} ${p.path} ${p.source ?? ""}`.toLowerCase().includes(q)) continue;
      map.set(p.path, [...(map.get(p.path) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === "error" ? -1 : 1));
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [problems, filter]);

  const fileId = (path: string) => `f:${path}`;
  const itemId = (path: string, i: number) => `p:${path}#${i}`;
  const { rows, index } = useMemo(() => {
    const rows: TreeKeyRow[] = [];
    const index = new Map<string, Problem>();
    for (const [path, list] of byFile) {
      const open = !collapsed[path];
      rows.push({ id: fileId(path), parent: null, expandable: true, expanded: open });
      if (open)
        list.forEach((p, i) => {
          rows.push({ id: itemId(path, i), parent: fileId(path), expandable: false, expanded: false });
          index.set(itemId(path, i), p);
        });
    }
    return { rows, index };
  }, [byFile, collapsed]);

  const setOpen = (path: string, open: boolean) => {
    const next = { ...collapsed };
    if (open) delete next[path];
    else next[path] = true;
    setCollapsed(next);
  };
  const reveal = (p: Problem) => revealInEditor(p.path, p.line, p.column);
  const tree = useTreeKeyboard("tm-problem-row", rows, {
    onToggle: (id, open) => setOpen(id.slice(2), open),
    onOpen: (id) => {
      const p = index.get(id);
      if (p) reveal(p);
    },
  });

  if (!byFile.length) {
    return <div className="tm-panel-empty">{problems.length ? "No results found with provided filter criteria." : "No problems have been detected in the workspace."}</div>;
  }

  return (
    <div className="tm-problems tm-scroll" aria-label="Problems" {...tree.treeProps}>
      {byFile.map(([path, list]) => {
        const open = !collapsed[path];
        const fid = fileId(path);
        return (
          <div key={path} role="none">
            <div
              role="treeitem"
              aria-level={1}
              aria-expanded={open}
              {...tree.rowProps(fid)}
              className={`tm-list-row tm-problems-file ${tree.focused === fid ? "is-focused" : ""}`}
              onClick={() => {
                tree.setFocused(fid);
                setOpen(path, !open);
              }}
            >
              <span className="tm-twistie">
                <Codicon name={open ? "chevron-down" : "chevron-right"} />
              </span>
              <FileIcon path={path} />
              <span className="tm-tree-label">{basename(path)}</span>
              <span className="tm-search-dir">{dirname(path)}</span>
              <span className="tm-badge">{list.length}</span>
            </div>
            {open &&
              list.map((p, i) => {
                const id = itemId(path, i);
                return (
                  <div
                    key={i}
                    role="treeitem"
                    aria-level={2}
                    {...tree.rowProps(id)}
                    className={`tm-list-row tm-problem ${tree.focused === id ? "is-focused" : ""}`}
                    onClick={() => {
                      tree.setFocused(id);
                      reveal(p);
                    }}
                    title={p.message}
                  >
                    <Codicon name={p.severity === "error" ? "error" : p.severity === "warning" ? "warning" : "info"} className={`tm-sev-${p.severity}`} />
                    <span className="tm-problem-msg">{p.message}</span>
                    {p.source && <span className="tm-muted">{p.source}</span>}
                    <span className="tm-muted">
                      [Ln {p.line}, Col {p.column}]
                    </span>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
