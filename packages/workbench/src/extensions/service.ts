import { create } from "zustand";
import { getPlatform, log, notify, openQuickInput, showDialog, useWorkbench } from "../state/store";
import { useExam } from "../exam/state";
import type { ExtensionHost, StoredExtension } from "../platform/types";
import { setExtensionThemes, type ThemeEntry } from "../themes/themeService";
import { setExtensionIconThemes, type IconThemeEntry } from "../themes/iconThemes";
import { loadThemeFile, uiThemeOf, type ThemeReader } from "../textmate/themeData";
import { setExtensionGrammars, type GrammarDef } from "../textmate/grammars";
import { parseJsonc } from "../textmate/jsonc";
import { contributionSummary, parseManifest, type ExtensionManifest } from "./manifest";
import type { GalleryExtension } from "./gallery";

/**
 * Installed extensions and what they contribute. Declarative parts (colour
 * themes, file icon themes, TextMate grammars, languages, snippets) are
 * applied here; extensions with code run in the extension host (exthost/*).
 * Nothing is applied or run during an exam (or any non-practice policy):
 * exams are locked down, so extensions vanish until the exam ends.
 */

export interface InstalledExtension {
  id: string;
  version: string;
  manifest: ExtensionManifest;
  enabled: boolean;
}

interface ExtensionsState {
  loaded: boolean;
  installed: InstalledExtension[];
  /** Operations in flight, by extension id. */
  busy: Record<string, "installing" | "uninstalling">;
  /** Bumps whenever installed/enabled changes. */
  version: number;
}

export const useExtensions = create<ExtensionsState>()(() => ({ loaded: false, installed: [], busy: {}, version: 0 }));

const DISABLED_KEY = "extensions.disabled";

export function extensionHost(): ExtensionHost | undefined {
  try {
    return getPlatform().extensions;
  } catch {
    return undefined;
  }
}

/** Exams (and any locked-down policy) run without extensions. */
export function extensionsBlocked(): boolean {
  const p = useExam.getState().phase;
  return p === "active" || p === "locked" || p === "submitting" || useWorkbench.getState().policy.mode !== "practice";
}

function toInstalled(s: StoredExtension, disabled: Set<string>): InstalledExtension | null {
  try {
    const nls = s.nls ? parseJsonc<Record<string, string>>(s.nls) : undefined;
    const manifest = parseManifest(s.manifest, nls);
    return { id: manifest.id, version: manifest.version, manifest, enabled: !disabled.has(manifest.id) };
  } catch (e) {
    log("Extensions", `${s.id}: unreadable package.json (${String((e as Error)?.message ?? e)})`, "warn");
    return null;
  }
}

async function disabledSet(): Promise<Set<string>> {
  return new Set((await getPlatform().store.get<string[]>(DISABLED_KEY).catch(() => undefined)) ?? []);
}

function setInstalled(installed: InstalledExtension[]) {
  installed.sort((a, b) => a.manifest.displayName.localeCompare(b.manifest.displayName));
  useExtensions.setState({ installed, loaded: true, version: useExtensions.getState().version + 1 });
  applyContributions();
}

/** Reads the installed extensions (startup). Never throws: a broken store just means no extensions. */
export async function loadInstalledExtensions() {
  const host = extensionHost();
  if (!host) {
    useExtensions.setState({ loaded: true });
    return;
  }
  try {
    const [stored, disabled] = await Promise.all([host.list(), disabledSet()]);
    setInstalled(stored.map((s) => toInstalled(s, disabled)).filter((x): x is InstalledExtension => !!x));
  } catch (e) {
    log("Extensions", `Could not list installed extensions: ${String((e as Error)?.message ?? e)}`, "error");
    useExtensions.setState({ loaded: true });
  }
}

function setBusy(id: string, op: "installing" | "uninstalling" | null) {
  const busy = { ...useExtensions.getState().busy };
  if (op) busy[id] = op;
  else delete busy[id];
  useExtensions.setState({ busy });
}

export function installedExtension(id: string): InstalledExtension | undefined {
  return useExtensions.getState().installed.find((e) => e.id === id.toLowerCase());
}

export async function installExtension(ext: Pick<GalleryExtension, "id" | "displayName" | "downloadUrl" | "version">): Promise<boolean> {
  const host = extensionHost();
  if (!host) return false;
  if (extensionsBlocked()) {
    notify("warning", "Extensions are disabled during exams.");
    return false;
  }
  if (!ext.downloadUrl) {
    notify("error", `${ext.displayName} has no download on Open VSX.`);
    return false;
  }
  setBusy(ext.id, "installing");
  try {
    return await finishInstall(await host.install(ext.id, ext.downloadUrl));
  } catch (e) {
    notify("error", `Unable to install extension '${ext.displayName}': ${String((e as Error)?.message ?? e)}`);
    return false;
  } finally {
    setBusy(ext.id, null);
  }
}

/** "Install from VSIX…" (desktop): a package from disk, e.g. one not on Open VSX or built locally. */
export async function installFromVsix(): Promise<boolean> {
  const host = extensionHost();
  if (!host?.installVsix) {
    notify("info", "Installing from a .vsix file is available in the TMCode desktop app.");
    return false;
  }
  if (extensionsBlocked()) {
    notify("warning", "Extensions are disabled during exams.");
    return false;
  }
  try {
    const stored = await host.installVsix();
    if (!stored) return false;
    const ok = await finishInstall(stored);
    if (ok) notify("info", `Installed ${stored.id} v${stored.version} from the .vsix file.`);
    return ok;
  } catch (e) {
    notify("error", `Unable to install the .vsix: ${String((e as Error)?.message ?? e)}`);
    return false;
  }
}

async function finishInstall(stored: StoredExtension): Promise<boolean> {
  {
    let item = toInstalled(stored, await disabledSet());
    if (!item) throw new Error("its package.json could not be read");
    if (item.manifest.hasCode && !(await acceptCodeExtension(item))) {
      await setExtensionEnabled(item.id, false, false);
      item = { ...item, enabled: false };
    }
    setInstalled([...useExtensions.getState().installed.filter((e) => e.id !== item.id), item]);
    log("Extensions", `Installed ${item.id} v${item.version}${item.manifest.hasCode ? (item.enabled ? " (it runs code)" : " (disabled: its code was not trusted)") : ""}`);
    announce(item);
    return true;
  }
}

/** After an install, offer what VS Code offers: pick one of the new themes. */
function announce(item: InstalledExtension) {
  const m = item.manifest;
  if (m.themes.length) {
    notify("info", `${m.displayName} contributes ${m.themes.length === 1 ? "a color theme" : `${m.themes.length} color themes`}.`, [{ label: "Set Color Theme", run: () => openQuickInput("theme") }]);
  } else if (m.iconThemes.length) {
    notify("info", `${m.displayName} contributes a file icon theme.`, [{ label: "Set File Icon Theme", run: () => openQuickInput("iconTheme") }]);
  } else if (!m.hasCode && !contributionSummary(m).length) {
    notify("warning", `${m.displayName} contributes nothing TMCode can use.`);
  }
}

const TRUST_KEY = "extensions.codeTrustAcknowledged";

/**
 * Extension code runs as the user, as in VS Code. The first time an extension
 * with code is installed, TMCode says so once; declining keeps it disabled.
 */
async function acceptCodeExtension(item: InstalledExtension): Promise<boolean> {
  const store = getPlatform().store;
  if (await store.get<boolean>(TRUST_KEY).catch(() => false)) return true;
  const choice = await showDialog({
    message: `${item.manifest.displayName} runs code on your computer.`,
    detail: "Like in VS Code, extensions that contain code run with your permissions: they can read and change your files, use the network and start programs. Only install extensions from publishers you trust. Extensions never run during exams.",
    severity: "warning",
    buttons: [
      { id: "trust", label: "Trust and Enable", primary: true },
      { id: "disable", label: "Keep Disabled" },
    ],
    cancelId: "disable",
  });
  if (choice !== "trust") return false;
  await store.set(TRUST_KEY, true).catch(() => {});
  return true;
}

export async function uninstallExtension(id: string) {
  const host = extensionHost();
  if (!host) return;
  setBusy(id, "uninstalling");
  try {
    await host.uninstall(id);
    setInstalled(useExtensions.getState().installed.filter((e) => e.id !== id));
    log("Extensions", `Uninstalled ${id}`);
  } catch (e) {
    notify("error", `Unable to uninstall '${id}': ${String((e as Error)?.message ?? e)}`);
  } finally {
    setBusy(id, null);
  }
}

export async function setExtensionEnabled(id: string, enabled: boolean, apply = true) {
  const disabled = await disabledSet();
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  await getPlatform().store.set(DISABLED_KEY, [...disabled]);
  if (apply) setInstalled(useExtensions.getState().installed.map((e) => (e.id === id ? { ...e, enabled } : e)));
}

// ───────────── contributions ─────────────

function readerFor(host: ExtensionHost, id: string): ThemeReader {
  return { read: (path) => host.readFile(id, path, "text") };
}

/** .tmTheme (plist) files need vscode-textmate's plist parser, loaded on demand. */
async function themeReader(host: ExtensionHost, id: string, path: string): Promise<ThemeReader> {
  const r = readerFor(host, id);
  if (!/\.(tmTheme|plist|xml)$/i.test(path)) return r;
  const mod = await import("vscode-textmate");
  const vsctm = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof mod;
  return { ...r, parsePlist: (text, p) => vsctm.parseRawGrammar(text, p.replace(/\.\w+$/, ".plist")) };
}

/** Monaco-side contributions (languages, configurations, snippets); registered by monacoContributions.ts. */
export const monacoSink: { apply: (exts: InstalledExtension[], host: ExtensionHost) => void } = { apply: () => {} };

export function activeExtensions(): InstalledExtension[] {
  if (extensionsBlocked()) return [];
  return useExtensions.getState().installed.filter((e) => e.enabled);
}

let lastApplied: InstalledExtension[] | null = null;

/** Pushes the enabled extensions' contributions to themes, icon themes, grammars and Monaco. */
export function applyContributions() {
  const host = extensionHost();
  const exts = host ? activeExtensions() : [];
  if (lastApplied && lastApplied.length === exts.length && lastApplied.every((e, i) => e === exts[i])) return;
  lastApplied = exts;
  const themes: ThemeEntry[] = [];
  const iconThemes: IconThemeEntry[] = [];
  const grammars: GrammarDef[] = [];
  const languageScopes: Record<string, string> = {};
  for (const ext of exts) {
    const m = ext.manifest;
    for (const t of m.themes) {
      const uiTheme = uiThemeOf(t.uiTheme);
      themes.push({
        id: `ext:${ext.id}:${t.id ?? t.label}`,
        label: t.label,
        uiTheme,
        extensionId: ext.id,
        extensionName: m.displayName,
        load: async () => loadThemeFile(t.path, await themeReader(host!, ext.id, t.path), uiTheme),
      });
    }
    for (const t of m.iconThemes) {
      iconThemes.push({ id: `ext:${ext.id}:${t.id}`, label: t.label, extensionId: ext.id, extensionName: m.displayName, path: t.path, read: (p, as) => host!.readFile(ext.id, p, as) });
    }
    for (const g of m.grammars) {
      grammars.push({
        scopeName: g.scopeName,
        load: async () => ({ kind: "text", text: await host!.readFile(ext.id, g.path, "text"), path: g.path }),
        injectTo: g.injectTo,
        embeddedLanguages: g.embeddedLanguages,
        tokenTypes: g.tokenTypes,
        extension: ext.id,
      });
      if (g.language) languageScopes[g.language] = g.scopeName;
    }
  }
  setExtensionThemes(themes);
  setExtensionIconThemes(iconThemes);
  setExtensionGrammars(grammars, languageScopes);
  if (host) monacoSink.apply(exts, host);
}

// Exams switch extensions off and back on.
let wasBlocked = false;
const recheck = () => {
  const blocked = extensionsBlocked();
  if (blocked === wasBlocked) return;
  wasBlocked = blocked;
  if (blocked) log("Extensions", "Extensions are disabled for this exam.");
  applyContributions();
};
useExam.subscribe(recheck);
useWorkbench.subscribe((s, prev) => {
  if (s.policy !== prev.policy) recheck();
});
