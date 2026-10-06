import { useMemo, useState } from "react";
import { DEFAULT_SETTINGS, SETTING_SECTIONS, type SettingDef, type Settings } from "../../state/settings";
import { updateSetting, useWorkbench } from "../../state/store";
import { Codicon } from "../../widgets/icons";
import { allThemes, useThemes } from "../../themes/themeService";
import { allIconThemes, useIconTheme } from "../../themes/iconThemes";

/** Enum options, including themes contributed by installed extensions. */
function useOptions(def: Extract<SettingDef, { type: "enum" }>) {
  useThemes((s) => s.version);
  useIconTheme((s) => s.version);
  if (def.dynamicOptions === "colorThemes") return allThemes().map((t) => ({ value: t.id, label: t.label }));
  if (def.dynamicOptions === "iconThemes") return allIconThemes().map((t) => ({ value: t.id, label: t.label }));
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

function Control({ def, value, locked }: { def: SettingDef; value: unknown; locked: boolean }) {
  const id = `setting-${def.key}`;
  const set = (v: unknown) => updateSetting(def.key, v as Settings[typeof def.key]);
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

export function SettingsEditor() {
  const settings = useWorkbench((s) => s.settings);
  const locked = useWorkbench((s) => s.policy.locked_settings);
  const [query, setQuery] = useState("");
  const [onlyModified, setOnlyModified] = useState(false);

  const sections = useMemo(
    () =>
      SETTING_SECTIONS.map((s) => ({
        ...s,
        settings: s.settings.filter((d) => matches(d, query) && (!onlyModified || settings[d.key] !== DEFAULT_SETTINGS[d.key])),
      })).filter((s) => s.settings.length),
    [query, onlyModified, settings],
  );
  const count = sections.reduce((n, s) => n + s.settings.length, 0);

  return (
    <div className="tm-settings">
      <div className="tm-settings-header">
        <div className="tm-input-box tm-settings-search">
          <Codicon name="search" className="tm-input-leading" />
          <input className="tm-input" placeholder="Search settings" aria-label="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
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
        <div className="tm-settings-tabs" role="tablist">
          <span role="tab" aria-selected className="tm-settings-tab is-active">
            User
          </span>
        </div>
      </div>
      <div className="tm-settings-body">
        <nav className="tm-settings-toc" aria-label="Settings sections">
          {sections.map((s) => (
            <a key={s.title} href={`#settings-${s.title}`} onClick={(e) => {
              e.preventDefault();
              document.getElementById(`settings-${s.title}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}>
              {s.title}
            </a>
          ))}
        </nav>
        <div className="tm-settings-list tm-scroll">
          {sections.length === 0 && <p className="tm-muted">No settings found.</p>}
          {sections.map((s) => (
            <section key={s.title} id={`settings-${s.title}`} className="tm-settings-section">
              <h3>{s.title}</h3>
              {s.settings.map((def) => {
                const value = settings[def.key];
                const modified = value !== DEFAULT_SETTINGS[def.key];
                const isLocked = locked.includes(def.key);
                return (
                  <div key={def.key} className={`tm-setting ${modified ? "is-modified" : ""}`}>
                    <div className="tm-setting-title">
                      <span className="tm-setting-category">{s.title}: </span>
                      <strong>{def.label}</strong>
                      {modified && <span className="tm-setting-modified">Modified</span>}
                      {isLocked && (
                        <span className="tm-setting-locked" title="Locked by your teacher for this session">
                          <Codicon name="lock" /> Locked by teacher
                        </span>
                      )}
                      {modified && !isLocked && (
                        <button type="button" className="tm-link-button" onClick={() => updateSetting(def.key, DEFAULT_SETTINGS[def.key] as never)}>
                          Reset
                        </button>
                      )}
                    </div>
                    {def.type !== "boolean" && <div className="tm-setting-description">{def.description}</div>}
                    <div className="tm-setting-control">
                      <Control def={def} value={value} locked={isLocked} />
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
