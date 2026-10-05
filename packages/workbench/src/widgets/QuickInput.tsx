import { useEffect, useMemo, useRef, useState } from "react";
import { allCommands, executeCommand, formatKeybinding, isEnabled, keybindingFor } from "../commands/registry";
import { codeEditorFor } from "../monaco/editors";
import { listFiles } from "../parts/search/search";
import type { ThemeId } from "../state/settings";
import {
  activeFilePath,
  closeQuickInput,
  getPlatform,
  openFile,
  setPreviewTheme,
  updateSetting,
  useWorkbench,
  workbench,
  type QuickInputMode,
} from "../state/store";
import { fuzzyMatch, highlightRuns } from "../util/fuzzy";
import { basename, dirname } from "../util/paths";
import { Codicon, FileIcon } from "./icons";

interface Item {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  keybinding?: string;
  icon?: React.ReactNode;
  group?: string;
  indices?: number[];
  run: () => void;
}

const recentCommands: string[] = [];
const recentFiles: string[] = [];

const THEMES: { id: ThemeId; label: string; group: string }[] = [
  { id: "light-modern", label: "Light Modern", group: "light themes" },
  { id: "dark-modern", label: "Dark Modern", group: "dark themes" },
  { id: "dark-hc", label: "Dark High Contrast", group: "high contrast themes" },
];

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

/** Switches modes the way VS Code does when the user types a prefix. */
function modeFromValue(value: string, base: QuickInputMode): { mode: QuickInputMode; query: string } {
  if (base === "theme") return { mode: "theme", query: value };
  if (value.startsWith(">")) return { mode: "commands", query: value.slice(1).trim() };
  if (value.startsWith(":")) return { mode: "line", query: value.slice(1).trim() };
  return { mode: "files", query: value.trim() };
}

export function QuickInput() {
  const qi = useWorkbench((s) => s.quickInput);
  if (!qi) return null;
  return <QuickInputWidget key={`${qi.mode}:${qi.initial ?? ""}`} baseMode={qi.mode} initial={qi.initial} />;
}

function QuickInputWidget({ baseMode, initial }: { baseMode: QuickInputMode; initial?: string }) {
  const os = getPlatform().os;
  const startValue = initial ?? (baseMode === "commands" ? ">" : baseMode === "line" ? ":" : "");
  const [value, setValue] = useState(startValue);
  const [files, setFiles] = useState<string[] | null>(null);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const currentTheme = useWorkbench((s) => s.settings["workbench.colorTheme"]);
  const hasWorkspace = useWorkbench((s) => !!s.workspace);
  const { mode, query } = modeFromValue(value, baseMode);

  useEffect(() => {
    inputRef.current?.focus();
    const el = inputRef.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    if (mode === "files" && files === null && hasWorkspace) void listFiles(getPlatform().fs).then(setFiles);
  }, [mode, files, hasWorkspace]);

  const items: Item[] = useMemo(() => {
    if (mode === "commands") {
      const cmds = allCommands().filter((c) => !c.hidden && isEnabled(c));
      const scored = cmds
        .map((c) => {
          const label = c.category ? `${c.category}: ${c.title}` : c.title;
          const m = fuzzyMatch(query, label);
          return m ? { c, label, m } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      if (query) scored.sort((a, b) => b.m.score - a.m.score);
      else scored.sort((a, b) => a.label.localeCompare(b.label));
      const recent = query ? [] : recentCommands.map((id) => scored.find((s) => s.c.id === id)).filter((x): x is NonNullable<typeof x> => !!x);
      const rest = scored.filter((s) => !recent.includes(s));
      const toItem = (s: (typeof scored)[number], group?: string): Item => ({
        id: s.c.id,
        label: s.label,
        keybinding: formatKeybinding(keybindingFor(s.c, os), os),
        indices: s.m.indices,
        group,
        run: () => {
          const at = recentCommands.indexOf(s.c.id);
          if (at >= 0) recentCommands.splice(at, 1);
          recentCommands.unshift(s.c.id);
          recentCommands.length = Math.min(recentCommands.length, 5);
          closeQuickInput();
          executeCommand(s.c.id);
        },
      });
      return [...recent.map((s, i) => toItem(s, i === 0 ? "recently used" : undefined)), ...rest.map((s, i) => toItem(s, i === 0 && recent.length ? "other commands" : undefined))];
    }
    if (mode === "files") {
      const all = files ?? [];
      const scored = all
        .map((p) => {
          const m = fuzzyMatch(query, basename(p)) ?? (query.includes("/") ? fuzzyMatch(query, p) : null);
          return m ? { p, m } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      if (query) scored.sort((a, b) => b.m.score - a.m.score || a.p.length - b.p.length);
      const recent = query ? [] : recentFiles.filter((p) => all.includes(p));
      const ordered = [...recent.map((p) => ({ p, m: { score: 0, indices: [] as number[] } })), ...scored.filter((s) => !recent.includes(s.p))];
      return ordered.slice(0, 200).map((s, i) => ({
        id: s.p,
        label: basename(s.p),
        description: dirname(s.p),
        icon: <FileIcon path={s.p} />,
        indices: query.includes("/") ? [] : s.m.indices,
        group: !query && recent.length ? (i === 0 ? "recently opened" : i === recent.length ? "files" : undefined) : undefined,
        run: () => {
          recentFiles.splice(0, recentFiles.length, s.p, ...recentFiles.filter((x) => x !== s.p).slice(0, 9));
          closeQuickInput();
          openFile(s.p, { pinned: true });
        },
      }));
    }
    if (mode === "theme") {
      return THEMES.filter((t) => fuzzyMatch(query, t.label)).map((t, i, arr) => ({
        id: t.id,
        label: t.label,
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
    return [];
  }, [mode, query, files, os, currentTheme]);

  // Line mode: a single synthetic row.
  const lineInfo = useMemo(() => {
    if (mode !== "line") return null;
    const ed = codeEditorFor(workbench.get().activeGroup);
    const model = ed?.getModel();
    if (!ed || !model || !activeFilePath()) return { text: "Open a text editor first to go to a line.", go: null as null | (() => void) };
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
        ed.setPosition({ lineNumber: line, column });
        ed.revealLineInCenter(line);
        ed.focus();
      },
    };
  }, [mode, query]);

  useEffect(() => setIndex(0), [mode, query]);

  // Live theme preview while moving through the list.
  useEffect(() => {
    if (mode === "theme" && items[index]) setPreviewTheme(items[index].id as ThemeId);
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
      : mode === "files"
        ? hasWorkspace
          ? "Search files by name (append : to go to line, or start with > for commands)"
          : "Open a folder to search its files, or type > for commands"
        : "";

  return (
    <div className="tm-quick-input-backdrop" onMouseDown={() => closeQuickInput()}>
      <div className="tm-quick-input" role="dialog" aria-label="Quick Input" onMouseDown={(e) => e.stopPropagation()}>
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
              if (e.key === "ArrowDown") setIndex((i) => (n ? (i + 1) % n : 0));
              else if (e.key === "ArrowUp") setIndex((i) => (n ? (i - 1 + n) % n : 0));
              else if (e.key === "PageDown") setIndex((i) => Math.min(n - 1, i + 10));
              else if (e.key === "PageUp") setIndex((i) => Math.max(0, i - 10));
              else if (e.key === "Enter") accept();
              else if (e.key === "Escape") closeQuickInput();
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
            {items.length === 0 && (
              <div className="tm-qi-message">{mode === "commands" ? "No matching commands" : mode === "files" && files === null && hasWorkspace ? "Loading files…" : "No matching results"}</div>
            )}
            {items.map((it, i) => (
              <div
                key={it.id}
                id={`qi-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === index}
                className={`tm-qi-item ${i === index ? "is-focused" : ""} ${it.group && i > 0 ? "has-separator" : ""}`}
                onMouseMove={() => i !== index && setIndex(i)}
                onClick={() => it.run()}
              >
                {it.icon}
                <span className="tm-qi-label">
                  <Highlighted text={it.label} indices={it.indices} />
                </span>
                {it.description && <span className="tm-qi-desc">{it.description}</span>}
                <span className="tm-qi-right">
                  {it.group && <span className="tm-qi-group">{it.group}</span>}
                  {it.keybinding &&
                    it.keybinding.split(" ").map((k) => (
                      <kbd key={k} className="tm-kbd">
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
