import { useThemes } from "../../themes/themeService";
import { useWorkbench } from "../../state/store";
import { normalizeHex } from "../../textmate/themeData";

/**
 * The `--vscode-*` CSS variables VS Code gives webviews: every colour of the
 * active theme ("editor.background" → --vscode-editor-background), VS Code's
 * registry defaults for the common keys a theme leaves out, the workbench's
 * own computed colours for the chrome keys, and the font variables. Plus the
 * theme kind for `body.vscode-dark` / `vscode-light` / `vscode-high-contrast`.
 */

type Kind = "dark" | "light" | "hc";

/** VS Code's colour-registry defaults (dark, light, high contrast) for keys webviews commonly use. */
const DEFAULTS: Record<string, [string, string, string?]> = {
  foreground: ["#CCCCCC", "#616161", "#FFFFFF"],
  descriptionForeground: ["#CCCCCCB3", "#717171", "#FFFFFFB3"],
  disabledForeground: ["#CCCCCC80", "#61616180", "#A5A5A5"],
  errorForeground: ["#F48771", "#A1260D", "#F48771"],
  focusBorder: ["#007FD4", "#0090F1", "#F38518"],
  "icon.foreground": ["#C5C5C5", "#424242", "#FFFFFF"],
  "widget.shadow": ["#0000005C", "#00000029"],
  "widget.border": ["#454545", "#C8C8C8", "#6FC3DF"],
  "selection.background": ["#264F78", "#ADD6FF"],
  "textLink.foreground": ["#3794FF", "#006AB1", "#21A6FF"],
  "textLink.activeForeground": ["#3794FF", "#006AB1", "#21A6FF"],
  "textPreformat.foreground": ["#D7BA7D", "#A31515", "#FFFFFF"],
  "textPreformat.background": ["#FFFFFF1A", "#0000001A"],
  "textBlockQuote.background": ["#222222", "#F2F2F2"],
  "textBlockQuote.border": ["#007ACC80", "#0064C880", "#FFFFFF"],
  "textCodeBlock.background": ["#0A0A0A66", "#DCDCDC66"],
  "textSeparator.foreground": ["#FFFFFF2E", "#0000002E"],
  "editor.background": ["#1E1E1E", "#FFFFFF", "#000000"],
  "editor.foreground": ["#D4D4D4", "#000000", "#FFFFFF"],
  "editor.selectionBackground": ["#264F78", "#ADD6FF", "#FFFFFF"],
  "editor.lineHighlightBackground": ["#FFFFFF0F", "#0000000F"],
  "editor.findMatchHighlightBackground": ["#EA5C0055", "#EA5C0055"],
  "editorWidget.background": ["#252526", "#F3F3F3", "#0C141F"],
  "editorWidget.foreground": ["#CCCCCC", "#616161", "#FFFFFF"],
  "editorWidget.border": ["#454545", "#C8C8C8", "#6FC3DF"],
  "editorHoverWidget.background": ["#252526", "#F3F3F3", "#0C141F"],
  "editorGroup.border": ["#444444", "#E7E7E7", "#6FC3DF"],
  "editorGroupHeader.tabsBackground": ["#252526", "#F3F3F3", "#000000"],
  "editorError.foreground": ["#F14C4C", "#E51400"],
  "editorWarning.foreground": ["#CCA700", "#BF8803"],
  "editorInfo.foreground": ["#3794FF", "#1A85FF"],
  "editorLineNumber.foreground": ["#858585", "#237893", "#FFFFFF"],
  "button.background": ["#0E639C", "#007ACC", "#000000"],
  "button.foreground": ["#FFFFFF", "#FFFFFF", "#FFFFFF"],
  "button.hoverBackground": ["#1177BB", "#0062A3"],
  "button.border": ["#00000000", "#00000000", "#6FC3DF"],
  "button.secondaryBackground": ["#3A3D41", "#5F6A79"],
  "button.secondaryForeground": ["#FFFFFF", "#FFFFFF", "#FFFFFF"],
  "button.secondaryHoverBackground": ["#45494E", "#4C5561"],
  "input.background": ["#3C3C3C", "#FFFFFF", "#000000"],
  "input.foreground": ["#CCCCCC", "#616161", "#FFFFFF"],
  "input.border": ["#00000000", "#CECECE", "#6FC3DF"],
  "input.placeholderForeground": ["#A6A6A6", "#767676", "#FFFFFFB3"],
  "inputOption.activeBackground": ["#007FD466", "#0090F133"],
  "inputOption.activeBorder": ["#007ACC", "#007ACC", "#6FC3DF"],
  "inputOption.activeForeground": ["#FFFFFF", "#000000", "#FFFFFF"],
  "inputValidation.errorBackground": ["#5A1D1D", "#F2DEDE", "#000000"],
  "inputValidation.errorBorder": ["#BE1100", "#BE1100", "#BE1100"],
  "dropdown.background": ["#3C3C3C", "#FFFFFF", "#000000"],
  "dropdown.foreground": ["#F0F0F0", "#616161", "#FFFFFF"],
  "dropdown.border": ["#3C3C3C", "#CECECE", "#6FC3DF"],
  "dropdown.listBackground": ["#252526", "#FFFFFF", "#000000"],
  "checkbox.background": ["#3C3C3C", "#FFFFFF", "#000000"],
  "checkbox.border": ["#3C3C3C", "#CECECE", "#6FC3DF"],
  "checkbox.foreground": ["#F0F0F0", "#616161", "#FFFFFF"],
  "badge.background": ["#4D4D4D", "#C4C4C4", "#000000"],
  "badge.foreground": ["#FFFFFF", "#333333", "#FFFFFF"],
  "progressBar.background": ["#0E70C0", "#0E70C0", "#6FC3DF"],
  "list.activeSelectionBackground": ["#04395E", "#0060C0"],
  "list.activeSelectionForeground": ["#FFFFFF", "#FFFFFF"],
  "list.inactiveSelectionBackground": ["#37373D", "#E4E6F1"],
  "list.hoverBackground": ["#2A2D2E", "#E8E8E8"],
  "list.focusOutline": ["#007FD4", "#0090F1", "#F38518"],
  "list.highlightForeground": ["#2AAAFF", "#0066BF", "#F38518"],
  "list.errorForeground": ["#F88070", "#B01011"],
  "list.warningForeground": ["#CCA700", "#855F00"],
  "tree.indentGuidesStroke": ["#585858", "#A9A9A9", "#A9A9A9"],
  "scrollbarSlider.background": ["#79797966", "#64646466", "#6FC3DF99"],
  "scrollbarSlider.hoverBackground": ["#646464B3", "#646464B3", "#6FC3DFCC"],
  "scrollbarSlider.activeBackground": ["#BFBFBF66", "#00000099", "#6FC3DF"],
  "sideBar.background": ["#252526", "#F3F3F3", "#000000"],
  "sideBar.foreground": ["#CCCCCC", "#616161", "#FFFFFF"],
  "sideBar.border": ["#80808033", "#80808033", "#6FC3DF"],
  "sideBarTitle.foreground": ["#BBBBBB", "#6F6F6F", "#FFFFFF"],
  "sideBarSectionHeader.background": ["#00000000", "#00000000", "#00000000"],
  "sideBarSectionHeader.foreground": ["#CCCCCC", "#616161", "#FFFFFF"],
  "panel.background": ["#1E1E1E", "#FFFFFF", "#000000"],
  "panel.border": ["#80808059", "#80808059", "#6FC3DF"],
  "panelTitle.activeForeground": ["#E7E7E7", "#424242", "#FFFFFF"],
  "panelTitle.inactiveForeground": ["#E7E7E799", "#42424275", "#FFFFFF"],
  "panelTitle.activeBorder": ["#E7E7E7", "#424242", "#6FC3DF"],
  "tab.activeBackground": ["#1E1E1E", "#FFFFFF", "#000000"],
  "tab.activeForeground": ["#FFFFFF", "#333333", "#FFFFFF"],
  "tab.inactiveBackground": ["#2D2D2D", "#ECECEC", "#000000"],
  "tab.inactiveForeground": ["#FFFFFF80", "#33333380", "#FFFFFF"],
  "tab.border": ["#252526", "#F3F3F3", "#6FC3DF"],
  "menu.background": ["#252526", "#FFFFFF", "#000000"],
  "menu.foreground": ["#CCCCCC", "#616161", "#FFFFFF"],
  "menu.selectionBackground": ["#04395E", "#0060C0"],
  "menu.selectionForeground": ["#FFFFFF", "#FFFFFF"],
  "menu.separatorBackground": ["#606060", "#D4D4D4", "#6FC3DF"],
  "notifications.background": ["#252526", "#F3F3F3", "#0C141F"],
  "notifications.foreground": ["#CCCCCC", "#616161", "#FFFFFF"],
  "statusBar.background": ["#007ACC", "#007ACC", "#000000"],
  "statusBar.foreground": ["#FFFFFF", "#FFFFFF", "#FFFFFF"],
  "activityBar.background": ["#333333", "#2C2C2C", "#000000"],
  "activityBar.foreground": ["#FFFFFF", "#FFFFFF", "#FFFFFF"],
  "activityBarBadge.background": ["#007ACC", "#007ACC", "#000000"],
  "activityBarBadge.foreground": ["#FFFFFF", "#FFFFFF", "#FFFFFF"],
  "titleBar.activeBackground": ["#3C3C3C", "#DDDDDD", "#000000"],
  "titleBar.activeForeground": ["#CCCCCC", "#333333", "#FFFFFF"],
  "charts.foreground": ["#CCCCCC", "#616161", "#FFFFFF"],
  "charts.lines": ["#CCCCCC80", "#61616180", "#FFFFFF80"],
  "charts.red": ["#F14C4C", "#E51400"],
  "charts.blue": ["#3794FF", "#1A85FF"],
  "charts.yellow": ["#CCA700", "#BF8803"],
  "charts.orange": ["#D18616", "#D18616"],
  "charts.green": ["#89D185", "#388A34"],
  "charts.purple": ["#B180D7", "#652D90"],
  "gitDecoration.addedResourceForeground": ["#81B88B", "#587C0C"],
  "gitDecoration.modifiedResourceForeground": ["#E2C08D", "#895503"],
  "gitDecoration.deletedResourceForeground": ["#C74E39", "#AD0707"],
  "gitDecoration.untrackedResourceForeground": ["#73C991", "#007100"],
  "gitDecoration.ignoredResourceForeground": ["#8C8C8C", "#8E8E90"],
  "gitDecoration.conflictingResourceForeground": ["#E4676B", "#AD0707"],
  "terminal.background": ["#1E1E1E", "#FFFFFF", "#000000"],
  "terminal.foreground": ["#CCCCCC", "#333333", "#FFFFFF"],
  "toolbar.hoverBackground": ["#5A5D5E50", "#B8B8B850"],
  "keybindingLabel.background": ["#8080802B", "#DDDDDD66"],
  "keybindingLabel.foreground": ["#CCCCCC", "#555555", "#FFFFFF"],
  "keybindingLabel.border": ["#33333399", "#CCCCCC66", "#6FC3DF"],
};

/** "editor.background" → "--vscode-editor-background". */
export function cssVarName(key: string) {
  return `--vscode-${key.replace(/\./g, "-")}`;
}

function kindOf(uiTheme: string | undefined): Kind {
  return uiTheme === "hc-black" || uiTheme === "hc-light" ? "hc" : uiTheme === "vs" ? "light" : "dark";
}

export interface WebviewTheme {
  vars: Record<string, string>;
  /** body class: vscode-dark / vscode-light / vscode-high-contrast. */
  kind: "vscode-dark" | "vscode-light" | "vscode-high-contrast";
  themeId: string;
  colorScheme: "dark" | "light";
}

export function webviewTheme(): WebviewTheme {
  const active = useThemes.getState().active;
  const uiTheme = active?.uiTheme ?? "vs-dark";
  const kind = kindOf(uiTheme);
  const vars: Record<string, string> = {};
  for (const [key, [dark, light, hc]] of Object.entries(DEFAULTS)) vars[cssVarName(key)] = kind === "light" ? light : kind === "hc" ? (hc ?? dark) : dark;
  // The workbench's own (computed) colours, so hand-styled bases and partial themes match what is on screen.
  const cs = typeof document !== "undefined" ? getComputedStyle(document.querySelector(".tm-root") ?? document.documentElement) : null;
  const fromCss: [string, string][] = [
    ["foreground", "--foreground"],
    ["focusBorder", "--focus-border"],
    ["editor.background", "--editor-bg"],
    ["editor.foreground", "--editor-fg"],
    ["sideBar.background", "--sidebar-bg"],
    ["sideBar.foreground", "--sidebar-fg"],
    ["panel.background", "--panel-bg"],
    ["button.background", "--button-bg"],
    ["button.foreground", "--button-fg"],
    ["button.hoverBackground", "--button-hover-bg"],
    ["input.background", "--input-bg"],
    ["input.foreground", "--input-fg"],
    ["input.border", "--input-border"],
    ["list.hoverBackground", "--list-hover-bg"],
    ["list.activeSelectionBackground", "--list-active-bg"],
    ["list.activeSelectionForeground", "--list-active-fg"],
    ["textLink.foreground", "--link"],
    ["badge.background", "--badge-bg"],
    ["badge.foreground", "--badge-fg"],
  ];
  for (const [key, cssVar] of fromCss) {
    const v = cs?.getPropertyValue(cssVar).trim();
    if (v) vars[cssVarName(key)] = v;
  }
  for (const [key, value] of Object.entries(active?.resolved.colors ?? {})) {
    const v = normalizeHex(value);
    if (v) vars[cssVarName(key)] = v;
  }
  const s = useWorkbench.getState().settings;
  const mono = s["editor.fontFamily"] || 'Menlo, Monaco, "Courier New", monospace';
  vars["--vscode-font-family"] = '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif';
  vars["--vscode-font-weight"] = "normal";
  vars["--vscode-font-size"] = "13px";
  vars["--vscode-editor-font-family"] = mono;
  vars["--vscode-editor-font-weight"] = "normal";
  vars["--vscode-editor-font-size"] = `${s["editor.fontSize"] ?? 14}px`;
  vars["--monaco-monospace-font"] = mono;
  return {
    vars,
    kind: kind === "light" ? "vscode-light" : kind === "hc" ? "vscode-high-contrast" : "vscode-dark",
    themeId: active?.id ?? "dark-modern",
    colorScheme: kind === "light" ? "light" : "dark",
  };
}

/** A ThemeColor id ("charts.blue") as a CSS colour for the workbench (theme value, else VS Code's default). */
export function themeColor(id: string): string | undefined {
  const active = useThemes.getState().active;
  const v = normalizeHex(active?.resolved.colors[id]);
  if (v) return v;
  const d = DEFAULTS[id];
  if (!d) return undefined;
  const kind = kindOf(active?.uiTheme);
  return kind === "light" ? d[1] : kind === "hc" ? (d[2] ?? d[0]) : d[0];
}
