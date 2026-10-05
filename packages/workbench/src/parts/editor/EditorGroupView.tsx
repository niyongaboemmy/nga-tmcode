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
import { profileForPath } from "@tmcode/profiles";

function titleOf(e: EditorInput): string {
  if (e.kind === "file") return basename(e.path);
  if (e.kind === "preview") return `Preview ${basename(e.entry)}`;
  if (e.kind === "testDiff") return `Test: ${useWorkbench.getState().tests.items.find((t) => t.id === e.testId)?.name ?? e.testId}`;
  if (e.kind === "settings") return "Settings";
  if (e.kind === "shortcuts") return "Keyboard Shortcuts";
  return "Welcome";
}

function iconOf(e: EditorInput) {
  if (e.kind === "file") return <FileIcon path={e.path} />;
  if (e.kind === "welcome") return <Logo size={14} />;
  if (e.kind === "preview") return <Codicon name="open-preview" className="tm-tab-codicon" />;
  if (e.kind === "testDiff") return <Codicon name="diff" className="tm-tab-codicon" />;
  return <Codicon name={e.kind === "settings" ? "settings-gear" : "keyboard"} className="tm-tab-codicon" />;
}

/** Disambiguates same-named tabs with their folder, as VS Code does. */
function descriptions(editors: EditorInput[]) {
  const names = new Map<string, number>();
  for (const e of editors) names.set(titleOf(e), (names.get(titleOf(e)) ?? 0) + 1);
  return (e: EditorInput) => {
    if ((names.get(titleOf(e)) ?? 0) < 2) return "";
    if (e.kind === "file") return dirname(e.path) || ".";
    if (e.kind === "preview") return e.root || ".";
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
              const isDirty = input.kind === "file" && !!dirty[input.path];
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
                  onDoubleClick={() => input.kind === "file" && pinEditor(input.path)}
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
            {active?.kind === "file" && <RunButton path={active.path} />}
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
        {group.editors.some((e) => e.kind === "file") && (
          <div className="tm-editor-slot" hidden={active?.kind !== "file"}>
            <CodeEditor groupId={group.id} path={active?.kind === "file" ? active.path : lastFile(group)} />
          </div>
        )}
        {active?.kind === "settings" && <SettingsEditor />}
        {active?.kind === "welcome" && <WelcomePage />}
        {active?.kind === "shortcuts" && <ShortcutsEditor />}
        {active?.kind === "preview" && <PreviewEditor key={active.id} input={active} />}
        {active?.kind === "testDiff" && <TestDiffEditor key={active.id} input={active} />}
        {!active && <Watermark />}
      </div>
    </section>
  );
}

const WEB_EXTS = ["html", "htm", "css", "jsx", "tsx"];

/** ▶ in the editor title, like VS Code's "Run Python File" (■ while running). */
function RunButton({ path }: { path: string }) {
  const running = useWorkbench((s) => s.run.status !== "idle");
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const web = WEB_EXTS.includes(ext);
  if (!web && !profileForPath(path)?.local) return null;
  if (running && !web) return <ActionButton icon="debug-stop" label="Stop (Shift+F5)" className="tm-stop" onClick={() => executeCommand("tmcode.stop")} />;
  return web ? (
    <ActionButton icon="open-preview" label="Open Preview to the Side (F5)" onClick={() => executeCommand("tmcode.run")} />
  ) : (
    <ActionButton icon="play" label="Run File (F5)" className="tm-run" onClick={() => executeCommand("tmcode.run")} />
  );
}

function lastFile(group: EditorGroup) {
  const f = [...group.editors].reverse().find((e) => e.kind === "file");
  return f?.kind === "file" ? f.path : "";
}
