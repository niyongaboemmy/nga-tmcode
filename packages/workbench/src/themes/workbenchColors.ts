import type { ITheme } from "@xterm/xterm";
import { isDarkUi, normalizeHex, type ResolvedTheme, type UiTheme } from "../textmate/themeData";

/**
 * VS Code colour keys → the workbench's CSS variables (styles/theme.css).
 * A theme recolours the whole workbench, as in VS Code: keys it defines win;
 * keys it leaves out fall back to VS Code's colour-registry defaults for its
 * kind (so a theme that only sets the editor still gets Dark+/Light+ chrome).
 */

type Defaults = Partial<Record<"dark" | "light", string>>;

/** [css variable, VS Code keys in priority order, registry default when none is set]. */
const MAP: [string, string[], Defaults?][] = [
  ["--foreground", ["foreground"], { dark: "#CCCCCC", light: "#616161" }],
  ["--description", ["descriptionForeground"], { dark: "#CCCCCCB3", light: "#717171" }],
  ["--disabled", ["disabledForeground"], { dark: "#CCCCCC80", light: "#61616180" }],
  ["--icon", ["icon.foreground"], { dark: "#C5C5C5", light: "#424242" }],
  ["--focus-border", ["focusBorder"], { dark: "#007FD4", light: "#0090F1" }],
  ["--accent", ["button.background", "focusBorder"], { dark: "#0E639C", light: "#007ACC" }],
  ["--accent-hover", ["button.hoverBackground"], { dark: "#1177BB", light: "#0062A3" }],
  ["--accent-fg", ["button.foreground"], { dark: "#FFFFFF", light: "#FFFFFF" }],
  ["--border", ["sideBar.border", "panel.border", "editorGroup.border"], { dark: "#80808033", light: "#80808033" }],
  ["--widget-border", ["widget.border", "editorWidget.border"], { dark: "#454545", light: "#C8C8C8" }],
  ["--shadow", ["widget.shadow"], { dark: "#0000005C", light: "#00000029" }],
  ["--link", ["textLink.foreground"], { dark: "#3794FF", light: "#006AB1" }],

  ["--titlebar-bg", ["titleBar.activeBackground"], { dark: "#3C3C3C", light: "#DDDDDD" }],
  ["--titlebar-fg", ["titleBar.activeForeground"], { dark: "#CCCCCC", light: "#333333" }],
  ["--titlebar-inactive-fg", ["titleBar.inactiveForeground"], { dark: "#CCCCCC99", light: "#33333399" }],
  ["--commandcenter-bg", ["commandCenter.background"], { dark: "#FFFFFF0D", light: "#00000008" }],
  ["--commandcenter-hover-bg", ["commandCenter.activeBackground"], { dark: "#FFFFFF14", light: "#00000014" }],
  ["--commandcenter-border", ["commandCenter.border"], { dark: "#CCCCCC33", light: "#33333333" }],

  ["--activitybar-bg", ["activityBar.background"], { dark: "#333333", light: "#2C2C2C" }],
  ["--activitybar-fg", ["activityBar.foreground"], { dark: "#FFFFFF", light: "#FFFFFF" }],
  ["--activitybar-inactive-fg", ["activityBar.inactiveForeground"], { dark: "#FFFFFF66", light: "#FFFFFF66" }],
  ["--activitybar-active-border", ["activityBar.activeBorder", "activityBar.foreground"], { dark: "#FFFFFF", light: "#FFFFFF" }],
  ["--badge-bg", ["activityBarBadge.background", "badge.background"], { dark: "#007ACC", light: "#007ACC" }],
  ["--badge-fg", ["activityBarBadge.foreground", "badge.foreground"], { dark: "#FFFFFF", light: "#FFFFFF" }],

  ["--sidebar-bg", ["sideBar.background"], { dark: "#252526", light: "#F3F3F3" }],
  ["--sidebar-fg", ["sideBar.foreground", "foreground"], { dark: "#CCCCCC", light: "#616161" }],
  ["--sidebar-title-fg", ["sideBarTitle.foreground", "sideBar.foreground"], { dark: "#BBBBBB", light: "#6F6F6F" }],
  ["--section-header-bg", ["sideBarSectionHeader.background", "sideBar.background"], { dark: "#252526", light: "#F3F3F3" }],

  ["--editor-bg", ["editor.background"], { dark: "#1E1E1E", light: "#FFFFFF" }],
  ["--editor-fg", ["editor.foreground"], { dark: "#D4D4D4", light: "#000000" }],
  ["--tabs-bg", ["editorGroupHeader.tabsBackground"], { dark: "#252526", light: "#F3F3F3" }],
  ["--tab-active-bg", ["tab.activeBackground", "editor.background"], { dark: "#1E1E1E", light: "#FFFFFF" }],
  ["--tab-active-fg", ["tab.activeForeground"], { dark: "#FFFFFF", light: "#333333" }],
  ["--tab-inactive-bg", ["tab.inactiveBackground"], { dark: "#2D2D2D", light: "#ECECEC" }],
  ["--tab-inactive-fg", ["tab.inactiveForeground"], { dark: "#FFFFFF80", light: "#33333380" }],
  ["--tab-active-border-top", ["tab.activeBorderTop", "tab.activeBorder"], { dark: "#00000000", light: "#00000000" }],
  ["--tab-unfocused-active-border-top", ["tab.unfocusedActiveBorderTop", "tab.unfocusedActiveBorder"], { dark: "#00000000", light: "#00000000" }],
  ["--tab-hover-bg", ["tab.hoverBackground", "tab.inactiveBackground"], { dark: "#2D2D2D", light: "#ECECEC" }],
  ["--breadcrumb-fg", ["breadcrumb.foreground"], { dark: "#CCCCCCCC", light: "#616161CC" }],

  ["--panel-bg", ["panel.background", "editor.background"], { dark: "#1E1E1E", light: "#FFFFFF" }],
  ["--panel-title-active-fg", ["panelTitle.activeForeground"], { dark: "#E7E7E7", light: "#424242" }],
  ["--panel-title-inactive-fg", ["panelTitle.inactiveForeground"], { dark: "#E7E7E799", light: "#42424275" }],
  ["--panel-active-border", ["panelTitle.activeBorder", "panelTitle.activeForeground"], { dark: "#E7E7E7", light: "#424242" }],

  ["--statusbar-bg", ["statusBar.background"], { dark: "#007ACC", light: "#007ACC" }],
  ["--statusbar-fg", ["statusBar.foreground"], { dark: "#FFFFFF", light: "#FFFFFF" }],
  ["--statusbar-hover-bg", ["statusBarItem.hoverBackground"], { dark: "#FFFFFF1F", light: "#FFFFFF1F" }],
  ["--statusbar-border", ["statusBar.border"], { dark: "#00000000", light: "#00000000" }],

  ["--input-bg", ["input.background"], { dark: "#3C3C3C", light: "#FFFFFF" }],
  ["--input-fg", ["input.foreground", "foreground"], { dark: "#CCCCCC", light: "#616161" }],
  ["--input-border", ["input.border"], { dark: "#00000000", light: "#CECECE" }],
  ["--input-placeholder", ["input.placeholderForeground"], { dark: "#A6A6A6", light: "#767676" }],
  ["--button-bg", ["button.background"], { dark: "#0E639C", light: "#007ACC" }],
  ["--button-fg", ["button.foreground"], { dark: "#FFFFFF", light: "#FFFFFF" }],
  ["--button-hover-bg", ["button.hoverBackground"], { dark: "#1177BB", light: "#0062A3" }],
  ["--button-secondary-bg", ["button.secondaryBackground"], { dark: "#3A3D41", light: "#5F6A79" }],
  ["--button-secondary-fg", ["button.secondaryForeground"], { dark: "#FFFFFF", light: "#FFFFFF" }],
  ["--button-secondary-hover-bg", ["button.secondaryHoverBackground"], { dark: "#45494E", light: "#4C5561" }],
  ["--checkbox-bg", ["checkbox.background", "dropdown.background"], { dark: "#3C3C3C", light: "#FFFFFF" }],

  ["--list-hover-bg", ["list.hoverBackground"], { dark: "#2A2D2E", light: "#E8E8E8" }],
  ["--list-active-bg", ["list.activeSelectionBackground"], { dark: "#04395E", light: "#0060C0" }],
  ["--list-active-fg", ["list.activeSelectionForeground"], { dark: "#FFFFFF", light: "#FFFFFF" }],
  ["--list-inactive-bg", ["list.inactiveSelectionBackground"], { dark: "#37373D", light: "#E4E6F1" }],
  ["--list-focus-outline", ["list.focusOutline", "focusBorder"], { dark: "#007FD4", light: "#0090F1" }],
  ["--list-highlight", ["list.highlightForeground"], { dark: "#2AAAFF", light: "#0066BF" }],
  ["--tree-indent-guide", ["tree.indentGuidesStroke"], { dark: "#585858", light: "#A9A9A9" }],

  ["--widget-bg", ["editorWidget.background"], { dark: "#252526", light: "#F3F3F3" }],
  ["--quickinput-bg", ["quickInput.background", "editorWidget.background"], { dark: "#252526", light: "#F3F3F3" }],
  ["--menu-bg", ["menu.background", "dropdown.background"], { dark: "#252526", light: "#FFFFFF" }],
  ["--menu-selection-bg", ["menu.selectionBackground", "list.activeSelectionBackground"], { dark: "#04395E", light: "#0060C0" }],
  ["--menu-selection-fg", ["menu.selectionForeground", "list.activeSelectionForeground"], { dark: "#FFFFFF", light: "#FFFFFF" }],
  ["--menu-separator", ["menu.separatorBackground"], { dark: "#606060", light: "#D4D4D4" }],

  ["--error", ["errorForeground", "editorError.foreground"], { dark: "#F48771", light: "#A1260D" }],
  ["--warning", ["editorWarning.foreground"], { dark: "#CCA700", light: "#BF8803" }],
  ["--info", ["editorInfo.foreground"], { dark: "#3794FF", light: "#1A85FF" }],
  ["--success", ["testing.iconPassed"], { dark: "#73C991", light: "#388A34" }],
  ["--modified", ["gitDecoration.modifiedResourceForeground", "editorGutter.modifiedBackground"], { dark: "#E2C08D", light: "#895503" }],

  ["--scrollbar", ["scrollbarSlider.background"], { dark: "#79797966", light: "#64646466" }],
  ["--scrollbar-hover", ["scrollbarSlider.hoverBackground"], { dark: "#646464B3", light: "#646464B3" }],
];

/** CSS custom properties for a theme. High-contrast themes keep the HC base and only take explicit keys. */
export function cssVarsForTheme(theme: ResolvedTheme): Record<string, string> {
  const kind = theme.uiTheme === "hc-black" || theme.uiTheme === "hc-light" ? null : isDarkUi(theme.uiTheme) ? "dark" : "light";
  const out: Record<string, string> = {};
  for (const [cssVar, keys, defaults] of MAP) {
    let value: string | null = null;
    for (const k of keys) {
      value = normalizeHex(theme.colors[k]);
      if (value) break;
    }
    value ??= kind && defaults?.[kind] ? defaults[kind]! : null;
    if (value) out[cssVar] = value;
  }
  return out;
}

const ANSI = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"] as const;

const DARK_ANSI = ["#000000", "#CD3131", "#0DBC79", "#E5E510", "#2472C8", "#BC3FBC", "#11A8CD", "#E5E5E5", "#666666", "#F14C4C", "#23D18B", "#F5F543", "#3B8EEA", "#D670D6", "#29B8DB", "#E5E5E5"];
const LIGHT_ANSI = ["#000000", "#CD3131", "#107C10", "#949800", "#0451A5", "#BC05BC", "#0598BC", "#555555", "#666666", "#CD3131", "#14CE14", "#B5BA00", "#0451A5", "#BC05BC", "#0598BC", "#A5A5A5"];
const HC_ANSI = ["#000000", "#CD0000", "#00CD00", "#CDCD00", "#0000EE", "#CD00CD", "#00CDCD", "#E5E5E5", "#7F7F7F", "#FF0000", "#00FF00", "#FFFF00", "#5C5CFF", "#FF00FF", "#00FFFF", "#FFFFFF"];

/** xterm.js colours from a theme's terminal.* keys (VS Code's defaults otherwise). */
export function terminalThemeFor(theme: ResolvedTheme, panelBg?: string): ITheme {
  const c = (k: string) => normalizeHex(theme.colors[k]) ?? undefined;
  const ui: UiTheme = theme.uiTheme;
  const dark = isDarkUi(ui);
  const ansi = ui === "hc-black" ? HC_ANSI : dark ? DARK_ANSI : LIGHT_ANSI;
  const out: ITheme = {
    background: c("terminal.background") ?? panelBg ?? c("panel.background") ?? c("editor.background") ?? (dark ? "#1E1E1E" : "#FFFFFF"),
    foreground: c("terminal.foreground") ?? (ui === "hc-black" ? "#FFFFFF" : dark ? "#CCCCCC" : "#333333"),
    cursor: c("terminalCursor.foreground") ?? (dark ? "#AEAFAD" : "#005FB8"),
    cursorAccent: c("terminalCursor.background") ?? (dark ? "#000000" : "#FFFFFF"),
    selectionBackground: c("terminal.selectionBackground") ?? c("editor.selectionBackground") ?? (dark ? "#264F78" : "#ADD6FF"),
  };
  const rec = out as Record<string, string | undefined>;
  ANSI.forEach((name, i) => {
    const key = name.toLowerCase();
    rec[key] = c(`terminal.ansi${name}`) ?? ansi[i];
    rec[`bright${name}`] = c(`terminal.ansiBright${name}`) ?? ansi[i + 8];
  });
  return out;
}
