/**
 * The rest of the `vscode` module's classes and enums. Libraries such as
 * vscode-languageclient subclass or construct many of them while loading
 * (`class X extends vscode.CallHierarchyItem`), even for features TMCode
 * never calls, so they must exist as real values. Plain data classes are
 * implemented; enums carry VS Code's values.
 */

import type { Range, Position, ThemeIcon, Command, MarkdownString, TextEdit, SnippetString, WorkspaceEdit, Location } from "./types";
import type { Uri } from "./uri";

export class CallHierarchyItem {
  detail?: string;
  tags?: number[];
  constructor(
    public kind: number,
    public name: string,
    detail: string,
    public uri: Uri,
    public range: Range,
    public selectionRange: Range,
  ) {
    this.detail = detail;
  }
}

export class CallHierarchyIncomingCall {
  constructor(
    public from: CallHierarchyItem,
    public fromRanges: Range[],
  ) {}
}

export class CallHierarchyOutgoingCall {
  constructor(
    public to: CallHierarchyItem,
    public fromRanges: Range[],
  ) {}
}

export class TypeHierarchyItem {
  detail?: string;
  tags?: number[];
  constructor(
    public kind: number,
    public name: string,
    detail: string,
    public uri: Uri,
    public range: Range,
    public selectionRange: Range,
  ) {
    this.detail = detail;
  }
}

export class InlayHintLabelPart {
  tooltip?: string | MarkdownString;
  location?: Location;
  command?: Command;
  constructor(public value: string) {}
}

export class EvaluatableExpression {
  constructor(
    public range: Range,
    public expression?: string,
  ) {}
}

export class InlineValueText {
  constructor(
    public range: Range,
    public text: string,
  ) {}
}

export class InlineValueVariableLookup {
  constructor(
    public range: Range,
    public variableName?: string,
    public caseSensitiveLookup = true,
  ) {}
}

export class InlineValueEvaluatableExpression {
  constructor(
    public range: Range,
    public expression?: string,
  ) {}
}

export class InlineCompletionList {
  constructor(public items: unknown[]) {}
}

export class SemanticTokensEdit {
  constructor(
    public start: number,
    public deleteCount: number,
    public data?: Uint32Array,
  ) {}
}

export class SemanticTokensEdits {
  constructor(
    public edits: SemanticTokensEdit[],
    public resultId?: string,
  ) {}
}

export class DocumentDropOrPasteEditKind {
  static Empty = new DocumentDropOrPasteEditKind("");
  static Text = new DocumentDropOrPasteEditKind("text");
  static TextUpdateImports = new DocumentDropOrPasteEditKind("text.updateImports");
  constructor(readonly value: string) {}
  append(...parts: string[]) {
    return new DocumentDropOrPasteEditKind([this.value, ...parts].filter(Boolean).join("."));
  }
  intersects(other: DocumentDropOrPasteEditKind) {
    return this.contains(other) || other.contains(this);
  }
  contains(other: DocumentDropOrPasteEditKind) {
    return this.value === other.value || other.value.startsWith(this.value + ".");
  }
}

export class DocumentDropEdit {
  additionalEdit?: WorkspaceEdit;
  constructor(
    public insertText: string | SnippetString,
    public title?: string,
    public kind?: DocumentDropOrPasteEditKind,
  ) {}
}

export class DocumentPasteEdit {
  additionalEdit?: WorkspaceEdit;
  constructor(
    public insertText: string | SnippetString,
    public title: string,
    public kind: DocumentDropOrPasteEditKind,
  ) {}
}

export class DataTransferItem {
  constructor(public value: unknown) {}
  async asString() {
    return typeof this.value === "string" ? this.value : JSON.stringify(this.value);
  }
  asFile() {
    return undefined;
  }
}

export class DataTransfer {
  #items = new Map<string, DataTransferItem>();
  get(mimeType: string) {
    return this.#items.get(mimeType.toLowerCase());
  }
  set(mimeType: string, value: DataTransferItem) {
    this.#items.set(mimeType.toLowerCase(), value);
  }
  forEach(cb: (item: DataTransferItem, mime: string, dt: DataTransfer) => void) {
    for (const [m, i] of this.#items) cb(i, m, this);
  }
  *[Symbol.iterator]() {
    yield* this.#items;
  }
}

export class FileDecoration {
  propagate?: boolean;
  constructor(
    public badge?: string,
    public tooltip?: string,
    public color?: unknown,
  ) {}
}

export class TerminalLink {
  constructor(
    public startIndex: number,
    public length: number,
    public tooltip?: string,
  ) {}
}

export class TerminalProfile {
  constructor(public options: unknown) {}
}

export class QuickInputButtons {
  static Back = { iconPath: { id: "arrow-left" } as unknown as ThemeIcon };
}

export class NotebookRange {
  constructor(
    readonly start: number,
    readonly end: number,
  ) {}
  get isEmpty() {
    return this.start === this.end;
  }
  with(change: { start?: number; end?: number }) {
    return new NotebookRange(change.start ?? this.start, change.end ?? this.end);
  }
}

export class NotebookCellOutputItem {
  static text(value: string, mime = "text/plain") {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), mime);
  }
  static json(value: unknown, mime = "application/json") {
    return NotebookCellOutputItem.text(JSON.stringify(value), mime);
  }
  static stdout(value: string) {
    return NotebookCellOutputItem.text(value, "application/vnd.code.notebook.stdout");
  }
  static stderr(value: string) {
    return NotebookCellOutputItem.text(value, "application/vnd.code.notebook.stderr");
  }
  static error(value: Error) {
    return NotebookCellOutputItem.json({ name: value.name, message: value.message, stack: value.stack }, "application/vnd.code.notebook.error");
  }
  constructor(
    public data: Uint8Array,
    public mime: string,
  ) {}
}

export class NotebookCellOutput {
  constructor(
    public items: NotebookCellOutputItem[],
    public metadata?: Record<string, unknown>,
  ) {}
}

export class NotebookCellData {
  outputs?: NotebookCellOutput[];
  metadata?: Record<string, unknown>;
  constructor(
    public kind: number,
    public value: string,
    public languageId: string,
  ) {}
}

export class NotebookData {
  metadata?: Record<string, unknown>;
  constructor(public cells: NotebookCellData[]) {}
}

export class NotebookEdit {
  static replaceCells(range: NotebookRange, newCells: NotebookCellData[]) {
    return new NotebookEdit(range, newCells);
  }
  static insertCells(index: number, newCells: NotebookCellData[]) {
    return new NotebookEdit(new NotebookRange(index, index), newCells);
  }
  static deleteCells(range: NotebookRange) {
    return new NotebookEdit(range, []);
  }
  constructor(
    public range: NotebookRange,
    public newCells: NotebookCellData[],
  ) {}
}

export class NotebookCellStatusBarItem {
  constructor(
    public text: string,
    public alignment: number,
  ) {}
}

export class TaskGroup {
  static Clean = new TaskGroup("clean", "Clean");
  static Build = new TaskGroup("build", "Build");
  static Rebuild = new TaskGroup("rebuild", "Rebuild");
  static Test = new TaskGroup("test", "Test");
  isDefault?: boolean;
  constructor(
    readonly id: string,
    readonly label: string,
  ) {}
}

export class ProcessExecution {
  constructor(
    public process: string,
    public args?: string[] | unknown,
    public options?: unknown,
  ) {}
}

export class ShellExecution {
  constructor(
    public commandLine: unknown,
    public args?: unknown,
    public options?: unknown,
  ) {}
}

export class CustomExecution {
  constructor(public callback: unknown) {}
}

export class Task {
  group?: TaskGroup;
  presentationOptions: unknown = {};
  problemMatchers: string[] = [];
  isBackground = false;
  runOptions: unknown = {};
  constructor(
    public definition: unknown,
    public scope: unknown,
    public name: string,
    public source: string,
    public execution?: unknown,
    problemMatchers?: string | string[],
  ) {
    if (problemMatchers) this.problemMatchers = Array.isArray(problemMatchers) ? problemMatchers : [problemMatchers];
  }
}

export class Breakpoint {
  readonly id = Math.random().toString(36).slice(2);
  constructor(
    public enabled = true,
    public condition?: string,
    public hitCondition?: string,
    public logMessage?: string,
  ) {}
}

export class SourceBreakpoint extends Breakpoint {
  constructor(
    public location: Location,
    enabled?: boolean,
    condition?: string,
    hitCondition?: string,
    logMessage?: string,
  ) {
    super(enabled, condition, hitCondition, logMessage);
  }
}

export class FunctionBreakpoint extends Breakpoint {
  constructor(
    public functionName: string,
    enabled?: boolean,
    condition?: string,
    hitCondition?: string,
    logMessage?: string,
  ) {
    super(enabled, condition, hitCondition, logMessage);
  }
}

export class DebugAdapterExecutable {
  constructor(
    public command: string,
    public args: string[] = [],
    public options?: unknown,
  ) {}
}

export class DebugAdapterServer {
  constructor(
    public port: number,
    public host?: string,
  ) {}
}

export class DebugAdapterNamedPipeServer {
  constructor(public path: string) {}
}

export class DebugAdapterInlineImplementation {
  constructor(public implementation: unknown) {}
}

export class TestTag {
  constructor(readonly id: string) {}
}

export class TestMessage {
  static diff(message: string | MarkdownString, expected: string, actual: string) {
    const m = new TestMessage(message);
    m.expectedOutput = expected;
    m.actualOutput = actual;
    return m;
  }
  expectedOutput?: string;
  actualOutput?: string;
  location?: Location;
  constructor(public message: string | MarkdownString) {}
}

export class TestRunRequest {
  constructor(
    readonly include?: unknown[],
    readonly exclude?: unknown[],
    readonly profile?: unknown,
    readonly continuous?: boolean,
  ) {}
}

export class TabInputTextDiff {
  constructor(
    readonly original: Uri,
    readonly modified: Uri,
  ) {}
}

export class TabInputCustom {
  constructor(
    readonly uri: Uri,
    readonly viewType: string,
  ) {}
}

export class TabInputWebview {
  constructor(readonly viewType: string) {}
}

export class TabInputNotebook {
  constructor(
    readonly uri: Uri,
    readonly notebookType: string,
  ) {}
}

export class TabInputTerminal {}

export class TelemetryTrustedValue<T = unknown> {
  constructor(readonly value: T) {}
}

export class TextMerge {}

export class LanguageModelError extends Error {}

/** Enums with VS Code's values. */
export const enums = {
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  TaskScope: { Global: 1, Workspace: 2 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
  ShellQuoting: { Escape: 1, Strong: 2, Weak: 3 },
  CommentMode: { Editing: 0, Preview: 1 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  CommentThreadState: { Unresolved: 0, Resolved: 1 },
  NotebookCellKind: { Markup: 1, Code: 2 },
  NotebookEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  NotebookCellStatusBarAlignment: { Left: 1, Right: 2 },
  NotebookControllerAffinity: { Default: 1, Preferred: 2 },
  DebugConsoleMode: { Separate: 0, MergeWithParent: 1 },
  DebugConfigurationProviderTriggerKind: { Initial: 1, Dynamic: 2 },
  TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
  InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
  TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
  TerminalLocation: { Panel: 1, Editor: 2 },
  TerminalShellExecutionCommandLineConfidence: { Low: 0, Medium: 1, High: 2 },
  DocumentPasteTriggerKind: { Automatic: 0, PasteAs: 1 },
  SyntaxTokenType: { Other: 0, Comment: 1, String: 2, RegEx: 3 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  ChatResultFeedbackKind: { Unhelpful: 0, Helpful: 1 },
  PortAutoForwardAction: { Notify: 1, OpenBrowser: 2, OpenPreview: 3, Silent: 4, Ignore: 5 },
  NotebookCellExecutionState: { Idle: 1, Pending: 2, Executing: 3 },
  ExtensionRuntime: { Node: 1, Webworker: 2 },
} as const;

/** Unused in TMCode but referenced by type in libraries: keep TS happy about imports. */
export type _Unused = Position | TextEdit;
