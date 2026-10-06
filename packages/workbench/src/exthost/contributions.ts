import { registerCommand } from "../commands/registry";
import type { OsKind } from "../platform/types";
import type { monaco } from "../monaco/setup";
import { pathOfUri } from "../monaco/documents";
import { onCodeEditor } from "../monaco/editors";
import { getPlatform } from "../state/store";
import type { InstalledExtension } from "../extensions/service";
import type { CommandContribution, KeybindingContribution, MenuItemContribution } from "../extensions/manifest";
import { when } from "./context";

/**
 * The code-related contribution points of running extensions:
 * `contributes.commands` (Command Palette), `contributes.keybindings`, and
 * `contributes.menus` for `commandPalette` (when), `editor/context` (Monaco's
 * context menu) and `editor/title` (buttons in the editor title, see
 * ExtensionTitleActions). Running a command activates its extension
 * (onCommand) through the host.
 */

export type CommandRunner = (id: string, args?: unknown[]) => void;

export interface ContributedCommand extends CommandContribution {
  extensionId: string;
}

let disposers: (() => void)[] = [];
let contextItems: { cmd: ContributedCommand; item: MenuItemContribution; key: string }[] = [];
let titleItems: { cmd: ContributedCommand; item: MenuItemContribution }[] = [];
const commandIndex = new Map<string, ContributedCommand>();
let runner: CommandRunner = () => {};
let editorHook = false;
const editorActions = new WeakMap<monaco.editor.IStandaloneCodeEditor, monaco.IDisposable[]>();
const liveEditors = new Set<monaco.editor.IStandaloneCodeEditor>();
const titleListeners = new Set<() => void>();

/** "ctrl+shift+alt+f" / "cmd+k cmd+f" (VS Code) → TMCode's "mod+shift+alt+f" for this OS, or null. */
export function toKeybinding(kb: KeybindingContribution, os: OsKind): string | null {
  const raw = (os === "mac" ? kb.mac : os === "windows" ? kb.win : kb.linux) ?? kb.key;
  if (!raw) return null;
  const out: string[] = [];
  for (const chord of raw.toLowerCase().trim().split(/\s+/)) {
    const parts = chord.split("+").filter(Boolean);
    const key = parts.pop();
    if (!key) return null;
    const mods = new Set<string>();
    for (const p of parts) {
      if (p === "cmd" || p === "meta" || p === "win") {
        if (os !== "mac") return null; // a Cmd binding has no Windows/Linux equivalent
        mods.add("mod");
      } else if (p === "ctrl") mods.add(os === "mac" ? "ctrl" : "mod");
      else if (p === "alt" || p === "shift") mods.add(p);
      else return null;
    }
    out.push([...["ctrl", "mod", "alt", "shift"].filter((m) => mods.has(m)), key].join("+"));
  }
  return out.join(" ");
}

/** "navigation@3" → group + order. */
export function groupOf(item: MenuItemContribution): { group: string; order: number } {
  const [group, order] = (item.group ?? "navigation").split("@");
  return { group: group || "navigation", order: Number(order) || 0 };
}

function attachEditor(ed: monaco.editor.IStandaloneCodeEditor) {
  liveEditors.add(ed);
  editorActions.get(ed)?.forEach((d) => d.dispose());
  const disposables: monaco.IDisposable[] = [];
  const keys = new Map<string, monaco.editor.IContextKey<boolean>>();
  for (const { cmd, item, key } of contextItems) {
    keys.set(key, ed.createContextKey<boolean>(key, false));
    const { group, order } = groupOf(item);
    disposables.push(
      ed.addAction({
        id: `${cmd.command}@${key}`,
        label: cmd.title,
        contextMenuGroupId: group === "navigation" ? "navigation" : `z_ext_${group}`,
        contextMenuOrder: order,
        precondition: key,
        run: (editor) => {
          const model = editor.getModel();
          runner(cmd.command, model?.uri.scheme === "tmcode" ? [{ $path: pathOfUri(model.uri) }] : []);
        },
      }),
    );
  }
  // Menu items show while their when clause holds (Monaco hides an action whose precondition is false).
  const refresh = () => {
    for (const { item, key } of contextItems) keys.get(key)?.set(when(item.when));
  };
  refresh();
  disposables.push(
    ed.onMouseDown((e) => e.event.rightButton && refresh()),
    ed.onDidChangeModel(refresh),
    ed.onDidFocusEditorText(refresh),
    ed.onDidChangeCursorSelection(refresh),
  );
  editorActions.set(ed, disposables);
  ed.onDidDispose(() => liveEditors.delete(ed));
}

export function applyCodeContributions(exts: InstalledExtension[], run: CommandRunner) {
  runner = run;
  disposers.forEach((d) => d());
  disposers = [];
  commandIndex.clear();
  const os = getPlatform().os;
  const paletteWhen = new Map<string, string | undefined>();
  contextItems = [];
  titleItems = [];
  let seq = 0;
  for (const ext of exts) for (const c of ext.manifest.commands) commandIndex.set(c.command, { ...c, extensionId: ext.id });
  for (const ext of exts) {
    const m = ext.manifest;
    for (const item of m.menus.commandPalette ?? []) paletteWhen.set(item.command, item.when);
    for (const item of m.menus["editor/context"] ?? []) {
      const cmd = commandIndex.get(item.command) ?? { command: item.command, title: item.command, extensionId: ext.id };
      contextItems.push({ cmd, item, key: `tmcodeExtMenu${++seq}` });
    }
    for (const item of m.menus["editor/title"] ?? []) {
      const cmd = commandIndex.get(item.command);
      if (cmd) titleItems.push({ cmd, item });
    }
    m.keybindings.forEach((kb, i) => {
      const key = toKeybinding(kb, os);
      if (!key) return;
      // One hidden command per binding, so its when clause applies to the key only (not the palette).
      disposers.push(
        registerCommand({
          id: `${kb.command}#kb${i}:${ext.id}`,
          title: commandIndex.get(kb.command)?.title ?? kb.command,
          hidden: true,
          keybinding: key,
          enabled: () => when(kb.when),
          run: () => runner(kb.command, kb.args === undefined ? [] : [kb.args]),
        }),
      );
    });
  }
  for (const cmd of commandIndex.values()) {
    const w = paletteWhen.get(cmd.command);
    disposers.push(
      registerCommand({
        id: cmd.command,
        title: cmd.title,
        category: cmd.category,
        get hidden() {
          return w !== undefined && !when(w);
        },
        enabled: () => !cmd.enablement || when(cmd.enablement),
        run: () => runner(cmd.command, []),
      }),
    );
  }
  if (!editorHook) {
    editorHook = true;
    onCodeEditor((ed) => attachEditor(ed));
  } else {
    for (const ed of liveEditors) attachEditor(ed);
  }
  titleListeners.forEach((l) => l());
}

export function contributedCommand(id: string): ContributedCommand | undefined {
  return commandIndex.get(id);
}

export function onTitleItemsChanged(l: () => void) {
  titleListeners.add(l);
  return () => {
    titleListeners.delete(l);
  };
}

/** editor/title items whose when clause holds now. */
export function editorTitleItems(): { cmd: ContributedCommand; item: MenuItemContribution; navigation: boolean }[] {
  return titleItems.filter(({ item }) => when(item.when)).map((x) => ({ ...x, navigation: groupOf(x.item).group === "navigation" }));
}

export function runContributedCommand(id: string, args?: unknown[]) {
  runner(id, args);
}
