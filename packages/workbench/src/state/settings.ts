/**
 * User settings, described once so the Settings editor, the store and Monaco
 * all read the same definitions (ids match VS Code's where one exists).
 */

/**
 * A colour theme id: a built-in ("dark-modern", "light-modern", "dark-hc",
 * "dark-plus", …; themes/themeService.ts) or one contributed by an extension
 * ("ext:<publisher.name>:<theme id>").
 */
export type ThemeId = string;

export interface Settings {
  "workbench.colorTheme": ThemeId;
  /** File icon theme: "tmcode" (built-in glyphs), "none", or "ext:<publisher.name>:<id>". */
  "workbench.iconTheme": string;
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
  /** Shell profile id for new terminals ("zsh", "bash", "pwsh", "cmd", "gitbash", "wsl"…); "" = the system's shell. */
  "terminal.integrated.defaultProfile": string;
  "workbench.reduceMotion": boolean;
  /** "default": check at start and every 6 hours; "manual": only from the command; "none": never. */
  "update.mode": "default" | "manual" | "none";
  /**
   * Task Mentor projects: save automatically. "assignments" (default): assignment and
   * quiz-practical workspaces 30 s after the last file save and on leaving the window,
   * personal projects never; "onSave"/"interval": every project; "off": never.
   */
  "projects.autoSave": "off" | "assignments" | "onSave" | "interval";
  /** Share live status (open file, unsaved files, sync) with Task Mentor while a project is open. */
  "projects.presence": boolean;
  // ── Run hub ──
  /** Live preview refresh: while typing, or only when a file is saved. */
  "livePreview.updateOn": "onType" | "onSave";
  /** An open live preview switches to the HTML file being edited. */
  "livePreview.followActiveFile": boolean;
  /** Dev servers open in the built-in browser beside the editor once they print their address. */
  "run.openBrowserOnStart": boolean;
  // ── files, search, accessibility (feat/files-search) ──
  /** Comma-separated globs hidden from the Explorer and Search (VS Code's files.exclude). */
  "files.exclude": string;
  /** Comma-separated globs left out of Search and Go to File. */
  "search.exclude": string;
  /** Search skips what .gitignore files ignore. */
  "search.useIgnoreFiles": boolean;
  /** Folders with a single folder inside show on one row (src/main/java). */
  "explorer.compactFolders": boolean;
  /** The Explorer shows and selects the active file. */
  "explorer.autoReveal": boolean;
  /** Screen reader mode for the editor. */
  "editor.accessibilitySupport": "auto" | "on" | "off";
  /** Whole-window zoom: 0 is 100 %, each step is 20 % (VS Code's window.zoomLevel). */
  "window.zoomLevel": number;
  /** User keybindings: command id → key ("mod+shift+k"; "" removes the key). Edited in Keyboard Shortcuts. */
  "keybindings.user": Record<string, string>;
  // ── layout toggles (View › Appearance) ──
  /** Activity bar shown (Toggle Activity Bar Visibility). */
  "workbench.activityBar.visible": boolean;
  /** Status bar shown (Toggle Status Bar Visibility). */
  "workbench.statusBar.visible": boolean;
  /** Breadcrumbs above the editor (Toggle Breadcrumbs). */
  "breadcrumbs.enabled": boolean;
  /** Primary side bar on the left or the right (Toggle Primary Side Bar Position). */
  "workbench.sideBar.location": "left" | "right";
}

export const DEFAULT_SETTINGS: Settings = {
  "workbench.colorTheme": "dark-modern",
  "workbench.iconTheme": "tmcode",
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
  "terminal.integrated.defaultProfile": "",
  "workbench.reduceMotion": false,
  "update.mode": "default",
  "projects.autoSave": "assignments",
  "projects.presence": true,
  "livePreview.updateOn": "onType",
  "livePreview.followActiveFile": false,
  "run.openBrowserOnStart": true,
  "files.exclude": "**/.git, **/.svn, **/.hg, **/.DS_Store, **/Thumbs.db",
  "search.exclude": "**/node_modules, **/__pycache__, **/.venv, **/venv, **/dist, **/build, **/target",
  "search.useIgnoreFiles": true,
  "explorer.compactFolders": true,
  "explorer.autoReveal": true,
  "editor.accessibilitySupport": "auto",
  "window.zoomLevel": 0,
  "keybindings.user": {},
  "workbench.activityBar.visible": true,
  "workbench.statusBar.visible": true,
  "breadcrumbs.enabled": true,
  "workbench.sideBar.location": "left",
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
      /** Options computed when shown (themes from installed extensions, shells found on this computer). */
      dynamicOptions?: "colorThemes" | "iconThemes" | "terminalProfiles";
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
        dynamicOptions: "colorThemes",
      },
      {
        key: "workbench.iconTheme",
        label: "File Icon Theme",
        description: "Specifies the file icon theme used in the workbench, or 'None' to not show any file icons.",
        type: "enum",
        options: [
          { value: "tmcode", label: "TMCode Glyphs" },
          { value: "none", label: "None" },
        ],
        dynamicOptions: "iconThemes",
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
    title: "Projects",
    settings: [
      {
        key: "projects.autoSave",
        label: "Projects: Auto Save to Task Mentor",
        description: "Save Task Mentor projects automatically. GitHub projects always use git push.",
        type: "enum",
        options: [
          { value: "assignments", label: "assignments (assignment work 30 s after each file save and when you leave the window; personal projects yourself)" },
          { value: "off", label: "off (Save to Task Mentor yourself)" },
          { value: "onSave", label: "onSave (after each file save)" },
          { value: "interval", label: "interval (every 5 minutes)" },
        ],
      },
      {
        key: "projects.presence",
        label: "Projects: Share Live Status",
        description: "Let Task Mentor show that the project is open, which file you are editing and whether it is synced.",
        type: "boolean",
      },
    ],
  },
  {
    title: "Run",
    settings: [
      {
        key: "livePreview.updateOn",
        label: "Live Preview: Update On",
        description: "Refresh the live preview as you type, or only when a file is saved. The scroll position is kept.",
        type: "enum",
        options: [
          { value: "onType", label: "onType (as you type)" },
          { value: "onSave", label: "onSave (when a file is saved)" },
        ],
      },
      {
        key: "livePreview.followActiveFile",
        label: "Live Preview: Follow Active HTML File",
        description: "An open live preview shows whichever HTML file you are editing.",
        type: "boolean",
      },
      {
        key: "run.openBrowserOnStart",
        label: "Run: Open Browser When a Dev Server Starts",
        description: "Open the built-in browser beside the editor as soon as a dev server (Vite, Next, Spring, Django…) prints its address.",
        type: "boolean",
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
      {
        key: "terminal.integrated.defaultProfile",
        label: "Default Profile",
        description: "The shell new terminals start. Other shells are in the terminal's ⌄ menu.",
        type: "enum",
        options: [{ value: "", label: "Automatic (the system's shell)" }],
        dynamicOptions: "terminalProfiles",
      },
    ],
  },
  {
    title: "Files and Search",
    settings: [
      { key: "files.exclude", label: "Files: Exclude", description: "Glob patterns hidden from the Explorer and Search, separated by commas.", type: "string" },
      { key: "search.exclude", label: "Search: Exclude", description: "Glob patterns left out of Search and Go to File, separated by commas.", type: "string" },
      { key: "search.useIgnoreFiles", label: "Search: Use Ignore Files", description: "Search skips files that .gitignore ignores.", type: "boolean" },
      { key: "explorer.compactFolders", label: "Explorer: Compact Folders", description: "Show a folder that holds only one folder on a single row.", type: "boolean" },
      { key: "explorer.autoReveal", label: "Explorer: Auto Reveal", description: "Show and select the active file in the Explorer.", type: "boolean" },
    ],
  },
  {
    title: "Accessibility",
    settings: [
      {
        key: "editor.accessibilitySupport",
        label: "Editor: Accessibility Support",
        description: "Optimise the editor for screen readers.",
        type: "enum",
        options: [
          { value: "auto", label: "auto (detect a screen reader)" },
          { value: "on", label: "on" },
          { value: "off", label: "off" },
        ],
      },
      { key: "window.zoomLevel", label: "Window: Zoom Level", description: "Zoom the whole window. 0 is 100 %, each step is 20 %.", type: "number", min: -5, max: 8 },
    ],
  },
];

export function defaultFontFamily(os: "mac" | "windows" | "linux") {
  if (os === "mac") return "Menlo, Monaco, 'Courier New', monospace";
  if (os === "windows") return "Consolas, 'Courier New', monospace";
  return "'Droid Sans Mono', 'monospace', monospace";
}
