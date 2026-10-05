import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { executeCommand, formatKeybinding, getCommand, keybindingFor } from "../../commands/registry";
import { revealLabel } from "../../commands/builtin";
import {
  activeFilePath,
  beginExplorerEdit,
  cancelExplorerEdit,
  createEntry,
  deleteEntry,
  getPlatform,
  moveEntry,
  notify,
  openContextMenu,
  openFile,
  renameEntry,
  select,
  setExplorerEditError,
  toggleDir,
  useWorkbench,
  type ContextMenuItem,
} from "../../state/store";
import { basename, dirname, isWithin, join, validateName } from "../../util/paths";
import { ActionButton, FileIcon, FolderIcon, Codicon } from "../../widgets/icons";
import type { DirEntry } from "../../platform/types";

interface Row {
  entry: DirEntry;
  depth: number;
}

/** Flattens the expanded tree into visible rows (keyboard navigation works on this list). */
function useRows(): Row[] {
  const dirs = useWorkbench((s) => s.dirs);
  const expanded = useWorkbench((s) => s.expanded);
  return useMemo(() => {
    const rows: Row[] = [];
    const walk = (path: string, depth: number) => {
      for (const entry of dirs[path] ?? []) {
        rows.push({ entry, depth });
        if (entry.kind === "dir" && expanded[entry.path]) walk(entry.path, depth + 1);
      }
    };
    walk("", 0);
    return rows;
  }, [dirs, expanded]);
}

function InlineNameInput({
  depth,
  kind,
  initial,
  siblings,
  onSubmit,
}: {
  depth: number;
  kind: "file" | "dir";
  initial: string;
  siblings: string[];
  onSubmit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const error = useWorkbench((s) => s.explorerEdit?.error ?? null);
  const ref = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the name without the extension, as VS Code does on rename.
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, kind === "file" && dot > 0 ? dot : initial.length);
  }, [initial, kind]);

  const validate = (v: string) => validateName(v, siblings.filter((s) => s !== initial));

  const commit = async () => {
    if (submitted.current) return;
    if (!value.trim() || value === initial) return cancelExplorerEdit();
    const err = validate(value);
    if (err) return setExplorerEditError(err);
    submitted.current = true;
    try {
      await onSubmit(value);
    } catch (e) {
      submitted.current = false;
      setExplorerEditError(String((e as Error)?.message ?? e));
    }
  };

  return (
    <div className="tm-list-row tm-explorer-edit" style={{ paddingLeft: 8 + depth * 8 + 16 }}>
      {kind === "dir" ? <FolderIcon open={false} /> : <FileIcon path={value || "untitled"} />}
      <div className="tm-inline-input-wrap">
        <input
          ref={ref}
          className={`tm-inline-input ${error ? "has-error" : ""}`}
          value={value}
          aria-label={kind === "dir" ? "Folder name" : "File name"}
          aria-invalid={!!error}
          onChange={(e) => {
            setValue(e.target.value);
            setExplorerEditError(e.target.value.trim() ? validate(e.target.value) : null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") cancelExplorerEdit();
          }}
          onBlur={() => void commit()}
        />
        {error && (
          <div className="tm-input-message is-error" role="alert">
            {error.split("**").map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ExplorerView() {
  const workspace = useWorkbench((s) => s.workspace);
  const rows = useRows();
  const dirs = useWorkbench((s) => s.dirs);
  const expanded = useWorkbench((s) => s.expanded);
  const selection = useWorkbench((s) => s.selection);
  const edit = useWorkbench((s) => s.explorerEdit);
  const dirty = useWorkbench((s) => s.dirty);
  const problems = useWorkbench((s) => s.problems);
  const activePath = useWorkbench((s) => activeFilePath(s));
  const os = getPlatform().os;
  const [collapsed, setCollapsed] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const errorPaths = useMemo(() => {
    const set = new Map<string, "error" | "warning">();
    for (const p of problems) {
      if (p.severity === "info") continue;
      // Mark the file and every folder above it, like VS Code's decorations.
      let path = p.path;
      while (true) {
        if (set.get(path) !== "error") set.set(path, p.severity === "error" ? "error" : "warning");
        if (!path) break;
        path = dirname(path);
      }
    }
    return set;
  }, [problems]);

  if (!workspace) {
    return (
      <div className="tm-view-empty">
        <p>You have not yet opened a folder.</p>
        <button className="tm-button tm-button--block" onClick={() => executeCommand("workbench.action.files.openFolder")}>
          Open Folder
        </button>
        <p className="tm-muted">
          Exams and assigned tasks open here automatically when you start them from Task Mentor.
        </p>
      </div>
    );
  }

  const kb = (id: string) => {
    const cmd = getCommand(id);
    return cmd ? formatKeybinding(keybindingFor(cmd, os), os) : undefined;
  };

  const contextFor = (entry: DirEntry | null): ContextMenuItem[] => {
    const folder = entry ? (entry.kind === "dir" ? entry.path : dirname(entry.path)) : "";
    const items: ContextMenuItem[] = [
      { kind: "item", label: "New File...", keybinding: kb("explorer.newFile"), run: () => void beginExplorerEdit({ mode: "newFile", target: folder }) },
      { kind: "item", label: "New Folder...", run: () => void beginExplorerEdit({ mode: "newFolder", target: folder }) },
    ];
    if (entry) {
      items.push(
        { kind: "separator" },
        ...(getPlatform().reveal
          ? ([{ kind: "item", label: revealLabel(), run: () => void getPlatform().reveal?.(entry.path) }] as ContextMenuItem[])
          : []),
        {
          kind: "item",
          label: "Copy Relative Path",
          run: () => void navigator.clipboard?.writeText(entry.path).catch(() => notify("warning", "Clipboard is not available.")),
        },
        { kind: "separator" },
        { kind: "item", label: "Rename...", keybinding: "F2", run: () => void beginExplorerEdit({ mode: "rename", target: entry.path }) },
        { kind: "item", label: "Delete", keybinding: os === "mac" ? "⌘⌫" : "Delete", danger: true, run: () => void deleteEntry(entry.path) },
      );
    }
    return items;
  };

  const activate = (entry: DirEntry, pinned: boolean) => {
    if (entry.kind === "dir") void toggleDir(entry.path);
    else openFile(entry.path, { pinned });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (edit) return;
    const idx = rows.findIndex((r) => r.entry.path === selection);
    const row = idx >= 0 ? rows[idx] : null;
    const move = (i: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (r) {
        select(r.entry.path);
        treeRef.current?.querySelector(`[data-path="${CSS.escape(r.entry.path)}"]`)?.scrollIntoView({ block: "nearest" });
      }
    };
    switch (e.key) {
      case "ArrowDown":
        move(idx + 1);
        break;
      case "ArrowUp":
        move(idx < 0 ? rows.length - 1 : idx - 1);
        break;
      case "ArrowRight":
        if (row?.entry.kind === "dir") {
          if (!expanded[row.entry.path]) void toggleDir(row.entry.path, true);
          else move(idx + 1);
        }
        break;
      case "ArrowLeft":
        if (row?.entry.kind === "dir" && expanded[row.entry.path]) void toggleDir(row.entry.path, false);
        else if (row) {
          const parent = dirname(row.entry.path);
          if (parent) select(parent);
        }
        break;
      case "Enter":
        if (os === "mac" && row) void beginExplorerEdit({ mode: "rename", target: row.entry.path });
        else if (row) activate(row.entry, true);
        break;
      case " ":
        if (row) activate(row.entry, false);
        break;
      case "F2":
        if (row) void beginExplorerEdit({ mode: "rename", target: row.entry.path });
        break;
      case "Delete":
        if (row) void deleteEntry(row.entry.path);
        break;
      case "Backspace":
        if (row && (e.metaKey || e.ctrlKey)) void deleteEntry(row.entry.path);
        else return;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // ── drag & drop: move files and folders between folders ──
  const onDragStart = (e: DragEvent, entry: DirEntry) => {
    e.dataTransfer.setData("application/x-tmcode-path", entry.path);
    e.dataTransfer.setData("text/plain", entry.path);
    e.dataTransfer.effectAllowed = "move";
  };
  const folderOf = (entry: DirEntry | null) => (entry ? (entry.kind === "dir" ? entry.path : dirname(entry.path)) : "");
  const onDragOver = (e: DragEvent, entry: DirEntry | null) => {
    if (!e.dataTransfer.types.includes("application/x-tmcode-path")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(folderOf(entry));
  };
  const onDrop = async (e: DragEvent, entry: DirEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const from = e.dataTransfer.getData("application/x-tmcode-path");
    const folder = folderOf(entry);
    if (!from || dirname(from) === folder || isWithin(folder, from)) return;
    const name = basename(from);
    if ((dirs[folder] ?? []).some((x) => x.name === name)) {
      notify("warning", `A file or folder '${name}' already exists in '${folder || workspace.name}'.`);
      return;
    }
    try {
      if (folder && !expanded[folder]) await toggleDir(folder, true);
      await moveEntry(from, join(folder, name));
    } catch (err) {
      notify("error", `Could not move '${name}': ${String((err as Error)?.message ?? err)}`);
    }
  };

  const renderEditRow = (atParent: string, depth: number) => {
    if (!edit || edit.mode === "rename" || edit.target !== atParent) return null;
    return (
      <InlineNameInput
        key="__new__"
        depth={depth}
        kind={edit.mode === "newFolder" ? "dir" : "file"}
        initial=""
        siblings={(dirs[atParent] ?? []).map((e) => e.name)}
        onSubmit={async (name) => {
          const path = await createEntry(atParent, name, edit.mode === "newFolder" ? "dir" : "file");
          if (edit.mode === "newFile") openFile(path, { pinned: true });
        }}
      />
    );
  };

  const out: React.ReactNode[] = [renderEditRow("", 0)];
  for (const { entry, depth } of rows) {
    const isDir = entry.kind === "dir";
    const open = isDir && !!expanded[entry.path];
    if (edit?.mode === "rename" && edit.target === entry.path) {
      out.push(
        <InlineNameInput
          key={`rename:${entry.path}`}
          depth={depth}
          kind={entry.kind}
          initial={entry.name}
          siblings={(dirs[dirname(entry.path)] ?? []).map((e) => e.name)}
          onSubmit={(name) => renameEntry(entry.path, name)}
        />,
      );
    } else {
      const decoration = errorPaths.get(entry.path);
      const isDirty = !isDir && dirty[entry.path];
      out.push(
        <div
          key={entry.path}
          data-path={entry.path}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isDir ? open : undefined}
          aria-selected={selection === entry.path}
          className={[
            "tm-list-row",
            "tm-tree-row",
            selection === entry.path ? "is-selected" : "",
            activePath === entry.path ? "is-active-editor" : "",
            dropTarget === entry.path && isDir ? "is-drop-target" : "",
            decoration ? `has-${decoration}` : "",
          ].join(" ")}
          style={{ paddingLeft: 8 + depth * 8 }}
          draggable
          onDragStart={(e) => onDragStart(e, entry)}
          onDragOver={(e) => onDragOver(e, entry)}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(e) => void onDrop(e, entry)}
          onClick={() => {
            select(entry.path);
            activate(entry, false);
          }}
          onDoubleClick={() => !isDir && openFile(entry.path, { pinned: true })}
          onContextMenu={(e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            select(entry.path);
            openContextMenu(e.clientX, e.clientY, contextFor(entry));
          }}
        >
          {Array.from({ length: depth }, (_, i) => (
            <span key={i} className="tm-indent-guide" style={{ left: 8 + i * 8 + 7 }} />
          ))}
          <span className="tm-twistie">{isDir && <Codicon name={open ? "chevron-down" : "chevron-right"} />}</span>
          {isDir ? <FolderIcon open={open} name={entry.name} /> : <FileIcon path={entry.path} />}
          <span className="tm-tree-label">{entry.name}</span>
          {isDirty && <span className="tm-dirty-dot" title="Unsaved changes" />}
          {decoration && !isDir && <span className={`tm-decoration-badge is-${decoration}`}>{problems.filter((p) => p.path === entry.path && p.severity === decoration).length}</span>}
          {decoration && isDir && <span className={`tm-decoration-dot is-${decoration}`} />}
        </div>,
      );
      if (isDir && open) out.push(renderEditRow(entry.path, depth + 1));
    }
  }

  return (
    <div className="tm-pane">
      <div
        className="tm-pane-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setCollapsed(!collapsed)}
      >
        <Codicon name={collapsed ? "chevron-right" : "chevron-down"} />
        <span className="tm-pane-title">{workspace.name}</span>
        <div className="tm-pane-actions" onClick={(e) => e.stopPropagation()}>
          <ActionButton icon="new-file" label={`New File... (${kb("explorer.newFile")})`} onClick={() => executeCommand("explorer.newFile")} />
          <ActionButton icon="new-folder" label="New Folder..." onClick={() => executeCommand("explorer.newFolder")} />
          <ActionButton icon="refresh" label="Refresh Explorer" onClick={() => executeCommand("workbench.files.action.refreshFilesExplorer")} />
          <ActionButton icon="collapse-all" label="Collapse Folders in Explorer" onClick={() => executeCommand("workbench.files.action.collapseExplorerFolders")} />
        </div>
      </div>
      {!collapsed && (
        <div
          ref={treeRef}
          className={`tm-pane-body tm-explorer tm-scroll ${dropTarget === "" ? "is-drop-target" : ""}`}
          role="tree"
          aria-label="Files Explorer"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onDragOver={(e) => onDragOver(e, null)}
          onDrop={(e) => void onDrop(e, null)}
          onContextMenu={(e) => {
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, contextFor(null));
          }}
        >
          {out}
          {rows.length === 0 && !edit && <div className="tm-view-hint">This folder is empty. Create a file to get started.</div>}
        </div>
      )}
    </div>
  );
}
