import { create } from "zustand";
import { recordActivity } from "../activity/log";
import { aiExtensionName, isAiExtension } from "../activity/aiExtensions";
import { aiGate, thirdPartyMessage } from "../ai/gate";
import { useAi } from "../ai/service";
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

/**
 * Third-party AI extensions (Claude Code, Copilot, Codex…) are off (AI usage control): Task
 * Mentor's status says so (`thirdPartyExtensions`), or it is unknown in an assignment's project,
 * or an exam. They bypass Task Mentor, so this is client side and best-effort; the activity log
 * records attempts. Other extensions keep working.
 */
export function aiExtensionsBlocked(): boolean {
  return extensionsBlocked() || !aiGate().thirdParty;
}

/** Why AI extensions are off now (null: they may run). */
export function aiExtensionsBlockedReason(): string | null {
  if (!aiExtensionsBlocked()) return null;
  return thirdPartyMessage(aiGate()) ?? "Extensions are disabled during exams.";
}

/** This extension is an AI tool and AI tools are off. */
export function aiExtensionBlocked(id: string, manifest?: Parameters<typeof isAiExtension>[1]): boolean {
  return isAiExtension(id, manifest) && aiExtensionsBlocked();
}

/** Refuses (with the reason, and an activity log entry) an AI extension while AI tools are off. */
export function refuseAiExtension(id: string, manifest: Parameters<typeof isAiExtension>[1], attempt: string): boolean {
  if (!aiExtensionBlocked(id, manifest)) return false;
  const name = aiExtensionName(id, manifest);
  const why = aiExtensionsBlockedReason() ?? "AI tools are turned off.";
  notify("warning", `${name} can't be used now. ${why}`);
  recordActivity({ kind: "extension", action: "blocked", text: `Tried to ${attempt} ${name}: AI tools are off`, data: { id, ai: true, attempt }, ai: { by: name, how: "blocked" } });
  return true;
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

/** How far a long install is (AI extensions download 100 MB and more). */
export const useInstallProgress = create<Record<string, { received: number; total: number | null; phase: "download" | "unpack" }>>(() => ({}));

export async function installExtension(ext: Pick<GalleryExtension, "id" | "displayName" | "downloadUrl" | "version" | "downloads">): Promise<boolean> {
  const host = extensionHost();
  if (!host) return false;
  if (extensionsBlocked()) {
    notify("warning", "Extensions are disabled during exams.");
    return false;
  }
  if (refuseAiExtension(ext.id, { displayName: ext.displayName, description: (ext as { description?: string }).description, categories: (ext as { categories?: string[] }).categories }, "install")) return false;
  if (!ext.downloadUrl) {
    notify("error", `${ext.displayName} has no download on Open VSX.`);
    return false;
  }
  setBusy(ext.id, "installing");
  try {
    return await finishInstall(await host.install(ext.id, ext.downloadUrl, ext.downloads, (p) => useInstallProgress.setState({ [ext.id]: p })));
  } catch (e) {
    notify("error", `Unable to install extension '${ext.displayName}': ${String((e as Error)?.message ?? e)}`);
    return false;
  } finally {
    setBusy(ext.id, null);
    useInstallProgress.setState((s) => {
      const next = { ...s };
      delete next[ext.id];
      return next;
    }, true);
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
    recordActivity({ kind: "extension", action: "install", text: `Installed the extension ${item.manifest.displayName || item.id}${isAiExtension(item.id, item.manifest) ? " (an AI tool)" : ""}`, data: { id: item.id, version: item.version, ai: isAiExtension(item.id, item.manifest) } });
    announce(item);
    if (aiExtensionBlocked(item.id, item.manifest)) notify("warning", `${aiExtensionName(item.id, item.manifest)} is installed but won't run now. ${aiExtensionsBlockedReason() ?? ""}`);
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
    recordActivity({ kind: "extension", action: "uninstall", text: `Uninstalled the extension ${id}`, data: { id } });
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
  const noAi = aiExtensionsBlocked();
  return useExtensions.getState().installed.filter((e) => e.enabled && !(noAi && isAiExtension(e.id, e.manifest)));
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

// AI extensions switch off and on with Task Mentor's AI status (school switch, project change).
let wasAiBlocked = false;
useAi.subscribe(() => {
  const blocked = aiExtensionsBlocked();
  if (blocked === wasAiBlocked) return;
  wasAiBlocked = blocked;
  const ai = useExtensions.getState().installed.filter((e) => e.enabled && isAiExtension(e.id, e.manifest));
  if (!ai.length) return;
  if (blocked && !extensionsBlocked()) {
    log("Extensions", `AI extensions are off: ${aiExtensionsBlockedReason() ?? ""}`);
    recordActivity({ kind: "extension", action: "blocked", text: `AI extensions turned off (${ai.map((e) => e.manifest.displayName || e.id).join(", ")})`, data: { ids: ai.map((e) => e.id).join(","), ai: true } });
  }
  // The extension host restarts with (or without) them, as after enabling or disabling one.
  useExtensions.setState({ version: useExtensions.getState().version + 1 });
  applyContributions();
});
useWorkbench.subscribe((s, prev) => {
  if (s.policy !== prev.policy) recheck();
});
