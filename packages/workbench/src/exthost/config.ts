import { create } from "zustand";
import { changedKeys, configurationDefaults, configurationProperties, nest, type ConfigurationProperty, type Flat } from "@tmcode/exthost";
import { getPlatform, updateSetting, useWorkbench } from "../state/store";
import { DEFAULT_SETTINGS, type SettingKey } from "../state/settings";
import { activeExtensions } from "../extensions/service";
import { localize } from "../extensions/manifest";

/**
 * Configuration for extensions (`workspace.getConfiguration`). TMCode's own
 * settings already use VS Code's names ("editor.tabSize"), so they are the
 * built-in layer; settings contributed by extensions are stored with the
 * other settings (key "extensions.settings") and edited in the Settings
 * editor's Extensions section.
 */

const STORE_KEY = "extensions.settings";

/** VS Code defaults extensions commonly read, beyond TMCode's settings. */
const VSCODE_DEFAULTS: Flat = {
  "files.eol": "\n",
  "files.encoding": "utf8",
  "files.associations": {},
  "files.exclude": { "**/.git": true, "**/.svn": true, "**/.hg": true, "**/CVS": true, "**/.DS_Store": true, "**/Thumbs.db": true },
  "files.insertFinalNewline": false,
  "files.trimTrailingWhitespace": false,
  "search.exclude": { "**/node_modules": true, "**/bower_components": true, "**/*.code-search": true },
  "editor.defaultFormatter": null,
  "editor.detectIndentation": true,
  "editor.formatOnType": false,
  "editor.formatOnPaste": false,
  "editor.linkedEditing": false,
  "editor.quickSuggestions": { other: "on", comments: "off", strings: "off" },
  "html.autoClosingTags": true,
  "http.proxy": "",
  "http.proxyStrictSSL": true,
  "telemetry.telemetryLevel": "off",
};

export const useExtConfig = create<{ user: Flat; loaded: boolean }>()(() => ({ user: {}, loaded: false }));

type Listener = (change: { user: Flat; defaults: Flat; keys: string[] }) => void;
const listeners = new Set<Listener>();
export function onConfigurationChanged(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function builtinDefaults(): Flat {
  return { ...VSCODE_DEFAULTS, ...(useWorkbench.getState().settings as unknown as Flat) };
}

export async function loadExtensionSettings() {
  try {
    const user = (await getPlatform().store.get<Flat>(STORE_KEY)) ?? {};
    useExtConfig.setState({ user: user && typeof user === "object" ? user : {}, loaded: true });
  } catch {
    useExtConfig.setState({ loaded: true });
  }
}

export interface ExtensionConfigSection {
  extensionId: string;
  title: string;
  properties: ConfigurationProperty[];
}

/** Every running extension's configuration properties, for the Settings editor. */
export function extensionConfigSections(): ExtensionConfigSection[] {
  const out: ExtensionConfigSection[] = [];
  for (const ext of activeExtensions()) {
    if (!ext.manifest.hasCode) continue;
    const props = configurationProperties(ext.manifest.raw.contributes, ext.manifest.displayName, (s) => localize(s, ext.manifest.nls));
    if (props.length) out.push({ extensionId: ext.id, title: ext.manifest.displayName, properties: props.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.key.localeCompare(b.key)) });
  }
  return out;
}

function extensionDefaults(): Flat {
  const out: Flat = {};
  for (const ext of activeExtensions()) {
    for (const p of configurationProperties(ext.manifest.raw.contributes, ext.manifest.displayName)) out[p.key] = p.default;
    Object.assign(out, configurationDefaults(ext.manifest.raw.contributes));
  }
  return out;
}

/** The effective value of a dotted key (user over TMCode's over extension defaults). */
export function configValue(key: string): unknown {
  const user = useExtConfig.getState().user;
  if (key in user) return user[key];
  const builtin = builtinDefaults();
  if (key in builtin) return builtin[key];
  const ext = extensionDefaults();
  if (key in ext) return ext[key];
  let node: unknown = nest({ ...ext, ...builtin, ...user });
  for (const p of key.split(".")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[p] : undefined;
  return node;
}

/** Was this key changed by the user (not a default)? */
export function isModified(key: string): boolean {
  return key in useExtConfig.getState().user;
}

/**
 * Changes a setting for an extension (`WorkspaceConfiguration.update`, the
 * Settings editor). TMCode's own settings go through updateSetting; `null`
 * removes a user override. `language` stores it under "[language]".
 */
export async function updateExtensionSetting(key: string, value: unknown, language?: string | null) {
  if (!language && key in DEFAULT_SETTINGS) {
    updateSetting(key as SettingKey, (value === null || value === undefined ? DEFAULT_SETTINGS[key as SettingKey] : value) as never);
    return;
  }
  const before = useExtConfig.getState().user;
  const user: Flat = { ...before };
  if (language) {
    const block = { ...((user[`[${language}]`] as Flat | undefined) ?? {}) };
    if (value === null || value === undefined) delete block[key];
    else block[key] = value;
    if (Object.keys(block).length) user[`[${language}]`] = block;
    else delete user[`[${language}]`];
  } else if (value === null || value === undefined) delete user[key];
  else user[key] = value;
  useExtConfig.setState({ user });
  await getPlatform().store.set(STORE_KEY, user).catch(() => {});
  const keys = changedKeys(before, user).map((k) => (k.startsWith("[") ? key : k));
  listeners.forEach((l) => l({ user, defaults: builtinDefaults(), keys }));
}

// TMCode's own settings changed: the built-in layer changed for extensions too.
useWorkbench.subscribe((s, prev) => {
  if (s.settings === prev.settings) return;
  const keys = changedKeys(prev.settings as unknown as Flat, s.settings as unknown as Flat);
  if (keys.length) listeners.forEach((l) => l({ user: useExtConfig.getState().user, defaults: builtinDefaults(), keys }));
});
