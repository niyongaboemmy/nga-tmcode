/**
 * User settings, described once so the Settings editor, the store and Monaco
 * all read the same definitions (ids match VS Code's where one exists).
 */

export type ThemeId = "dark-modern" | "light-modern" | "dark-hc";

export interface Settings {
  "workbench.colorTheme": ThemeId;
  "editor.fontSize": number;
  "editor.fontFamily": string;
  "editor.tabSize": number;
  "editor.insertSpaces": boolean;
  "editor.wordWrap": "off" | "on";
  "editor.minimap.enabled": boolean;
  "editor.lineNumbers": "on" | "off" | "relative";
  "editor.renderWhitespace": "none" | "boundary" | "selection" | "all";
  "editor.cursorBlinking": "blink" | "smooth" | "phase" | "expand" | "solid";
  "editor.bracketPairColorization.enabled": boolean;
  "editor.stickyScroll.enabled": boolean;
  "editor.formatOnSave": boolean;
  "files.autoSave": "off" | "afterDelay" | "onFocusChange";
  "files.autoSaveDelay": number;
  "terminal.integrated.fontSize": number;
  "workbench.reduceMotion": boolean;
  /** "default": check at start and every 6 hours; "manual": only from the command; "none": never. */
  "update.mode": "default" | "manual" | "none";
}

export const DEFAULT_SETTINGS: Settings = {
  "workbench.colorTheme": "dark-modern",
  "editor.fontSize": 14,
  "editor.fontFamily": "",
  "editor.tabSize": 4,
  "editor.insertSpaces": true,
  "editor.wordWrap": "off",
  "editor.minimap.enabled": true,
  "editor.lineNumbers": "on",
  "editor.renderWhitespace": "selection",
  "editor.cursorBlinking": "smooth",
  "editor.bracketPairColorization.enabled": true,
  "editor.stickyScroll.enabled": true,
  "editor.formatOnSave": false,
  "files.autoSave": "afterDelay",
  "files.autoSaveDelay": 1000,
  "terminal.integrated.fontSize": 13,
  "workbench.reduceMotion": false,
  "update.mode": "default",
};

export type SettingKey = keyof Settings;

export type SettingDef =
  | { key: SettingKey; label: string; description: string; type: "number"; min: number; max: number }
  | { key: SettingKey; label: string; description: string; type: "string"; placeholder?: string }
  | { key: SettingKey; label: string; description: string; type: "boolean" }
  | {
      key: SettingKey;
      label: string;
      description: string;
      type: "enum";
      options: { value: string; label: string }[];
    };

export const SETTING_SECTIONS: { title: string; settings: SettingDef[] }[] = [
  {
    title: "Appearance",
    settings: [
      {
        key: "workbench.colorTheme",
        label: "Color Theme",
        description: "Specifies the color theme used in the workbench.",
        type: "enum",
        options: [
          { value: "dark-modern", label: "Dark Modern" },
          { value: "light-modern", label: "Light Modern" },
          { value: "dark-hc", label: "Dark High Contrast" },
        ],
      },
      {
        key: "workbench.reduceMotion",
        label: "Reduce Motion",
        description: "Turns off animations in the workbench and the editor.",
        type: "boolean",
      },
    ],
  },
  {
    title: "Text Editor",
    settings: [
      { key: "editor.fontSize", label: "Font Size", description: "Controls the font size in pixels.", type: "number", min: 8, max: 40 },
      {
        key: "editor.fontFamily",
        label: "Font Family",
        description: "Controls the font family. Leave empty for the platform default.",
        type: "string",
        placeholder: "Menlo, Consolas, monospace",
      },
      { key: "editor.tabSize", label: "Tab Size", description: "The number of spaces a tab is equal to.", type: "number", min: 1, max: 8 },
      { key: "editor.insertSpaces", label: "Insert Spaces", description: "Insert spaces when pressing Tab.", type: "boolean" },
      {
        key: "editor.wordWrap",
        label: "Word Wrap",
        description: "Controls how lines should wrap.",
        type: "enum",
        options: [
          { value: "off", label: "off" },
          { value: "on", label: "on" },
        ],
      },
      {
        key: "editor.lineNumbers",
        label: "Line Numbers",
        description: "Controls the display of line numbers.",
        type: "enum",
        options: [
          { value: "on", label: "on" },
          { value: "relative", label: "relative" },
          { value: "off", label: "off" },
        ],
      },
      {
        key: "editor.renderWhitespace",
        label: "Render Whitespace",
        description: "Controls how the editor should render whitespace characters.",
        type: "enum",
        options: [
          { value: "none", label: "none" },
          { value: "boundary", label: "boundary" },
          { value: "selection", label: "selection" },
          { value: "all", label: "all" },
        ],
      },
      {
        key: "editor.cursorBlinking",
        label: "Cursor Blinking",
        description: "Control the cursor animation style.",
        type: "enum",
        options: ["blink", "smooth", "phase", "expand", "solid"].map((v) => ({ value: v, label: v })),
      },
      { key: "editor.minimap.enabled", label: "Minimap", description: "Controls whether the minimap is shown.", type: "boolean" },
      {
        key: "editor.bracketPairColorization.enabled",
        label: "Bracket Pair Colorization",
        description: "Controls whether bracket pair colorization is enabled.",
        type: "boolean",
      },
      {
        key: "editor.stickyScroll.enabled",
        label: "Sticky Scroll",
        description: "Shows the nested current scopes during the scroll at the top of the editor.",
        type: "boolean",
      },
      { key: "editor.formatOnSave", label: "Format On Save", description: "Format a file on save (where a formatter is available).", type: "boolean" },
    ],
  },
  {
    title: "Files",
    settings: [
      {
        key: "files.autoSave",
        label: "Auto Save",
        description: "Controls auto save of editors that have unsaved changes.",
        type: "enum",
        options: [
          { value: "off", label: "off" },
          { value: "afterDelay", label: "afterDelay" },
          { value: "onFocusChange", label: "onFocusChange" },
        ],
      },
      {
        key: "files.autoSaveDelay",
        label: "Auto Save Delay",
        description: "Controls the delay in milliseconds after which an editor with unsaved changes is saved automatically.",
        type: "number",
        min: 200,
        max: 60000,
      },
    ],
  },
  {
    title: "Application",
    settings: [
      {
        key: "update.mode",
        label: "Update: Mode",
        description: "Configure whether TMCode checks for updates automatically. Updates are signed and never install during an exam.",
        type: "enum",
        options: [
          { value: "default", label: "default (check automatically)" },
          { value: "manual", label: "manual (Help › Check for Updates)" },
          { value: "none", label: "none" },
        ],
      },
    ],
  },
  {
    title: "Terminal",
    settings: [
      {
        key: "terminal.integrated.fontSize",
        label: "Font Size",
        description: "Controls the font size in pixels of the terminal.",
        type: "number",
        min: 8,
        max: 32,
      },
    ],
  },
];

export function defaultFontFamily(os: "mac" | "windows" | "linux") {
  if (os === "mac") return "Menlo, Monaco, 'Courier New', monospace";
  if (os === "windows") return "Consolas, 'Courier New', monospace";
  return "'Droid Sans Mono', 'monospace', monospace";
}
