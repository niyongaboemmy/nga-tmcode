import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { executeCommand, formatKeybinding } from "../../commands/registry";
import {
  activateEditor,
  closeEditors,
  focusGroup,
  getPlatform,
  moveEditor,
  moveEditorToNewGroup,
  openContextMenu,
  openFile,
  pinEditor,
  revealView,
  select,
  setEditorSticky,
  splitEditor,
  toggleDir,
  useWorkbench,
  type ContextMenuItem,
  type EditorGroup,
  type EditorInput,
} from "../../state/store";
import { codeEditorFor } from "../../monaco/editors";
import { documentSymbols } from "../../commands/symbols";
import { compareWithSaved, openFileToSide, revealInExplorer, absolutePath } from "../../commands/vscodeCommands";
import { editorIdsToTheRight, otherEditorIds, savedEditorIds } from "../../commands/editorOrder";
import { basename, dirname } from "../../util/paths";
import { ActionButton, Codicon, FileIcon } from "../../widgets/icons";
import { Logo } from "../../widgets/Logo";
import { CodeEditor } from "./CodeEditor";
import { SettingsEditor } from "./SettingsEditor";
import { ShortcutsEditor } from "./ShortcutsEditor";
import { WelcomePage } from "./WelcomePage";
import { PreviewEditor } from "./PreviewEditor";
import { TestDiffEditor } from "./TestDiffEditor";
import { BrowserEditor } from "./BrowserEditor";
import { HistoryDiffEditor } from "../../history/HistoryDiffEditor";
import { MarkdownEditor } from "./MarkdownEditor";
import { MediaEditor, isMediaFile } from "./MediaEditor";
import { ExtensionEditor, extensionTitle } from "../extensions/ExtensionEditor";
import { ExtensionTitleActions } from "../../exthost/ui";
// ── git ──
import { GitDiffEditor } from "../../scm/GitDiffEditor";
// ── Run hub ──
import { RunSplitButton } from "../../run/RunHubViews";
import { openGitDiff } from "../../scm/gitService";
// ── extension webview panels ──
import { WebviewEditor, webviewTitle } from "../../exthost/views/WebviewSlot";
import { useWebviews } from "../../exthost/views/webviews";
import { ExtIcon } from "../../exthost/views/ExtIcon";
import { AssignmentEditor } from "../../projects/AssignmentEditor";
import { GradingEditor } from "../../grading/GradingEditor";
import { SqlResultsEditor } from "../../sql/SqlResultsEditor";
import { LogicEditor } from "../../logic/LogicEditor";
import { ApiTester } from "../../api/ApiTester";
import { SettingsJsonEditor } from "./SettingsJsonEditor";
import { SnippetsEditor } from "../../snippets/SnippetsEditor";
import type { SplitDirection } from "../../state/layout";

const EDITOR_DRAG = "application/x-tmcode-editor";

/** Where a dragged tab lands on an editor: an edge splits, the middle moves it into this group. */
export function dropZone(x: number, y: number, width: number, height: number): SplitDirection | "center" {
  const fx = x / Math.max(1, width);
  const fy = y / Math.max(1, height);
  // VS Code: the outer third of each side splits; the closest edge wins.
  const edges: [SplitDirection, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["up", fy],
    ["down", 1 - fy],
  ];
  const [dir, dist] = edges.sort((a, b) => a[1] - b[1])[0];
  return dist < 0.33 ? dir : "center";
}

function titleOf(e: EditorInput): string {
  if (e.kind === "file") return basename(e.path);
  if (e.kind === "preview") return `Preview ${basename(e.entry)}`;
  if (e.kind === "testDiff") return `Test: ${useWorkbench.getState().tests.items.find((t) => t.id === e.testId)?.name ?? e.testId}`;
  if (e.kind === "browser") return e.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (e.kind === "markdown" || e.kind === "image") return `Preview ${basename(e.path)}`;
  if (e.kind === "historyDiff" && e.source === "taskMentor") return `${basename(e.path)} (Task Mentor) ↔ Yours`;
  if (e.kind === "historyDiff" && e.source === "grading") return `${basename(e.path)} (${e.label ?? "Version"}) ↔ Submitted`;
  if (e.kind === "historyDiff" && e.source === "git") return `${basename(e.path)} (${e.entry.slice(0, 7)}) ↔ Now`;
  if (e.kind === "historyDiff" && e.source === "saved") return `${basename(e.path)} (Saved) ↔ Current`;
  if (e.kind === "historyDiff" && e.source === "file") return `${basename(e.entry)} ↔ ${basename(e.path)}`;
  if (e.kind === "snippets") return `${e.language}.json`;
  if (e.kind === "historyDiff" && e.source === "conflict") return `${basename(e.path)}: Current ↔ Incoming`;
  if (e.kind === "historyDiff") return `${basename(e.path)} (${new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}) ↔ Current`;
  if (e.kind === "gitDiff") return `${basename(e.path)} (${e.deleted ? "Deleted" : e.mode === "staged" ? "Index" : "Working Tree"})`;
  if (e.kind === "settings") return "Settings";
  if (e.kind === "settingsJson") return "settings.json";
  if (e.kind === "shortcuts") return "Keyboard Shortcuts";
  if (e.kind === "extension") return extensionTitle(e.extensionId);
  if (e.kind === "webview") return webviewTitle(e.handle);
  if (e.kind === "assignment") return e.title;
  if (e.kind === "grading") return e.title;
  if (e.kind === "sqlResults") return `SQL: ${basename(e.path)}`;
  if (e.kind === "logic") return `Truth Tables: ${basename(e.path)}`;
  if (e.kind === "api") return "API Tester";
  return "Welcome";
}

function iconOf(e: EditorInput) {
  if (e.kind === "file" || e.kind === "gitDiff") return <FileIcon path={e.path} />;
  if (e.kind === "historyDiff") return <Codicon name={e.source === "git" ? "git-commit" : e.source ? "diff" : "history"} className="tm-tab-codicon" />;
  if (e.kind === "welcome") return <Logo size={14} />;
  if (e.kind === "preview") return <Codicon name="open-preview" className="tm-tab-codicon" />;
  if (e.kind === "testDiff") return <Codicon name="diff" className="tm-tab-codicon" />;
  if (e.kind === "extension") return <Codicon name="extensions" className="tm-tab-codicon" />;
  if (e.kind === "browser") return <Codicon name="globe" className="tm-tab-codicon" />;
  if (e.kind === "markdown" || e.kind === "image") return <Codicon name="open-preview" className="tm-tab-codicon" />;
  if (e.kind === "webview") return <WebviewTabIcon handle={e.handle} />;
  if (e.kind === "settingsJson") return <Codicon name="json" className="tm-tab-codicon" />;
  if (e.kind === "snippets") return <Codicon name="symbol-snippet" className="tm-tab-codicon" />;
  if (e.kind === "assignment") return <Codicon name="mortar-board" className="tm-tab-codicon" />;
  if (e.kind === "grading") return <Codicon name="tasklist" className="tm-tab-codicon" />;
  if (e.kind === "sqlResults") return <Codicon name="database" className="tm-tab-codicon" />;
  if (e.kind === "logic") return <Codicon name="symbol-boolean" className="tm-tab-codicon" />;
  if (e.kind === "api") return <Codicon name="radio-tower" className="tm-tab-codicon" />;
  return <Codicon name={e.kind === "settings" ? "settings-gear" : "keyboard"} className="tm-tab-codicon" />;
}

function WebviewTabIcon({ handle }: { handle: string }) {
  const icon = useWebviews((s) => s.entries[handle]?.icon);
  return icon ? <ExtIcon icon={icon} className="tm-tab-codicon" /> : <Codicon name="preview" className="tm-tab-codicon" />;
}

/** Disambiguates same-named tabs with their folder, as VS Code does. */
function descriptions(editors: EditorInput[]) {
  const names = new Map<string, number>();
  for (const e of editors) names.set(titleOf(e), (names.get(titleOf(e)) ?? 0) + 1);
  return (e: EditorInput) => {
    if ((names.get(titleOf(e)) ?? 0) < 2) return "";
    if (e.kind === "file") return dirname(e.path) || ".";
    if (e.kind === "preview") return e.root || ".";
    if (e.kind === "gitDiff") return dirname(e.path) || ".";
    return "";
  };
}

/**
 * The path above the editor. Click a crumb to reveal it in the Explorer;
 * from the keyboard (Focus Breadcrumbs ⇧⌘; / Focus and Select Breadcrumbs ⇧⌘.)
 * ←/→ move between crumbs and Enter or ↓ lists a folder's files, or the
 * file's siblings and symbols.
 */
function Breadcrumbs({ path, groupId }: { path: string; groupId: number }) {
  const parts = path.split("/");
  const nav = useRef<HTMLElement>(null);
  const crumbs = () => [...(nav.current?.querySelectorAll<HTMLButtonElement>(".tm-crumb") ?? [])];

  const openList = async (i: number, el: HTMLElement) => {
    const dir = parts.slice(0, i).join("/");
    const s = useWorkbench.getState();
    const entries = [...(s.dirs[dir] ?? (await getPlatform().fs.readDir(dir).catch(() => [])))].sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
    const items: ContextMenuItem[] = entries.map((e) => ({
      kind: "item",
      label: e.kind === "dir" ? `${e.name}/` : e.name,
      run: () => (e.kind === "dir" ? void revealInExplorer(e.path) : openFile(e.path, { pinned: true, group: groupId })),
    }));
    const last = i === parts.length - 1;
    const model = last ? codeEditorFor(groupId)?.getModel() : null;
    if (model) {
      const symbols = await documentSymbols(model).catch(() => []);
      if (symbols.length) {
        items.push({ kind: "separator" });
        for (const sym of symbols.slice(0, 100)) {
          items.push({
            kind: "item",
            label: sym.container ? `${sym.container} › ${sym.name}` : sym.name,
            run: () => {
              const ed = codeEditorFor(groupId);
              if (!ed) return;
              ed.setPosition({ lineNumber: sym.selectionRange.startLineNumber, column: sym.selectionRange.startColumn });
              ed.revealLineInCenter(sym.selectionRange.startLineNumber);
              ed.focus();
            },
          });
        }
      }
    }
    if (!items.length) return;
    const r = el.getBoundingClientRect();
    openContextMenu(r.left, r.bottom + 2, items);
  };

  // Focus Breadcrumbs / Focus and Select Breadcrumbs (commands/vscodeCommands.ts) for this group.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ group: number; select: boolean }>).detail;
      if (d.group !== groupId) return;
      const all = crumbs();
      const lastCrumb = all[all.length - 1];
      if (!lastCrumb) return;
      lastCrumb.focus();
      if (d.select) void openList(all.length - 1, lastCrumb);
    };
    window.addEventListener("tmcode:breadcrumbs", on);
    return () => window.removeEventListener("tmcode:breadcrumbs", on);
  });

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const all = crumbs();
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") all[Math.max(0, Math.min(all.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))]?.focus();
    else if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") void openList(i, e.currentTarget as HTMLElement);
    else if (e.key === "Escape") codeEditorFor(groupId)?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <nav ref={nav} className="tm-breadcrumbs" aria-label="Breadcrumbs" data-testid="breadcrumbs">
      {parts.map((part, i) => {
        const sub = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        return (
          <span key={sub} className="tm-crumb-wrap">
            <button
              type="button"
              className="tm-crumb"
              onKeyDown={(e) => onKey(e, i)}
              onClick={async () => {
                revealView("explorer");
                for (let j = 1; j <= i + (last ? 0 : 1); j++) await toggleDir(parts.slice(0, j).join("/"), true);
                select(sub);
              }}
            >
              {last ? <FileIcon path={path} size={14} /> : <Codicon name="folder" className="tm-crumb-icon" />}
              {part}
            </button>
            {!last && <Codicon name="chevron-right" className="tm-crumb-sep" />}
          </span>
        );
      })}
    </nav>
  );
}

async function copyPlain(text: string) {
  const clip = getPlatform().clipboard;
  if (clip) await clip.writeText(text);
  else await navigator.clipboard?.writeText(text);
}

function Watermark() {
  const os = getPlatform().os;
  const workspace = useWorkbench((s) => s.workspace);
  const rows: [string, string, string][] = [
    ["Show All Commands", "mod+shift+p", "workbench.action.showCommands"],
    ...(workspace ? ([["Go to File", "mod+p", "workbench.action.quickOpen"]] as [string, string, string][]) : []),
    ["Open Folder", "mod+o", "workbench.action.files.openFolder"],
    ["Toggle Terminal", "ctrl+`", "workbench.action.terminal.toggleTerminal"],
    ["Open Settings", "mod+,", "workbench.action.openSettings"],
  ];
  return (
    <div className="tm-watermark" aria-hidden={false}>
      <Logo size={132} mono className="tm-watermark-logo" />
      <dl>
        {rows.map(([label, kb, cmd]) => (
          <div key={cmd} className="tm-watermark-row" onClick={() => executeCommand(cmd)}>
            <dt>{label}</dt>
            <dd>
              {formatKeybinding(kb, os)
                .split(" ")
                .map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function EditorGroupView({ group, single }: { group: EditorGroup; single: boolean }) {
  const activeGroup = useWorkbench((s) => s.activeGroup);
  const dirty = useWorkbench((s) => s.dirty);
  const breadcrumbs = useWorkbench((s) => s.settings["breadcrumbs.enabled"]);
  // Webview panel titles change from the extension.
  useWebviews((s) => s.entries);
  const os = getPlatform().os;
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [dropOn, setDropOn] = useState<SplitDirection | "center" | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const active = group.editors.find((e) => e.id === group.activeId) ?? null;
  const isActiveGroup = activeGroup === group.id;
  const describe = descriptions(group.editors);

  // Keep the active tab scrolled into view.
  useEffect(() => {
    tabsRef.current?.querySelector(".tm-tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [group.activeId]);

  const tabMenu = (e: MouseEvent, input: EditorInput) => {
    e.preventDefault();
    // As in VS Code, pinned tabs survive Close Others and Close to the Right (commands/editorOrder.ts).
    const others = otherEditorIds(group.editors, input.id);
    const right = editorIdsToTheRight(group.editors, input.id);
    const saved = savedEditorIds(group.editors.map((x) => ({ ...x, dirty: x.kind === "file" && !!dirty[x.path] })));
    openContextMenu(e.clientX, e.clientY, [
      { kind: "item", label: "Close", keybinding: formatKeybinding("mod+w", os), run: () => void closeEditors(group.id, [input.id]) },
      { kind: "item", label: "Close Others", disabled: !others.length, run: () => void closeEditors(group.id, others) },
      { kind: "item", label: "Close to the Right", disabled: !right.length, run: () => void closeEditors(group.id, right) },
      { kind: "item", label: "Close Saved", run: () => void closeEditors(group.id, saved) },
      { kind: "item", label: "Close All", run: () => void closeEditors(group.id, group.editors.map((x) => x.id)) },
      { kind: "separator" },
      ...(input.kind === "file"
        ? ([
            { kind: "item", label: "Copy Path", run: () => void copyPlain(absolutePath(input.path)) },
            { kind: "item", label: "Copy Relative Path", run: () => void copyPlain(input.path) },
            { kind: "item", label: "Reveal in Explorer View", run: () => void revealInExplorer(input.path) },
            { kind: "separator" },
            { kind: "item", label: "Open to the Side", run: () => openFileToSide(input.path) },
            ...(dirty[input.path] ? ([{ kind: "item", label: "Compare with Saved", run: () => compareWithSaved(input.path) }] as const) : []),
            { kind: "separator" },
          ] as const)
        : []),
      ...(input.preview ? ([{ kind: "item", label: "Keep Open", run: () => input.kind === "file" && pinEditor(input.path) }] as const) : []),
      input.sticky
        ? { kind: "item", label: "Unpin", keybinding: formatKeybinding("mod+k shift+enter", os), run: () => setEditorSticky(group.id, input.id, false) }
        : { kind: "item", label: "Pin", keybinding: formatKeybinding("mod+k shift+enter", os), run: () => setEditorSticky(group.id, input.id, true) },
      { kind: "separator" },
      ...(["up", "down", "left", "right"] as const).map((d) => ({
        kind: "item" as const,
        label: `Split ${d === "up" ? "Up" : d === "down" ? "Down" : d === "left" ? "Left" : "Right"}`,
        run: () => splitEditor(d, { group: group.id, editorId: input.id }),
      })),
    ]);
  };

  /** ←/→ (and Home/End) move between tabs: an ARIA tablist with a roving tabindex. */
  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % group.editors.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + group.editors.length) % group.editors.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = group.editors.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activateEditor(group.id, group.editors[i].id);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    const target = group.editors[next];
    if (!target) return;
    activateEditor(group.id, target.id);
    requestAnimationFrame(() => tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus());
  };

  const onDragStart = (e: DragEvent, input: EditorInput) => {
    e.dataTransfer.setData(EDITOR_DRAG, JSON.stringify({ group: group.id, id: input.id }));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDrop = (e: DragEvent, index: number) => {
    const raw = e.dataTransfer.getData(EDITOR_DRAG);
    setDragOver(null);
    if (!raw) return;
    e.preventDefault();
    const { group: from, id } = JSON.parse(raw) as { group: number; id: string };
    // A dropped tab lands among its kind: before the first unpinned tab at the earliest, unless it is pinned.
    const dragged = useWorkbench.getState().groups.find((g) => g.id === from)?.editors.find((x) => x.id === id);
    const pinnedCount = group.editors.filter((x) => x.sticky && x.id !== id).length;
    moveEditor(from, id, group.id, dragged?.sticky ? Math.min(index, pinnedCount) : Math.max(index, pinnedCount));
  };
  const acceptsDrag = (e: DragEvent) => e.dataTransfer.types.includes(EDITOR_DRAG);
  const zoneOf = (e: DragEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return dropZone(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };
  const onContentDrop = (e: DragEvent) => {
    const zone = dropOn ?? zoneOf(e);
    setDropOn(null);
    const raw = e.dataTransfer.getData(EDITOR_DRAG);
    if (!raw) return;
    e.preventDefault();
    const { group: from, id } = JSON.parse(raw) as { group: number; id: string };
    if (zone === "center") {
      if (from !== group.id) moveEditor(from, id, group.id, group.editors.length);
    } else moveEditorToNewGroup(from, id, group.id, zone);
  };

  return (
    <section
      className={`tm-editor-group ${isActiveGroup ? "is-active" : ""} ${single ? "is-single" : ""}`}
      aria-label={`Editor Group ${group.id + 1}`}
      data-group={group.id}
      onMouseDown={() => focusGroup(group.id)}
    >
      {group.editors.length > 0 && (
        <div className="tm-tabs-bar">
          <div
            ref={tabsRef}
            className="tm-tabs tm-scroll-x"
            role="tablist"
            aria-label="Open editors"
            onWheel={(e) => {
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
            }}
            onDragOver={(e) => {
              if (acceptsDrag(e)) {
                e.preventDefault();
                setDragOver(group.editors.length);
              }
            }}
            onDrop={(e) => onDrop(e, group.editors.length)}
            onDoubleClick={(e) => e.target === e.currentTarget && executeCommand("explorer.newFile")}
          >
            {group.editors.map((input, i) => {
              const isActive = input.id === group.activeId;
              const isDirty = (input.kind === "file" || (input.kind === "gitDiff" && input.mode === "working")) && !!dirty[input.path];
              const desc = describe(input);
              return (
                <div
                  key={input.id}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  data-editor-id={input.id}
                  title={input.kind === "file" ? input.path : titleOf(input)}
                  className={[
                    "tm-tab",
                    isActive ? "is-active" : "",
                    input.preview ? "is-preview" : "",
                    input.sticky ? "is-pinned" : "",
                    isDirty ? "is-dirty" : "",
                    dragOver === i ? "is-drop-before" : "",
                  ].join(" ")}
                  draggable
                  onDragStart={(e) => onDragStart(e, input)}
                  onDragOver={(e) => {
                    if (acceptsDrag(e)) {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOver(i);
                    }
                  }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(e) => {
                    e.stopPropagation();
                    onDrop(e, i);
                  }}
                  onMouseDown={(e) => {
                    if (e.button === 0) activateEditor(group.id, input.id);
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) void closeEditors(group.id, [input.id]);
                  }}
                  onDoubleClick={() => (input.kind === "file" ? pinEditor(input.path) : input.kind === "gitDiff" && openGitDiff(input.path, input.mode, input.deleted, true))}
                  onContextMenu={(e) => tabMenu(e, input)}
                  onKeyDown={(e) => onTabKey(e, i)}
                >
                  {iconOf(input)}
                  <span className="tm-tab-label">{titleOf(input)}</span>
                  {desc && <span className="tm-tab-desc">{desc}</span>}
                  {input.sticky ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="tm-tab-close tm-tab-unpin"
                      aria-label={`Unpin ${titleOf(input)}`}
                      title="Unpin"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditorSticky(group.id, input.id, false);
                      }}
                    >
                      <Codicon name="pinned" className="tm-tab-close-x" />
                      <span className="tm-tab-dirty-dot" aria-label="Unsaved changes" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="tm-tab-close"
                      aria-label={`Close ${titleOf(input)}`}
                      title={`Close (${formatKeybinding("mod+w", os)})`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        void closeEditors(group.id, [input.id]);
                      }}
                    >
                      <Codicon name="close" className="tm-tab-close-x" />
                      <span className="tm-tab-dirty-dot" aria-label="Unsaved changes" />
                    </button>
                  )}
                </div>
              );
            })}
            {dragOver === group.editors.length && <div className="tm-tab-drop-end" />}
          </div>
          <div className="tm-tabs-actions">
            {active?.kind === "file" && <ExtensionTitleActions path={active.path} />}
            {active?.kind === "file" && <SidePreviewButton path={active.path} />}
            {active?.kind === "file" && <RunSplitButton path={active.path} />}
            <ActionButton
              icon="split-horizontal"
              label={`Split Editor Right (${formatKeybinding("mod+\\", os)}). Alt-click: Split Down`}
              onClick={(e) => splitEditor(e.altKey ? "down" : "right", { group: group.id })}
            />
            <ActionButton
              icon="ellipsis"
              label="More Actions..."
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openContextMenu(r.right - 180, r.bottom + 2, [
                  { kind: "item", label: "Split Down", run: () => splitEditor("down", { group: group.id }) },
                  { kind: "item", label: "Split Right", run: () => splitEditor("right", { group: group.id }) },
                  { kind: "separator" },
                  { kind: "item", label: "Close All", run: () => void closeEditors(group.id, group.editors.map((x) => x.id)) },
                  {
                    kind: "item",
                    label: "Close Saved",
                    run: () => void closeEditors(group.id, group.editors.filter((x) => !(x.kind === "file" && dirty[x.path])).map((x) => x.id)),
                  },
                ]);
              }}
            />
          </div>
        </div>
      )}
      {breadcrumbs && active?.kind === "file" && !active.path.startsWith("tmcode-untitled:") && <Breadcrumbs path={active.path} groupId={group.id} />}
      <div
        className="tm-editor-content"
        onDragOver={(e) => {
          if (!acceptsDrag(e)) return;
          e.preventDefault();
          const zone = zoneOf(e);
          if (zone !== dropOn) setDropOn(zone);
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropOn(null);
        }}
        onDrop={onContentDrop}
      >
        {dropOn && <div className={`tm-editor-drop is-${dropOn}`} data-testid="editor-drop-overlay" aria-hidden />}
        {/* Keep Monaco mounted while switching between files of this group. */}
        {group.editors.some((e) => e.kind === "file" && !isMediaFile(e.path)) && (
          <div className="tm-editor-slot" hidden={active?.kind !== "file" || isMediaFile(active.path)}>
            <CodeEditor groupId={group.id} path={active?.kind === "file" && !isMediaFile(active.path) ? active.path : lastFile(group)} />
          </div>
        )}
        {active?.kind === "file" && isMediaFile(active.path) && <MediaEditor key={active.path} path={active.path} />}
        {active?.kind === "image" && <MediaEditor key={active.id} path={active.path} />}
        {active?.kind === "markdown" && <MarkdownEditor key={active.id} input={active} />}
        {active?.kind === "browser" && <BrowserEditor key={active.id} input={active} />}
        {active?.kind === "settings" && <SettingsEditor />}
        {active?.kind === "settingsJson" && <SettingsJsonEditor />}
        {active?.kind === "snippets" && <SnippetsEditor key={active.id} input={active} />}
        {active?.kind === "welcome" && <WelcomePage />}
        {active?.kind === "shortcuts" && <ShortcutsEditor />}
        {active?.kind === "preview" && <PreviewEditor key={active.id} input={active} />}
        {active?.kind === "testDiff" && <TestDiffEditor key={active.id} input={active} />}
        {active?.kind === "extension" && <ExtensionEditor key={active.id} extensionId={active.extensionId} />}
        {active?.kind === "webview" && <WebviewEditor key={active.id} handle={active.handle} />}
        {active?.kind === "historyDiff" && <HistoryDiffEditor key={active.id} input={active} />}
        {active?.kind === "assignment" && <AssignmentEditor key={active.id} input={active} />}
        {active?.kind === "grading" && <GradingEditor key={active.id} input={active} />}
        {active?.kind === "sqlResults" && <SqlResultsEditor key={active.id} input={active} />}
        {active?.kind === "logic" && <LogicEditor key={active.id} input={active} />}
        {active?.kind === "api" && <ApiTester key={active.id} />}
        {active?.kind === "gitDiff" && <GitDiffEditor key={active.id} input={active} groupId={group.id} />}
        {!active && <Watermark />}
      </div>
    </section>
  );
}

/** Markdown and SVG get VS Code's "Open Preview to the Side" (Ctrl+K V). */
function SidePreviewButton({ path }: { path: string }) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext !== "md" && ext !== "markdown" && ext !== "svg") return null;
  return <ActionButton icon="open-preview" label="Open Preview to the Side (Ctrl+K V)" onClick={() => executeCommand("markdown.showPreviewToSide")} />;
}

function lastFile(group: EditorGroup) {
  const f = [...group.editors].reverse().find((e) => e.kind === "file" && !isMediaFile(e.path));
  return f?.kind === "file" ? f.path : "";
}
