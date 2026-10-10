import { Allotment } from "allotment";
import { useMemo } from "react";
import { scheduleLayoutSave, useWorkbench, type EditorGroup } from "../../state/store";
import { nodeKey, reconcile, type GridNode } from "../../state/layout";
import { editorMemento } from "../../state/viewStates";
import { EditorGroupView } from "./EditorGroupView";

/**
 * Editor groups in rows and columns (VS Code's grid). Each branch is one
 * Allotment with stable pane keys, so adding a group beside others never
 * remounts them (editors that do remount get their cursor and scroll back
 * from editorMemento). Pane sizes are remembered per folder.
 */
export function EditorGrid() {
  const groups = useWorkbench((s) => s.groups);
  const layout = useWorkbench((s) => s.editorLayout);
  const tree = useMemo(() => reconcile(layout, groups.map((g) => g.id)), [layout, groups]);
  const byId = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const single = groups.length === 1;
  // A lone group is a one-pane row, so the first Split Right doesn't remount it.
  const root: Extract<GridNode, { type: "branch" }> = tree.type === "leaf" ? { type: "branch", dir: "row", children: [tree] } : tree;
  return <Branch key={`root-${root.dir}`} node={root} byId={byId} single={single} />;
}

function Branch({ node, byId, single }: { node: Extract<GridNode, { type: "branch" }>; byId: Map<number, EditorGroup>; single: boolean }) {
  const key = nodeKey(node);
  const saved = editorMemento.sizes.get(key);
  return (
    <Allotment
      className="tm-editor-groups"
      vertical={node.dir === "column"}
      defaultSizes={saved && saved.length === node.children.length ? saved : undefined}
      onChange={(sizes) => {
        if (node.children.length < 2 || sizes.length !== node.children.length || sizes.some((n) => !Number.isFinite(n) || n <= 0)) return;
        editorMemento.sizes.set(key, sizes.map(Math.round));
        scheduleLayoutSave(800);
      }}
    >
      {node.children.map((c) => (
        <Allotment.Pane key={nodeKey(c)} minSize={node.dir === "column" ? 90 : 180}>
          {c.type === "leaf" ? (
            byId.get(c.group) && <EditorGroupView group={byId.get(c.group)!} single={single} />
          ) : (
            <Branch key={c.dir} node={c} byId={byId} single={single} />
          )}
        </Allotment.Pane>
      ))}
    </Allotment>
  );
}
