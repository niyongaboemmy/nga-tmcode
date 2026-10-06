/**
 * The wire contract between the workbench (main thread) and the extension
 * host. Documents and resources are identified by workspace-relative paths
 * ("src/app.js"), as everywhere else in the workbench; the host turns them
 * into `file:` URIs under the workspace folder. Ranges are 0-based
 * [startLine, startCharacter, endLine, endCharacter], as in the vscode API.
 *
 * Main → host methods start with "$" and are handled by the host; host →
 * main methods start with "$main." and are handled by the workbench.
 */

export type RangeDTO = [number, number, number, number];
export type PositionDTO = [number, number];

export interface ExtensionDescription {
  id: string;
  name: string;
  publisher: string;
  displayName: string;
  version: string;
  /** Node host: absolute folder of the unpacked extension. Worker host: the id (files come over RPC). */
  location: string;
  /** Entry module, relative to `location` ("./out/extension.js"); `browser` for a Worker host. */
  entry: string;
  activationEvents: string[];
  /** package.json as parsed JSON (`packageJSON` of vscode.Extension). */
  manifest: Record<string, unknown>;
}

export interface DocumentDTO {
  path: string;
  languageId: string;
  version: number;
  text: string;
  eol: "\n" | "\r\n";
  isDirty: boolean;
}

export interface ContentChangeDTO {
  range: RangeDTO;
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export interface SelectionDTO {
  anchor: PositionDTO;
  active: PositionDTO;
}

export interface EditorDTO {
  id: string;
  path: string;
  selections: SelectionDTO[];
  visibleRanges: RangeDTO[];
  options: { tabSize: number; insertSpaces: boolean };
  viewColumn: number;
}

export interface InitData {
  hostKind: "node" | "worker";
  extensions: ExtensionDescription[];
  workspace: { name: string; root: string } | null;
  configuration: { defaults: Record<string, unknown>; user: Record<string, unknown> };
  /** Persisted Memento values: extension id → key → value. */
  state: { global: Record<string, Record<string, unknown>>; workspace: Record<string, Record<string, unknown>> };
  env: {
    appName: string;
    appRoot: string;
    appHost: string;
    language: string;
    machineId: string;
    sessionId: string;
    uiKind: 1 | 2;
    shell: string;
    version: string;
    /** Node host: folder for globalStorageUri / storageUri (per extension, created on demand by the extension). */
    storagePath?: string;
    /** Workspace storage key (a hash of the folder path). */
    workspaceKey?: string;
    os: "mac" | "windows" | "linux";
    /** Origin of webview pages and resources ("tmwebview://localhost"); `asWebviewUri` builds on it. */
    webviewBase?: string;
    /** `webview.cspSource`. */
    webviewCspSource?: string;
  };
  documents: DocumentDTO[];
  editors: EditorDTO[];
  activeEditor: string | null;
  languages: string[];
}

export interface MarkdownDTO {
  value: string;
  isTrusted?: boolean;
  supportThemeIcons?: boolean;
  supportHtml?: boolean;
}

export interface TextEditDTO {
  range: RangeDTO;
  text: string;
  /** 1 = LF, 2 = CRLF (TextEdit.setEndOfLine). */
  eol?: 1 | 2;
  /** The text is a snippet (SnippetTextEdit). */
  snippet?: boolean;
}

export interface CommandDTO {
  command: string;
  title: string;
  tooltip?: string;
  /** The host keeps the real arguments; run it with $executeCachedCommand(ref). */
  ref: number;
}

export type CompletionItemLabelDTO = string | { label: string; detail?: string; description?: string };

export interface CompletionItemDTO {
  i: number;
  label: CompletionItemLabelDTO;
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: MarkdownDTO | string;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText: string;
  snippet?: boolean;
  keepWhitespace?: boolean;
  range?: RangeDTO | { insert: RangeDTO; replace: RangeDTO };
  commitCharacters?: string[];
  additionalTextEdits?: TextEditDTO[];
  command?: CommandDTO;
}

export interface CompletionListDTO {
  /** Cache id for resolveCompletionItem (released with $releaseCache). */
  cacheId: number;
  incomplete: boolean;
  items: CompletionItemDTO[];
}

export interface LocationDTO {
  /** Workspace-relative path, or null for a resource outside the workspace. */
  path: string | null;
  uri: string;
  range: RangeDTO;
  /** LocationLink extras. */
  targetSelectionRange?: RangeDTO;
  originSelectionRange?: RangeDTO;
}

export interface DiagnosticDTO {
  range: RangeDTO;
  message: string;
  /** vscode.DiagnosticSeverity: 0 error … 3 hint. */
  severity: number;
  source?: string;
  code?: string | number;
  codeTarget?: string;
  tags?: number[];
  related?: { path: string | null; range: RangeDTO; message: string }[];
}

export type WorkspaceEditEntryDTO =
  | { kind: "text"; path: string; edit: TextEditDTO }
  | { kind: "create"; path: string; options?: { overwrite?: boolean; ignoreIfExists?: boolean }; contents?: string }
  | { kind: "delete"; path: string; options?: { recursive?: boolean; ignoreIfNotExists?: boolean } }
  | { kind: "rename"; path: string; to: string; options?: { overwrite?: boolean; ignoreIfExists?: boolean } };

export interface WorkspaceEditDTO {
  entries: WorkspaceEditEntryDTO[];
}

export interface CodeActionDTO {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabled?: string;
  diagnostics?: DiagnosticDTO[];
  edit?: WorkspaceEditDTO;
  command?: CommandDTO;
}

export interface DocumentSymbolDTO {
  name: string;
  detail: string;
  kind: number;
  tags?: number[];
  range: RangeDTO;
  selectionRange: RangeDTO;
  containerName?: string;
  children?: DocumentSymbolDTO[];
}

export interface HoverDTO {
  contents: MarkdownDTO[];
  range?: RangeDTO;
}

export interface SignatureHelpDTO {
  signatures: { label: string; documentation?: MarkdownDTO | string; parameters: { label: string | [number, number]; documentation?: MarkdownDTO | string }[]; activeParameter?: number }[];
  activeSignature: number;
  activeParameter: number;
}

/** A document selector entry as the extension gave it (strings become {language}). */
export interface SelectorDTO {
  language?: string;
  scheme?: string;
  pattern?: string;
  notebookType?: string;
}

export type ProviderKind =
  | "completion"
  | "hover"
  | "definition"
  | "declaration"
  | "typeDefinition"
  | "implementation"
  | "references"
  | "documentSymbol"
  | "codeAction"
  | "formatting"
  | "rangeFormatting"
  | "onTypeFormatting"
  | "color"
  | "documentHighlight"
  | "documentLink"
  | "foldingRange"
  | "signatureHelp"
  | "rename"
  | "inlayHints"
  | "codeLens"
  | "linkedEditing"
  | "selectionRange";

export interface ProviderMeta {
  triggerCharacters?: string[];
  retriggerCharacters?: string[];
  /** onTypeFormatting: the first trigger character, then more. */
  moreTriggerCharacters?: string[];
  providedCodeActionKinds?: string[];
  displayName?: string;
  extensionId: string;
  /** codeLens: the provider implements resolveCodeLens. */
  resolve?: boolean;
}

export interface StatusBarEntryDTO {
  id: string;
  extensionId: string;
  name?: string;
  text: string;
  tooltip?: string;
  command?: CommandDTO;
  color?: string;
  backgroundColor?: string;
  alignment: 1 | 2;
  priority: number;
  visible: boolean;
  /** Only shown while the active editor matches (LanguageStatusItem). */
  selector?: SelectorDTO[];
}

export interface QuickPickItemDTO {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  alwaysShow?: boolean;
  separator?: boolean;
  iconPath?: string;
}

export interface DecorationOptionsDTO {
  backgroundColor?: string;
  color?: string;
  border?: string;
  borderColor?: string;
  borderRadius?: string;
  borderStyle?: string;
  borderWidth?: string;
  outline?: string;
  outlineColor?: string;
  fontStyle?: string;
  fontWeight?: string;
  textDecoration?: string;
  cursor?: string;
  opacity?: string;
  letterSpacing?: string;
  isWholeLine?: boolean;
  overviewRulerColor?: string;
  overviewRulerLane?: number;
  before?: { contentText?: string; color?: string; margin?: string; fontStyle?: string; fontWeight?: string; backgroundColor?: string; textDecoration?: string };
  after?: { contentText?: string; color?: string; margin?: string; fontStyle?: string; fontWeight?: string; backgroundColor?: string; textDecoration?: string };
  rangeBehavior?: number;
  light?: Omit<DecorationOptionsDTO, "light" | "dark">;
  dark?: Omit<DecorationOptionsDTO, "light" | "dark">;
}

export interface DecorationRangeDTO {
  range: RangeDTO;
  hoverMessage?: MarkdownDTO[];
  renderOptions?: { before?: DecorationOptionsDTO["before"]; after?: DecorationOptionsDTO["after"] };
}

export type ExtensionRuntimeState = "activating" | "activated" | "failed";

export interface ExtensionStateDTO {
  id: string;
  state: ExtensionRuntimeState;
  /** What activated it ("onCommand:x", "*"). */
  reason?: string;
  /** Milliseconds: require + activate(). */
  activationTime?: number;
  error?: string;
}

export interface FileStatDTO {
  type: number;
  ctime: number;
  mtime: number;
  size: number;
}

// ───────────── views (contributes.views): tree views and webviews ─────────────

/** An icon: a codicon (ThemeIcon), or images per theme kind (resource references, see ResourceRefDTO). */
export type IconDTO = { codicon: string; color?: string } | { light: ResourceRefDTO; dark: ResourceRefDTO };

/** An image the workbench loads: a file of an extension, a workspace file, or a data:/https: URL. */
export type ResourceRefDTO = { ext: string; path: string } | { ws: string } | { url: string };

export interface TreeItemDTO {
  /** Stable while the element lives ("1/<id>" for items with an id, else parent/index:label). */
  handle: string;
  label: string;
  /** TreeItemLabel.highlights: [start, end) offsets into `label`. */
  highlights?: [number, number][];
  description?: string;
  tooltip?: string | MarkdownDTO;
  icon?: IconDTO;
  /** resourceUri: drives the file icon (icon theme) and the default label/description. */
  resource?: { path: string | null; name: string; folder: boolean };
  /** 0 none, 1 collapsed, 2 expanded. */
  collapsible: 0 | 1 | 2;
  /** The item has a command (run with $treeCommand). */
  command?: { title: string; tooltip?: string };
  contextValue?: string;
  checkbox?: { checked: boolean; tooltip?: string };
  /** The provider implements resolveTreeItem (tooltip on hover). */
  resolvable?: boolean;
}

export interface TreeViewOptionsDTO {
  extensionId: string;
  canSelectMany: boolean;
  showCollapseAll: boolean;
  manageCheckboxStateManually: boolean;
}

export interface ViewBadgeDTO {
  value: number;
  tooltip?: string;
}

/** title / description / message / badge of a TreeView or WebviewView (undefined keeps the contributed one). */
export interface ViewMetaDTO {
  title?: string;
  description?: string;
  message?: string;
  badge?: ViewBadgeDTO | null;
}

export interface WebviewOptionsDTO {
  enableScripts: boolean;
  enableForms: boolean;
  enableCommandUris: boolean | string[];
  /** Absolute folders (Node host) or URIs (Web Worker host) asWebviewUri may serve. */
  localResourceRoots: string[];
  retainContextWhenHidden: boolean;
}

export interface WebviewCreateDTO {
  kind: "panel" | "view";
  extensionId: string;
  /** Panel: its viewType; view: the contributed view id. */
  viewType: string;
  title?: string;
  options: WebviewOptionsDTO;
  /** Panel: ViewColumn (-2 Beside, -1 Active, 1…). */
  viewColumn?: number;
  preserveFocus?: boolean;
  iconPath?: IconDTO;
}
