import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { unsupportedEvents, type ConfigurationProperty } from "@tmcode/exthost";
import { ActionButton, Codicon } from "../widgets/icons";
import { useWorkbench } from "../state/store";
import { useExtensions, type InstalledExtension } from "../extensions/service";
import type { ExtensionManifest } from "../extensions/manifest";
import { runCachedCommand } from "./languageBridge";
import { hostFor, restartExtensionHosts } from "./hostService";
import { configValue, extensionConfigSections, isModified, updateExtensionSetting, useExtConfig } from "./config";
import { editorTitleItems, onTitleItemsChanged, runContributedCommand } from "./contributions";
import { useContextVersion, useExtHost, useExtStatusBar, type RuntimeInfo } from "./state";
import { useOutputChannel } from "./output";

/**
 * The extension host in the workbench UI: runtime state in the Extensions
 * view and details editor, extension status bar items, editor title buttons,
 * the Output channel picker and the Extensions section of the Settings editor.
 */

/** "$(sync~spin) Text" → codicons and text, as VS Code renders labels. */
export function LabelWithIcons({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /\$\(([\w-]+)(~spin)?\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<span key={i++}>{text.slice(last, m.index)}</span>);
    parts.push(<Codicon key={i++} name={m[1] === "loading" ? "loading" : m[1]} className={m[2] || m[1] === "loading" ? "codicon-modifier-spin" : ""} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={i++}>{text.slice(last)}</span>);
  return <>{parts}</>;
}

function stateLabel(r: RuntimeInfo | undefined): { label: string; icon: string; cls: string } | null {
  if (!r?.state) return null;
  if (r.state === "activating") return { label: "Activating…", icon: "loading", cls: "is-activating" };
  if (r.state === "failed") return { label: "Failed", icon: "error", cls: "is-failed" };
  return { label: `Activated${r.activationTime !== undefined ? ` · ${r.activationTime}ms` : ""}`, icon: "pass", cls: "is-activated" };
}

/** A row's runtime badge in the Extensions view (or why its code cannot run). */
export function RuntimeBadge({ ext }: { ext: InstalledExtension }) {
  const r = useExtHost((s) => s.runtime[ext.id]);
  const failedToStart = useExtHost((s) => s.cannotRun[ext.id]);
  if (!ext.manifest.hasCode || !ext.enabled) return null;
  const h = hostFor(ext.manifest);
  const cannot = failedToStart ?? ("reason" in h ? h.reason : undefined);
  if (cannot) return <Codicon name="warning" className="tm-ext-code-warning" title={`This extension's code cannot run here: ${cannot}`} />;
  const st = stateLabel(r);
  if (!st) return null;
  return (
    <span className={`tm-ext-runtime ${st.cls}`} title={r?.state === "failed" ? `Activation failed: ${r.error ?? ""}` : st.label} data-testid="ext-runtime">
      <Codicon name={st.icon} className={st.icon === "loading" ? "codicon-modifier-spin" : ""} />
      {st.label}
    </span>
  );
}

/** The notice under an extension's header about its code. */
export function CodeNotice({ manifest, installed }: { manifest: ExtensionManifest; installed?: InstalledExtension }) {
  const r = useExtHost((s) => (installed ? s.runtime[installed.id] : undefined));
  const cannot = useExtHost((s) => (installed ? s.cannotRun[installed.id] : undefined));
  if (!manifest.hasCode) return null;
  const host = hostFor(manifest);
  const reason = cannot ?? ("reason" in host ? host.reason : null);
  if (reason) {
    return (
      <p className="tm-ext-notice is-warning" role="note">
        <Codicon name="warning" />
        <span>This extension's code cannot run here: {reason}</span>
      </p>
    );
  }
  if (r?.state === "failed") {
    return (
      <p className="tm-ext-notice is-error" role="note">
        <Codicon name="error" />
        <span>Activating this extension failed: {r.error}</span>
      </p>
    );
  }
  return null;
}

/** "Runtime Status" tab of the extension details editor. */
export function RuntimeStatus({ ext }: { ext: InstalledExtension }) {
  const r = useExtHost((s) => s.runtime[ext.id]);
  const nodeInfo = useExtHost((s) => s.nodeInfo);
  const events = (ext.manifest.raw.activationEvents as string[] | undefined) ?? [];
  const st = stateLabel(r);
  const ignored = unsupportedEvents(events);
  return (
    <div className="tm-ext-runtime-status">
      <dl>
        <dt>State</dt>
        <dd>{!ext.enabled ? "Disabled" : st ? st.label : "Not activated yet"}</dd>
        {r?.reason && (
          <>
            <dt>Activated by</dt>
            <dd>
              <code>{r.reason}</code>
            </dd>
          </>
        )}
        {r?.host && (
          <>
            <dt>Extension host</dt>
            <dd>{r.host === "node" ? `Node.js${nodeInfo ? ` — ${nodeInfo}` : ""}` : "Web Worker"}</dd>
          </>
        )}
        {r?.error && (
          <>
            <dt>Error</dt>
            <dd className="tm-ext-runtime-error">{r.error}</dd>
          </>
        )}
      </dl>
      {events.length > 0 && (
        <section>
          <h3>Activation events</h3>
          <ul>
            {events.map((e) => (
              <li key={e}>
                <code>{e}</code>
                {ignored.includes(e) && <span className="tm-muted"> (never fires in TMCode)</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {r?.unsupported.length ? (
        <section>
          <h3>Not supported in TMCode yet</h3>
          <p className="tm-muted">The extension used these APIs; they were ignored or failed.</p>
          <ul>
            {r.unsupported.map((u) => (
              <li key={u}>
                <code>{u}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p>
        <button type="button" className="tm-button tm-button--secondary" onClick={() => void restartExtensionHosts(true)}>
          Restart Extension Host
        </button>
      </p>
    </div>
  );
}

/** Extensions' status bar items on one side, ordered by priority (higher first, as in VS Code). */
export function ExtensionStatusItems({ side }: { side: "left" | "right" }) {
  const items = useExtStatusBar((s) => s.items);
  const language = useWorkbench((s) => s.activeLanguage);
  const list = useMemo(
    () =>
      Object.values(items)
        .filter((i) => i.visible && i.text && (i.alignment === 2 ? "right" : "left") === side)
        .filter((i) => !i.selector || i.selector.some((f) => !f.language || f.language === "*" || f.language === language))
        .sort((a, b) => b.priority - a.priority),
    [items, side, language],
  );
  return (
    <>
      {list.map((i) => {
        const title = i.tooltip ?? i.name ?? i.text.replace(/\$\([^)]*\)\s*/g, "");
        const style = i.color ? { color: i.color } : undefined;
        const body = <LabelWithIcons text={i.text} />;
        return i.command ? (
          <button
            key={i.id}
            type="button"
            className="tm-status-item is-clickable tm-status-ext"
            title={title}
            aria-label={title}
            style={style}
            data-ext-status={i.id}
            onClick={() => runCachedCommand(i.host, i.command!.ref)}
          >
            {body}
          </button>
        ) : (
          <span key={i.id} className="tm-status-item tm-status-ext" title={title} style={style} data-ext-status={i.id}>
            {body}
          </span>
        );
      })}
    </>
  );
}


/** editor/title buttons of running extensions (navigation group) for the active file. */
export function ExtensionTitleActions({ path }: { path: string }) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useContextVersion((s) => s.v);
  useWorkbench((s) => s.activeLanguage);
  useEffect(() => onTitleItemsChanged(bump), []);
  const items = editorTitleItems().filter((x) => x.navigation);
  return (
    <>
      {items.map(({ cmd }) => (
        <ActionButton
          key={cmd.command}
          icon={typeof cmd.icon === "string" && !cmd.icon.includes("/") && !cmd.icon.includes(".") ? cmd.icon : "symbol-event"}
          label={cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title}
          onClick={() => runContributedCommand(cmd.command, [{ $path: path }])}
        />
      ))}
    </>
  );
}

/** Output channel picker (VS Code's dropdown); "All" shows every channel. */
export function OutputChannelPicker() {
  const output = useWorkbench((s) => s.output);
  const selected = useOutputChannel((s) => s.selected);
  const channels = useMemo(() => [...new Set(output.map((l) => l.channel))].sort((a, b) => a.localeCompare(b)), [output]);
  return (
    <select className="tm-select tm-output-channel-select" aria-label="Output channel" value={selected ?? ""} onChange={(e) => useOutputChannel.setState({ selected: e.target.value || null })}>
      <option value="">All Channels</option>
      {[...new Set([...channels, ...(selected ? [selected] : [])])].map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}

export function useOutputChannelFilter(): string | null {
  return useOutputChannel((s) => s.selected);
}

// ───────────── Settings editor: Extensions section ─────────────

function matches(p: ConfigurationProperty, q: string) {
  if (!q) return true;
  const hay = `${p.key} ${p.title} ${p.description ?? ""} ${p.markdownDescription ?? ""}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function labelOf(key: string) {
  const last = key.split(".").slice(1).join(".") || key;
  return last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\./g, " › ").replace(/^\w/, (c) => c.toUpperCase());
}

function typeOf(p: ConfigurationProperty): string {
  const t = Array.isArray(p.type) ? p.type.find((x) => x !== "null") : p.type;
  if (p.enum) return "enum";
  return t ?? "string";
}

function SettingControl({ p }: { p: ConfigurationProperty }) {
  useExtConfig((s) => s.user);
  const value = configValue(p.key);
  const id = `ext-setting-${p.key}`;
  const set = (v: unknown) => void updateExtensionSetting(p.key, v);
  const [draft, setDraft] = useState<string | null>(null);
  switch (typeOf(p)) {
    case "boolean":
      return (
        <label className="tm-setting-checkbox" htmlFor={id}>
          <input id={id} type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />
          <span>{p.description ?? p.markdownDescription}</span>
        </label>
      );
    case "enum":
      return (
        <select id={id} className="tm-select" value={String(value ?? "")} onChange={(e) => set(p.enum!.find((x) => String(x) === e.target.value))}>
          {p.enum!.map((o, i) => (
            <option key={String(o)} value={String(o)} title={p.enumDescriptions?.[i]}>
              {String(o)}
            </option>
          ))}
        </select>
      );
    case "number":
    case "integer":
      return (
        <input
          id={id}
          className="tm-input tm-input--number"
          type="number"
          min={p.minimum}
          max={p.maximum}
          value={draft ?? String(value ?? "")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null && draft.trim() !== "" && Number.isFinite(Number(draft))) set(Number(draft));
            setDraft(null);
          }}
        />
      );
    case "string":
      return <input id={id} className="tm-input tm-input--wide" value={draft ?? String(value ?? "")} onChange={(e) => setDraft(e.target.value)} onBlur={() => (draft !== null ? (set(draft), setDraft(null)) : undefined)} />;
    default: {
      // Objects and arrays: JSON, as VS Code's "Edit in settings.json".
      const text = draft ?? JSON.stringify(value ?? null, null, 2);
      let error: string | null = null;
      try {
        JSON.parse(text);
      } catch (e) {
        error = String((e as Error).message);
      }
      return (
        <>
          <textarea id={id} className="tm-input tm-setting-json tm-mono" spellCheck={false} rows={Math.min(10, text.split("\n").length + 1)} value={text} onChange={(e) => setDraft(e.target.value)} onBlur={() => !error && draft !== null && (set(JSON.parse(draft)), setDraft(null))} aria-invalid={!!error} />
          {error && draft !== null && <div className="tm-setting-error">{error}</div>}
        </>
      );
    }
  }
}

/** The Extensions section of the Settings editor: one group per extension with code. */
export function ExtensionSettingsSection({ query, onlyModified }: { query: string; onlyModified: boolean }) {
  useExtensions((s) => s.version);
  useExtConfig((s) => s.user);
  const sections = extensionConfigSections()
    .map((s) => ({ ...s, properties: s.properties.filter((p) => matches(p, query) && !p.deprecationMessage && (!onlyModified || isModified(p.key))) }))
    .filter((s) => s.properties.length);
  if (!sections.length) return null;
  return (
    <>
      {sections.map((s) => (
        <section key={s.extensionId} id={`settings-ext-${s.extensionId}`} className="tm-settings-section" data-extension={s.extensionId}>
          <h3>Extensions › {s.title}</h3>
          {s.properties.map((p) => (
            <div key={p.key} className={`tm-setting ${isModified(p.key) ? "is-modified" : ""}`}>
              <div className="tm-setting-title">
                <span className="tm-setting-category">{s.title}: </span>
                <strong>{labelOf(p.key)}</strong>
                {isModified(p.key) && (
                  <>
                    <span className="tm-setting-modified">Modified</span>
                    <button type="button" className="tm-link-button" onClick={() => void updateExtensionSetting(p.key, null)}>
                      Reset
                    </button>
                  </>
                )}
              </div>
              {typeOf(p) !== "boolean" && <div className="tm-setting-description">{p.description ?? p.markdownDescription}</div>}
              <div className="tm-setting-control">
                <SettingControl p={p} />
              </div>
              <div className="tm-setting-key tm-muted">{p.key}</div>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

