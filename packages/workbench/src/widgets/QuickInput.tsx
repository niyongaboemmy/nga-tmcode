import { useEffect, useMemo, useRef, useState } from "react";
import { allCommands, executeCommand, formatKeybinding, isEnabled, keybindingFor } from "../commands/registry";
import { codeEditorFor } from "../monaco/editors";
import { monaco } from "../monaco/setup";
import { listFiles } from "../parts/search/search";
import { openFileToSide } from "../commands/vscodeCommands";
import { allThemes, useThemes } from "../themes/themeService";
import { allIconThemes, useIconTheme } from "../themes/iconThemes";
import {
  activateEditor,
  closeQuickInput,
  getPlatform,
  openFile,
  setPreviewIconTheme,
  setPreviewTheme,
  updateSetting,
  useWorkbench,
  workbench,
  type EditorInput,
  type QuickInputMode,
} from "../state/store";
import { fuzzyMatch, highlightRuns } from "../util/fuzzy";
import { basename, dirname } from "../util/paths";
import { isUntitled } from "../util/untitled";
import { Codicon, FileIcon } from "./icons";
import { SkeletonRows } from "./Skeleton";
import { modeOfValue, rankFiles, type QuickMode } from "./quickOpenLogic";
import { parseLineSuffix } from "../commands/history";
import { editorsByMru, recentFiles } from "../commands/navigation";
import { documentSymbols, hasWorkspaceSymbolProvider, workspaceSymbols, type FlatSymbol, type WorkspaceSymbol } from "../commands/symbols";
import { currentKeybinding } from "../commands/keybindings";
import { symbolIcon } from "../outline/OutlinePane";

interface Item {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  keybinding?: string;
  icon?: React.ReactNode;
  group?: string;
  indices?: number[];
  descIndices?: number[];
  run: () => void;
  /** Ctrl/Cmd+Enter: open to the side (Quick Open files). */
  runToSide?: () => void;
}

/** Recently run commands, kept across restarts as in VS Code. */
const RECENT_KEY = "tmcode:recent-commands";
const recentCommands: string[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
})();
/**
 * Shown first while nothing has been run yet, so the palette never opens on an
 * alphabetical pick like "Accounts: Sign Out of NGA" that one Enter would run.
 */
const COMMON_COMMANDS = [
  "workbench.action.quickOpen",
  "workbench.view.assignments",
  "workbench.action.terminal.toggleTerminal",
  "workbench.view.search",
  "workbench.action.openSettings",
  "workbench.action.selectTheme",
];

/** Ctrl held? The editor switcher (Ctrl+Tab) opens on the key press and picks when Ctrl is released. */
let ctrlHeld = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => (ctrlHeld = e.ctrlKey), true);
  window.addEventListener("keyup", (e) => e.key === "Control" && (ctrlHeld = false), true);
  window.addEventListener("blur", () => (ctrlHeld = false));
}

/** Monaco actions that offer code help: hidden from the palette when the exam turns help off. */
const HELP_ACTIONS = /suggest|parameterHints|inlineCompletions|inlineSuggest|inlineEdit/i;

/** Colour themes grouped like VS Code's picker: light, dark, high contrast (built-ins first, then extensions). */
function themeItems() {
  const group = (ui: string) => (ui === "vs" ? "light themes" : ui === "vs-dark" ? "dark themes" : "high contrast themes");
  const order = ["light themes", "dark themes", "high contrast themes"];
  return allThemes()
    .map((t) => ({ id: t.id, label: t.label, group: group(t.uiTheme), description: t.extensionName }))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

function Highlighted({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices?.length) return <>{text}</>;
  return (
    <>
      {highlightRuns(text, indices).map((r, i) =>
        r.hit ? (
          <span key={i} className="tm-qi-hit">
            {r.text}
          </span>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}

const SPECIAL_TITLES: Partial<Record<EditorInput["kind"], string>> = { settings: "Settings", shortcuts: "Keyboard Shortcuts", welcome: "Welcome", api: "API Tester" };
function editorTitle(e: EditorInput): { label: string; description?: string } {
  if (e.kind === "file") return { label: basename(e.path), description: isUntitled(e.path) ? undefined : dirname(e.path) };
  if ("title" in e && typeof e.title === "string") return { label: e.title };
  if ("path" in e && typeof e.path === "string") return { label: basename(e.path), description: SPECIAL_TITLES[e.kind] ?? e.kind };
  return { label: SPECIAL_TITLES[e.kind] ?? e.kind.replace(/^\w/, (c) => c.toUpperCase()) };
}

export function QuickInput() {
  const qi = useWorkbench((s) => s.quickInput);
  if (!qi) return null;
  return <QuickInputWidget key={`${qi.mode}:${qi.initial ?? ""}`} baseMode={qi.mode} initial={qi.initial} />;
}

/** Moves the cursor of `ed` and shows it. */
function revealIn(ed: monaco.editor.ICodeEditor, line: number, column = 1) {
  ed.setPosition({ lineNumber: line, column });
  ed.revealLineInCenter(line);
  ed.focus();
}

/** Opens `path` and, once its model shows, puts the cursor on line:column. */
function openAt(path: string, line?: number, column?: number) {
  openFile(path, { pinned: true });
  if (!line) return;
  const go = (n = 0) => {
    const ed = codeEditorFor(workbench.get().activeGroup);
    const model = ed?.getModel();
    if (ed && model && model.uri.path === `/${path}`) {
      const l = Math.max(1, Math.min(model.getLineCount(), line));
      revealIn(ed, l, column ?? 1);
    } else if (n < 40) setTimeout(() => go(n + 1), 25);
  };
  go();
}

function QuickInputWidget({ baseMode, initial }: { baseMode: QuickInputMode; initial?: string }) {
  const os = getPlatform().os;
  const editorsMode = baseMode === "editors";
  const startValue = editorsMode ? "" : (initial ?? (baseMode === "commands" ? ">" : baseMode === "line" ? ":" : ""));
  const [value, setValue] = useState(startValue);
  const [files, setFiles] = useState<string[] | null>(null);
  const [symbols, setSymbols] = useState<FlatSymbol[] | null>(null);
  const [wsSymbols, setWsSymbols] = useState<WorkspaceSymbol[] | null>(null);
  // What had focus and which editor to act on, captured before the input takes focus.
  const [origin] = useState(() => {
    const before = document.activeElement as HTMLElement | null;
    const focused = monaco.editor.getEditors().find((e) => e.hasTextFocus()) ?? null;
    return { before, editor: (focused ?? codeEditorFor(workbench.get().activeGroup)) as monaco.editor.ICodeEditor | null };
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const currentTheme = useWorkbench((s) => s.settings["workbench.colorTheme"]);
  const currentIconTheme = useWorkbench((s) => s.settings["workbench.iconTheme"]);
  const themesVersion = useThemes((s) => s.version);
  const iconThemesVersion = useIconTheme((s) => s.version);
  const hasWorkspace = useWorkbench((s) => !!s.workspace);
  const intelligence = useWorkbench((s) => s.policy.intelligence);
  const wsProvider = hasWorkspaceSymbolProvider();
  const { mode, query } = useMemo((): { mode: QuickMode | "theme" | "iconTheme" | "editors"; query: string } => {
    if (baseMode === "theme" || baseMode === "iconTheme" || baseMode === "editors") return { mode: baseMode, query: value };
    return modeOfValue(value, { workspaceSymbols: wsProvider });
  }, [baseMode, value, wsProvider]);

  /** Closes, gives focus back to where it was (VS Code), then runs. */
  const closeAndRun = (fn: () => void) => {
    closeQuickInput();
    if (origin.before?.isConnected && origin.before !== document.body) origin.before.focus();
    fn();
  };

  useEffect(() => {
    inputRef.current?.focus();
    const el = inputRef.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    if (mode === "files" && files === null && hasWorkspace) void listFiles(getPlatform().fs).then(setFiles);
  }, [mode, files, hasWorkspace]);

  // "@": the symbols of the editor the palette was opened from.
  useEffect(() => {
    if (mode !== "symbols" || symbols !== null) return;
    const model = origin.editor?.getModel();
    if (!model) return void setSymbols([]);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The language worker may still be starting: an empty answer is asked again a few times.
    const load = (attempt: number) =>
      void documentSymbols(model).then(
        (s) => {
          if (!alive) return;
          if (!s.length && attempt < 6 && !model.isDisposed()) timer = setTimeout(() => load(attempt + 1), 400);
          else setSymbols(s);
        },
        () => alive && setSymbols([]),
      );
    load(0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [mode, symbols, origin.editor]);

  // "#": ask the providers (debounced).
  useEffect(() => {
    if (mode !== "workspaceSymbols") return;
    let alive = true;
    const t = setTimeout(() => void workspaceSymbols(query).then((s) => alive && setWsSymbols(s)), 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [mode, query]);

  const items: Item[] = useMemo(() => {
    if (mode === "commands") {
      const cmds = allCommands().filter((c) => !c.hidden && isEnabled(c));
      const known = new Set(allCommands().map((c) => c.id));
      // V6: the focused editor's own actions too (Add Cursor Above, Transform to Uppercase…).
      const ed = origin.editor;
      const actions = ed?.getModel()
        ? ed
            .getSupportedActions()
            .filter((a) => !known.has(a.id) && a.id !== "editor.action.quickCommand" && a.label && (intelligence === "full" || !HELP_ACTIONS.test(a.id)))
        : [];
      type Entry = { id: string; label: string; kb?: string; run: () => void };
      const entries: Entry[] = [
        ...cmds.map((c) => ({ id: c.id, label: c.category ? `${c.category}: ${c.title}` : c.title, kb: keybindingFor(c, os), run: () => executeCommand(c.id) })),
        ...actions.map((a) => ({
          id: a.id,
          label: a.label,
          kb: currentKeybinding(a.id),
          run: () => {
            ed?.focus();
            void a.run();
          },
        })),
      ];
      const scored = entries
        .map((c) => {
          const m = fuzzyMatch(query, c.label);
          return m ? { c, m } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      // Equal scores: the shorter (closer) label first, as VS Code ranks "Format Document" above "Format Document With...".
      if (query) scored.sort((a, b) => b.m.score - a.m.score || a.c.label.length - b.c.label.length);
      else scored.sort((a, b) => a.c.label.localeCompare(b.c.label));
      const pick = (ids: string[]) => ids.map((id) => scored.find((s) => s.c.id === id)).filter((x): x is NonNullable<typeof x> => !!x);
      const recent = query ? [] : recentCommands.length ? pick(recentCommands) : pick(COMMON_COMMANDS);
      const firstGroup = recentCommands.length ? "recently used" : "commonly used";
      const rest = scored.filter((s) => !recent.includes(s));
      const toItem = (s: (typeof scored)[number], group?: string): Item => ({
        id: s.c.id,
        label: s.c.label,
        keybinding: formatKeybinding(s.c.kb, os),
        indices: s.m.indices,
        group,
        run: () => {
          const at = recentCommands.indexOf(s.c.id);
          if (at >= 0) recentCommands.splice(at, 1);
          recentCommands.unshift(s.c.id);
          recentCommands.length = Math.min(recentCommands.length, 5);
          try {
            localStorage.setItem(RECENT_KEY, JSON.stringify(recentCommands));
          } catch {
            /* private window: recents stay in memory */
          }
          closeAndRun(s.c.run);
        },
      });
      return [...recent.map((s, i) => toItem(s, i === 0 ? firstGroup : undefined)), ...rest.map((s, i) => toItem(s, i === 0 && recent.length ? "other commands" : undefined))];
    }
    if (mode === "files") {
      // "main.py:12" (or ":12:5", "(12,5)") opens the file at that line.
      const parsed = parseLineSuffix(query);
      const recent = recentFiles();
      const ranked = rankFiles(parsed.query, files ?? [], recent);
      const recentCount = parsed.query ? 0 : ranked.filter((r) => r.recent).length;
      return ranked.slice(0, 200).map((r, i) => ({
        id: r.path,
        label: basename(r.path),
        description: dirname(r.path),
        icon: <FileIcon path={r.path} />,
        indices: r.match.labelIndices,
        descIndices: r.match.descIndices,
        detail: parsed.line ? `line ${parsed.line}${parsed.column ? `, column ${parsed.column}` : ""}` : undefined,
        group: recentCount ? (i === 0 ? "recently opened" : i === recentCount ? "files" : undefined) : undefined,
        run: () => {
          closeQuickInput();
          openAt(r.path, parsed.line, parsed.column);
        },
        runToSide: () => {
          closeQuickInput();
          openFileToSide(r.path);
        },
      }));
    }
    if (mode === "symbols") {
      const ed = origin.editor;
      return (symbols ?? [])
        .map((s) => ({ s, m: fuzzyMatch(query, s.name) }))
        .filter((x): x is { s: FlatSymbol; m: NonNullable<ReturnType<typeof fuzzyMatch>> } => !!x.m)
        .sort((a, b) => (query ? b.m.score - a.m.score : 0) || a.s.range.startLineNumber - b.s.range.startLineNumber)
        .map(({ s, m }, i) => ({
          id: `${s.name}:${s.selectionRange.startLineNumber}:${i}`,
          label: s.name,
          description: s.container,
          indices: m.indices,
          icon: <Codicon name={symbolIcon(s.kind)} className={`tm-outline-icon is-${symbolIcon(s.kind)}`} />,
          run: () => {
            closeQuickInput();
            if (ed) revealIn(ed, s.selectionRange.startLineNumber, s.selectionRange.startColumn);
          },
        }));
    }
    if (mode === "workspaceSymbols") {
      return (wsSymbols ?? []).slice(0, 200).map((s, i) => ({
        id: `${s.path}:${s.line}:${s.name}:${i}`,
        label: s.name,
        description: `${s.container ? `${s.container} · ` : ""}${s.path}`,
        indices: fuzzyMatch(query, s.name)?.indices,
        icon: <Codicon name={symbolIcon(s.kind)} className={`tm-outline-icon is-${symbolIcon(s.kind)}`} />,
        run: () => {
          closeQuickInput();
          openAt(s.path, s.line, s.column);
        },
      }));
    }
    if (mode === "help") {
      const modes: [prefix: string, label: string][] = [
        ["", "Go to File"],
        [">", "Show and Run Commands"],
        [":", "Go to Line/Column"],
        ["@", "Go to Symbol in Editor"],
        ...(wsProvider ? ([["#", "Go to Symbol in Workspace"]] as [string, string][]) : []),
        ["?", "Help"],
      ];
      return modes
        .filter(([, label]) => fuzzyMatch(query, label))
        .map(([prefix, label]) => ({
          id: `help:${prefix}`,
          label: prefix || "…",
          description: label,
          run: () => {
            setValue(prefix);
            inputRef.current?.focus();
          },
        }));
    }
    if (mode === "editors") {
      const groupId = workbench.get().activeGroup;
      return editorsByMru(groupId)
        .map((e) => ({ e, t: editorTitle(e) }))
        .filter(({ t }) => fuzzyMatch(query, t.label))
        .map(({ e, t }) => ({
          id: e.id,
          label: t.label,
          description: t.description,
          indices: fuzzyMatch(query, t.label)?.indices,
          icon: e.kind === "file" ? <FileIcon path={e.path} /> : <Codicon name="file" />,
          run: () => {
            closeQuickInput();
            activateEditor(groupId, e.id);
            if (e.kind === "file") setTimeout(() => codeEditorFor(groupId)?.focus(), 0);
          },
        }));
    }
    if (mode === "theme") {
      return themeItems()
        .filter((t) => fuzzyMatch(query, t.label))
        .map((t, i, arr) => ({
          id: t.id,
          label: t.label,
          description: t.description,
          indices: fuzzyMatch(query, t.label)?.indices,
          group: i === 0 || arr[i - 1].group !== t.group ? t.group : undefined,
          icon: t.id === currentTheme ? <Codicon name="check" /> : <span className="tm-qi-icon-spacer" />,
          run: () => {
            setPreviewTheme(null);
            updateSetting("workbench.colorTheme", t.id);
            closeQuickInput();
          },
        }));
    }
    if (mode === "iconTheme") {
      return allIconThemes()
        .filter((t) => fuzzyMatch(query, t.label))
        .map((t, i) => ({
          id: t.id,
          label: t.id === "none" ? "None" : t.label,
          description: t.id === "none" ? "Disable File Icons" : t.extensionName,
          indices: fuzzyMatch(query, t.label)?.indices,
          group: i === 0 ? "file icon themes" : undefined,
          icon: t.id === currentIconTheme ? <Codicon name="check" /> : <span className="tm-qi-icon-spacer" />,
          run: () => {
            setPreviewIconTheme(null);
            updateSetting("workbench.iconTheme", t.id);
            closeQuickInput();
          },
        }));
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, query, files, symbols, wsSymbols, os, currentTheme, currentIconTheme, themesVersion, iconThemesVersion, intelligence, wsProvider]);

  // Line mode: a single synthetic row.
  const lineInfo = useMemo(() => {
    if (mode !== "line") return null;
    const ed = origin.editor;
    const model = ed?.getModel();
    if (!ed || !model) return { text: "Open a text editor first to go to a line.", go: null as null | (() => void) };
    const [l, c] = query.split(/[,:]/).map((n) => parseInt(n, 10));
    const pos = ed.getPosition();
    if (!query || Number.isNaN(l)) {
      return { text: `Current Line: ${pos?.lineNumber ?? 1}, Character: ${pos?.column ?? 1}. Type a line number between 1 and ${model.getLineCount()} to navigate to.`, go: null };
    }
    const line = Math.max(1, Math.min(model.getLineCount(), l));
    const column = Number.isNaN(c) ? 1 : Math.max(1, c);
    return {
      text: Number.isNaN(c) ? `Go to line ${line}.` : `Go to line ${line} and character ${column}.`,
      go: () => {
        closeQuickInput();
        revealIn(ed, line, column);
      },
    };
  }, [mode, query, origin.editor]);

  // The editor switcher starts on the previous editor (or, with Shift, the least recent).
  const [index, setIndex] = useState(() => {
    if (!editorsMode || initial === "list") return 0;
    const n = editorsByMru(workbench.get().activeGroup).length;
    return initial === "last" ? Math.max(0, n - 1) : Math.max(0, Math.min(1, n - 1));
  });
  // Back to the top when the query changes (not on mount: React may run effects twice).
  const lastKey = useRef(`${mode}|${query}`);
  useEffect(() => {
    const key = `${mode}|${query}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    setIndex(0);
  }, [mode, query]);

  // Ctrl+Tab tapped and released before this opened: switch at once, as VS Code does.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const indexRef = useRef(index);
  indexRef.current = index;
  useEffect(() => {
    if (mode !== "editors" || initial === "list") return;
    const accept = () => {
      const it = itemsRef.current[indexRef.current];
      if (it) it.run();
      else closeQuickInput();
    };
    if (!ctrlHeld) {
      const t = setTimeout(accept, 0);
      return () => clearTimeout(t);
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Control") accept();
    };
    window.addEventListener("keyup", onUp, true);
    return () => window.removeEventListener("keyup", onUp, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Live theme preview while moving through the list.
  useEffect(() => {
    if (mode === "theme" && items[index]) setPreviewTheme(items[index].id);
    if (mode === "iconTheme" && items[index]) setPreviewIconTheme(items[index].id);
  }, [mode, index, items]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const accept = () => {
    if (mode === "line") return lineInfo?.go?.();
    items[index]?.run();
  };

  const placeholder =
    mode === "theme"
      ? "Select Color Theme (Up/Down Keys to Preview)"
      : mode === "iconTheme"
        ? "Select File Icon Theme (Up/Down Keys to Preview)"
        : mode === "editors"
          ? "Select an editor to open"
          : mode === "files"
            ? hasWorkspace
              ? "Search files by name (add :line to go to a line, or type ? for help)"
              : "Open a folder to search its files, or type > for commands"
            : mode === "symbols"
              ? "Type the name of a symbol to go to"
              : "";

  const loading =
    (mode === "files" && files === null && hasWorkspace) || (mode === "symbols" && symbols === null) || (mode === "workspaceSymbols" && wsSymbols === null);
  const emptyText =
    mode === "commands"
      ? "No matching commands"
      : mode === "symbols"
        ? origin.editor?.getModel()
          ? (symbols?.length ?? 0) === 0
            ? "No symbols in this file"
            : "No matching symbols"
          : "Open a text editor first to go to a symbol."
        : mode === "workspaceSymbols"
          ? "No matching workspace symbols"
          : "No matching results";

  return (
    <div className="tm-quick-input-backdrop" onMouseDown={() => closeQuickInput()}>
      <div className="tm-quick-input" role="dialog" aria-label="Quick Input" data-mode={mode} onMouseDown={(e) => e.stopPropagation()}>
        <div className="tm-qi-input-row">
          <input
            ref={inputRef}
            className="tm-input"
            value={value}
            placeholder={placeholder}
            aria-label={placeholder || "Type the name of a command to run."}
            aria-activedescendant={items[index] ? `qi-${index}` : undefined}
            aria-controls="tm-qi-list"
            role="combobox"
            aria-expanded
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              const n = items.length;
              if (e.key === "Tab" && e.ctrlKey && mode === "editors") setIndex((i) => (n ? (i + (e.shiftKey ? -1 : 1) + n) % n : 0));
              else if (e.key === "ArrowDown") setIndex((i) => (n ? (i + 1) % n : 0));
              else if (e.key === "ArrowUp") setIndex((i) => (n ? (i - 1 + n) % n : 0));
              else if (e.key === "PageDown") setIndex((i) => Math.min(n - 1, i + 10));
              else if (e.key === "PageUp") setIndex((i) => Math.max(0, i - 10));
              else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && items[index]?.runToSide) items[index].runToSide!();
              else if (e.key === "Enter") accept();
              else if (e.key === "Escape") closeAndRun(() => {});
              else return;
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        </div>
        {mode === "line" ? (
          <div className="tm-qi-message">{lineInfo?.text}</div>
        ) : (
          <div ref={listRef} id="tm-qi-list" className="tm-qi-list tm-scroll" role="listbox">
            {items.length === 0 && loading && <SkeletonRows rows={6} label="Loading" />}
            {items.length === 0 && !loading && <div className="tm-qi-message">{emptyText}</div>}
            {items.map((it, i) => (
              <div
                key={it.id}
                id={`qi-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === index}
                className={`tm-qi-item ${i === index ? "is-focused" : ""} ${it.group && i > 0 ? "has-separator" : ""}`}
                onMouseMove={(e) => {
                  // Browsers fire mousemove when the list appears under a still pointer: only a real move picks.
                  const last = pointer.current;
                  pointer.current = { x: e.clientX, y: e.clientY };
                  if (!last || (last.x === e.clientX && last.y === e.clientY)) return;
                  if (i !== index) setIndex(i);
                }}
                onClick={() => it.run()}
              >
                {it.icon}
                <span className="tm-qi-label">
                  <Highlighted text={it.label} indices={it.indices} />
                </span>
                {it.description && (
                  <span className="tm-qi-desc">
                    <Highlighted text={it.description} indices={it.descIndices} />
                  </span>
                )}
                {it.detail && <span className="tm-qi-desc tm-qi-detail">{it.detail}</span>}
                <span className="tm-qi-right">
                  {it.group && <span className="tm-qi-group">{it.group}</span>}
                  {it.keybinding &&
                    it.keybinding.split(" ").map((k, ki) => (
                      <kbd key={ki} className="tm-kbd">
                        {k}
                      </kbd>
                    ))}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
