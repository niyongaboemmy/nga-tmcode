import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { executeCommand, formatKeybinding } from "../../commands/registry";
import {
  activateEditor,
  closeEditors,
  focusGroup,
  getPlatform,
  moveEditor,
  openContextMenu,
  pinEditor,
  revealView,
  select,
  splitEditor,
  toggleDir,
  useWorkbench,
  type EditorGroup,
  type EditorInput,
} from "../../state/store";
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

function titleOf(e: EditorInput): string {
  if (e.kind === "file") return basename(e.path);
  if (e.kind === "preview") return `Preview ${basename(e.entry)}`;
  if (e.kind === "testDiff") return `Test: ${useWorkbench.getState().tests.items.find((t) => t.id === e.testId)?.name ?? e.testId}`;
  if (e.kind === "browser") return e.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (e.kind === "markdown" || e.kind === "image") return `Preview ${basename(e.path)}`;
  if (e.kind === "historyDiff" && e.source === "taskMentor") return `${basename(e.path)} (Task Mentor) ↔ Yours`;
  if (e.kind === "historyDiff" && e.source === "grading") return `${basename(e.path)} (${e.label ?? "Version"}) ↔ Submitted`;
  if (e.kind === "historyDiff") return `${basename(e.path)} (${new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}) ↔ Current`;
  if (e.kind === "gitDiff") return `${basename(e.path)} (${e.deleted ? "Deleted" : e.mode === "staged" ? "Index" : "Working Tree"})`;
  if (e.kind === "settings") return "Settings";
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
  if (e.kind === "historyDiff") return <Codicon name={e.source === "taskMentor" || e.source === "grading" ? "diff" : "history"} className="tm-tab-codicon" />;
  if (e.kind === "welcome") return <Logo size={14} />;
  if (e.kind === "preview") return <Codicon name="open-preview" className="tm-tab-codicon" />;
  if (e.kind === "testDiff") return <Codicon name="diff" className="tm-tab-codicon" />;
  if (e.kind === "extension") return <Codicon name="extensions" className="tm-tab-codicon" />;
  if (e.kind === "browser") return <Codicon name="globe" className="tm-tab-codicon" />;
  if (e.kind === "markdown" || e.kind === "image") return <Codicon name="open-preview" className="tm-tab-codicon" />;
  if (e.kind === "webview") return <WebviewTabIcon handle={e.handle} />;
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

function Breadcrumbs({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <nav className="tm-breadcrumbs" aria-label="Breadcrumbs">
      {parts.map((part, i) => {
        const sub = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        return (
          <span key={sub} className="tm-crumb-wrap">
            <button
              type="button"
              className="tm-crumb"
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
  // Webview panel titles change from the extension.
  useWebviews((s) => s.entries);
  const os = getPlatform().os;
  const [dragOver, setDragOver] = useState<number | null>(null);
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
    const idx = group.editors.indexOf(input);
    const others = group.editors.filter((x) => x !== input).map((x) => x.id);
    const right = group.editors.slice(idx + 1).map((x) => x.id);
    const saved = group.editors.filter((x) => !(x.kind === "file" && dirty[x.path])).map((x) => x.id);
    openContextMenu(e.clientX, e.clientY, [
      { kind: "item", label: "Close", keybinding: formatKeybinding("mod+w", os), run: () => void closeEditors(group.id, [input.id]) },
      { kind: "item", label: "Close Others", disabled: !others.length, run: () => void closeEditors(group.id, others) },
      { kind: "item", label: "Close to the Right", disabled: !right.length, run: () => void closeEditors(group.id, right) },
      { kind: "item", label: "Close Saved", run: () => void closeEditors(group.id, saved) },
      { kind: "item", label: "Close All", run: () => void closeEditors(group.id, group.editors.map((x) => x.id)) },
      { kind: "separator" },
      ...(input.kind === "file"
        ? ([
            { kind: "item", label: "Copy Relative Path", run: () => void navigator.clipboard?.writeText(input.path) },
            {
              kind: "item",
              label: "Reveal in Explorer View",
              run: async () => {
                revealView("explorer");
                const parts = input.path.split("/");
                for (let j = 1; j < parts.length; j++) await toggleDir(parts.slice(0, j).join("/"), true);
                select(input.path);
              },
            },
            { kind: "separator" },
          ] as const)
        : []),
      ...(input.preview ? ([{ kind: "item", label: "Keep Open", run: () => input.kind === "file" && pinEditor(input.path) }] as const) : []),
      {
        kind: "item",
        label: "Split Right",
        run: () => {
          activateEditor(group.id, input.id);
          splitEditor();
        },
      },
    ]);
  };

  const onDragStart = (e: DragEvent, input: EditorInput) => {
    e.dataTransfer.setData("application/x-tmcode-editor", JSON.stringify({ group: group.id, id: input.id }));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDrop = (e: DragEvent, index: number) => {
    const raw = e.dataTransfer.getData("application/x-tmcode-editor");
    setDragOver(null);
    if (!raw) return;
    e.preventDefault();
    const { group: from, id } = JSON.parse(raw) as { group: number; id: string };
    moveEditor(from, id, group.id, index);
  };
  const acceptsDrag = (e: DragEvent) => e.dataTransfer.types.includes("application/x-tmcode-editor");

  return (
    <section
      className={`tm-editor-group ${isActiveGroup ? "is-active" : ""} ${single ? "is-single" : ""}`}
      aria-label={`Editor Group ${group.id + 1}`}
      onMouseDown={() => focusGroup(group.id)}
    >
      {group.editors.length > 0 && (
        <div className="tm-tabs-bar">
          <div
            ref={tabsRef}
            className="tm-tabs tm-scroll-x"
            role="tablist"
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
                  title={input.kind === "file" ? input.path : titleOf(input)}
                  className={[
                    "tm-tab",
                    isActive ? "is-active" : "",
                    input.preview ? "is-preview" : "",
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
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") activateEditor(group.id, input.id);
                  }}
                >
                  {iconOf(input)}
                  <span className="tm-tab-label">{titleOf(input)}</span>
                  {desc && <span className="tm-tab-desc">{desc}</span>}
                  <button
                    type="button"
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
                </div>
              );
            })}
            {dragOver === group.editors.length && <div className="tm-tab-drop-end" />}
          </div>
          <div className="tm-tabs-actions">
            {active?.kind === "file" && <ExtensionTitleActions path={active.path} />}
            {active?.kind === "file" && <SidePreviewButton path={active.path} />}
            {active?.kind === "file" && <RunSplitButton path={active.path} />}
            <ActionButton icon="split-horizontal" label={`Split Editor Right (${formatKeybinding("mod+\\", os)})`} onClick={() => splitEditor()} />
            <ActionButton
              icon="ellipsis"
              label="More Actions..."
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openContextMenu(r.right - 180, r.bottom + 2, [
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
      {active?.kind === "file" && <Breadcrumbs path={active.path} />}
      <div className="tm-editor-content">
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
