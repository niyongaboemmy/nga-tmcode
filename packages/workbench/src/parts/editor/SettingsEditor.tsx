import { useEffect, useMemo, useState } from "react";
import { useTr } from "../../messages/i18n";
import { DEFAULT_SETTINGS, SETTING_SECTIONS, type SettingDef, type SettingKey, type Settings } from "../../state/settings";
import { openFile, openSpecialEditor, setWorkspaceSetting, updateSetting, useWorkbench } from "../../state/store";
import { ActionButton, Codicon } from "../../widgets/icons";
import { loadTerminalProfiles, useTerminalProfiles } from "../../terminal/profiles";
import { WORKSPACE_SETTINGS_FILE, WORKSPACE_KEYS } from "../../state/settingsJson";
import { allThemes, useThemes } from "../../themes/themeService";
import { allIconThemes, useIconTheme } from "../../themes/iconThemes";
import { ExtensionSettingsSection } from "../../exthost/ui";
import { AiKeysSettingsSection, aiKeysMatch } from "../../ai/AiKeysSettings";

/** Enum options, including themes contributed by installed extensions. */
function useOptions(def: Extract<SettingDef, { type: "enum" }>) {
  useThemes((s) => s.version);
  useIconTheme((s) => s.version);
  const profiles = useTerminalProfiles((s) => s.profiles);
  useEffect(() => {
    if (def.dynamicOptions === "terminalProfiles") void loadTerminalProfiles();
  }, [def.dynamicOptions]);
  if (def.dynamicOptions === "colorThemes") return allThemes().map((t) => ({ value: t.id, label: t.label }));
  if (def.dynamicOptions === "iconThemes") return allIconThemes().map((t) => ({ value: t.id, label: t.label }));
  if (def.dynamicOptions === "terminalProfiles") return [...def.options, ...profiles.map((p) => ({ value: p.id, label: `${p.name}${p.is_default ? " (system)" : ""}` }))];
  return def.options;
}

function EnumControl({ def, id, value, locked, set }: { def: Extract<SettingDef, { type: "enum" }>; id: string; value: unknown; locked: boolean; set: (v: unknown) => void }) {
  const options = useOptions(def);
  return (
    <select id={id} className="tm-select" value={String(value)} disabled={locked} onChange={(e) => set(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function matches(def: SettingDef, q: string) {
  if (!q) return true;
  const hay = `${def.key} ${def.label} ${def.description}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

function Control({ def, value, locked, workspace }: { def: SettingDef; value: unknown; locked: boolean; workspace?: boolean }) {
  const id = `setting-${def.key}`;
  // The Workspace tab writes the folder's .vscode/settings.json; the User tab your own settings.
  const set = (v: unknown) => (workspace ? void setWorkspaceSetting(def.key, v) : updateSetting(def.key, v as Settings[typeof def.key]));
  switch (def.type) {
    case "boolean":
      return (
        <label className="tm-setting-checkbox" htmlFor={id}>
          <input id={id} type="checkbox" checked={!!value} disabled={locked} onChange={(e) => set(e.target.checked)} />
          <span>{def.description}</span>
        </label>
      );
    case "enum":
      return <EnumControl def={def} id={id} value={value} locked={locked} set={set} />;
    case "number":
      return (
        <input
          id={id}
          className="tm-input tm-input--number"
          type="number"
          min={def.min}
          max={def.max}
          value={Number(value)}
          disabled={locked}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= def.min && n <= def.max) set(n);
          }}
        />
      );
    default:
      return (
        <input
          id={id}
          className="tm-input tm-input--wide"
          value={String(value)}
          placeholder={def.placeholder}
          disabled={locked}
          onChange={(e) => set(e.target.value)}
        />
      );
  }
}

/** Language scopes that set a key, e.g. ["python"] for "[python]": { "editor.tabSize": 4 }. */
function scopesOf(key: SettingKey, langs: Record<string, Partial<Settings>>) {
  return Object.entries(langs)
    .filter(([, v]) => key in v)
    .map(([l]) => l);
}

export function SettingsEditor() {
  const t = useTr();
  const settings = useWorkbench((s) => s.userSettings);
  const languages = useWorkbench((s) => s.languageSettings);
  const overlay = useWorkbench((s) => s.workspaceSettings);
  const locked = useWorkbench((s) => s.policy.locked_settings);
  const [query, setQuery] = useState("");
  const [onlyModified, setOnlyModified] = useState(false);
  const [tab, setTab] = useState<"user" | "workspace">("user");
  const workspaceOpen = useWorkbench((s) => !!s.workspace && s.policy.mode === "practice");
  const workspaceTab = tab === "workspace" && workspaceOpen;
  const inWorkspace = (key: SettingKey) => !!overlay && (key in overlay.values || Object.values(overlay.languages).some((l) => key in l));

  const sections = useMemo(
    () =>
      SETTING_SECTIONS.map((s) => ({
        ...s,
        settings: s.settings.filter(
          // The Workspace tab: only what a folder may set (the rest stays personal).
          (d) => matches(d, query) && (workspaceTab ? WORKSPACE_KEYS.includes(d.key) && (!onlyModified || inWorkspace(d.key)) : !onlyModified || settings[d.key] !== DEFAULT_SETTINGS[d.key]),
        ),
      })).filter((s) => s.settings.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, onlyModified, settings, workspaceTab, overlay],
  );
  const count = sections.reduce((n, s) => n + s.settings.length, 0);

  return (
    <div className="tm-settings">
      <div className="tm-settings-header">
        <div className="tm-input-box tm-settings-search">
          <Codicon name="search" className="tm-input-leading" />
          <input className="tm-input" placeholder={t("Search settings")} aria-label={t("Search settings")} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          <span className="tm-settings-count">{query || onlyModified ? `${count} Setting${count === 1 ? "" : "s"} Found` : ""}</span>
          <button
            type="button"
            className={`tm-input-toggle ${onlyModified ? "is-on" : ""}`}
            aria-pressed={onlyModified}
            title="Show modified settings only"
            aria-label="Show modified settings only"
            onClick={() => setOnlyModified(!onlyModified)}
          >
            <Codicon name="filter" />
          </button>
        </div>
        <div className="tm-settings-tabs" role="tablist" aria-label="Settings scope">
          <button type="button" role="tab" aria-selected={!workspaceTab} className={`tm-settings-tab ${!workspaceTab ? "is-active" : ""}`} onClick={() => setTab("user")}>
            {t("User")}
          </button>
          {workspaceOpen && (
            <button
              type="button"
              role="tab"
              aria-selected={workspaceTab}
              className={`tm-settings-tab ${workspaceTab ? "is-active" : ""}`}
              title={`This folder's settings (${WORKSPACE_SETTINGS_FILE})`}
              onClick={() => setTab("workspace")}
            >
              {t("Workspace")}
            </button>
          )}
          <span className="tm-settings-tabs-actions">
            <ActionButton icon="go-to-file" label="Open Settings (JSON)" onClick={() => openSpecialEditor("settingsJson")} />
          </span>
        </div>
        {workspaceTab && (
          <div className="tm-settings-workspace-note" role="note">
            <Codicon name="root-folder" /> Settings saved in this folder's{" "}
            <button type="button" className="tm-link-button" onClick={() => openFile(WORKSPACE_SETTINGS_FILE, { pinned: true })}>
              {WORKSPACE_SETTINGS_FILE}
            </button>
            . They override your own while this folder is open, and go with the folder.
            {overlay && overlay.ignored.length > 0 && (
              <ul className="tm-settings-ignored">
                {overlay.ignored.map((i) => (
                  <li key={i.key}>
                    <code>{i.key}</code>: not used. {i.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="tm-settings-body">
        <nav className="tm-settings-toc" aria-label="Settings sections">
          {sections.map((s) => (
            <a key={s.title} href={`#settings-${s.title}`} onClick={(e) => {
              e.preventDefault();
              document.getElementById(`settings-${s.title}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}>
              {t(s.title)}
            </a>
          ))}
          {!workspaceTab && !onlyModified && aiKeysMatch(query) && (
            <a href="#settings-TMCode AI" onClick={(e) => {
              e.preventDefault();
              document.getElementById("settings-TMCode AI")?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}>
              TMCode AI
            </a>
          )}
        </nav>
        <div className="tm-settings-list tm-scroll">
          {sections.length === 0 && !query && !onlyModified && <p className="tm-muted">{workspaceTab ? "This folder doesn't change any setting TMCode has." : "No settings found."}</p>}
          {sections.map((s) => (
            <section key={s.title} id={`settings-${s.title}`} className="tm-settings-section">
              <h3>{t(s.title)}</h3>
              {s.settings.map((def) => {
                const wsValue = overlay?.values[def.key];
                const value = workspaceTab ? (wsValue ?? settings[def.key]) : settings[def.key];
                const modified = workspaceTab ? wsValue !== undefined : value !== DEFAULT_SETTINGS[def.key];
                const isLocked = locked.includes(def.key);
                const scopes = scopesOf(def.key, workspaceTab ? (overlay?.languages ?? {}) : languages);
                return (
                  <div key={def.key} className={`tm-setting ${modified ? "is-modified" : ""}`} data-setting={def.key}>
                    <div className="tm-setting-title">
                      <span className="tm-setting-category">{t(s.title)}: </span>
                      <strong>{t(def.label)}</strong>
                      {modified && <span className="tm-setting-modified">{workspaceTab ? "Set in this folder" : "Modified"}</span>}
                      {!workspaceTab && inWorkspace(def.key) && (
                        <button type="button" className="tm-setting-badge" title="This folder's settings change it: see the Workspace tab" onClick={() => setTab("workspace")}>
                          Workspace
                        </button>
                      )}
                      {scopes.map((l) => (
                        <span key={l} className="tm-setting-badge" title={`Also set for ${l} files in settings.json`}>
                          [{l}]
                        </span>
                      ))}
                      {locked.includes(def.key) && (
                        <span className="tm-setting-locked" title="Locked by your teacher for this session">
                          <Codicon name="lock" /> Locked by teacher
                        </span>
                      )}
                      {modified && !isLocked && !workspaceTab && (
                        <button type="button" className="tm-link-button" onClick={() => updateSetting(def.key, DEFAULT_SETTINGS[def.key] as never)}>
                          Reset
                        </button>
                      )}
                      {modified && !isLocked && workspaceTab && (
                        <button type="button" className="tm-link-button" onClick={() => void setWorkspaceSetting(def.key, undefined)} title="Remove it from this folder's settings">
                          Reset
                        </button>
                      )}
                    </div>
                    {def.type !== "boolean" && <div className="tm-setting-description">{def.description}</div>}
                    {workspaceTab && wsValue === undefined && scopes.length > 0 && <div className="tm-setting-description">Set only for some languages: {scopes.map((l) => `[${l}]`).join(", ")}.</div>}
                    <div className="tm-setting-control">
                      <Control def={def} value={value} locked={isLocked} workspace={workspaceTab} />
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
          {/* Your own AI keys (OS keychain) and premium AI: not plain settings, never in settings.json. */}
          {!workspaceTab && !onlyModified && <AiKeysSettingsSection query={query} />}
          {/* ── extension host (feat/exthost): settings contributed by extensions ── */}
          {!workspaceTab && <ExtensionSettingsSection query={query} onlyModified={onlyModified} />}
        </div>
      </div>
    </div>
  );
}
