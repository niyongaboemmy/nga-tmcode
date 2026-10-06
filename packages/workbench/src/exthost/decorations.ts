import type { DecorationOptionsDTO, DecorationRangeDTO } from "@tmcode/exthost";
import { monaco } from "../monaco/setup";
import { onCodeEditor } from "../monaco/editors";
import { fromRange } from "./documentSync";

/**
 * `window.createTextEditorDecorationType` / `TextEditor.setDecorations`
 * (basic): colours, borders, font style, whole-line backgrounds, overview
 * ruler marks and before/after text, as CSS classes on Monaco decorations.
 */

interface DecoType {
  options: DecorationOptionsDTO;
  className?: string;
  beforeClass?: string;
  afterClass?: string;
}

type Attachment = DecorationOptionsDTO["before"];

const types = new Map<string, DecoType>();
let sheet: HTMLStyleElement | null = null;
const rules = new Map<string, string>();
/** editor → decoration type key → collection. */
const collections = new WeakMap<monaco.editor.ICodeEditor, Map<string, monaco.editor.IEditorDecorationsCollection>>();
const editors = new Set<monaco.editor.ICodeEditor>();
let wired = false;
let uniq = 0;

const clean = (v: string) => v.replace(/[;{}<>]/g, "");

function css(o: Omit<DecorationOptionsDTO, "light" | "dark"> | undefined): string {
  if (!o) return "";
  const decl: string[] = [];
  const add = (prop: string, v: string | undefined) => v && decl.push(`${prop}:${clean(v)}`);
  add("background-color", o.backgroundColor);
  add("color", o.color);
  add("border", o.border);
  add("border-color", o.borderColor);
  add("border-radius", o.borderRadius);
  add("border-style", o.borderStyle);
  add("border-width", o.borderWidth);
  add("outline", o.outline);
  add("outline-color", o.outlineColor);
  add("font-style", o.fontStyle);
  add("font-weight", o.fontWeight);
  add("text-decoration", o.textDecoration);
  add("cursor", o.cursor);
  add("opacity", o.opacity);
  add("letter-spacing", o.letterSpacing);
  return decl.join(";");
}

function attachmentCss(a: Attachment): string {
  if (!a) return "";
  const decl: string[] = [];
  if (a.contentText !== undefined) decl.push(`content:${JSON.stringify(a.contentText)}`);
  const add = (prop: string, v: string | undefined) => v && decl.push(`${prop}:${clean(v)}`);
  add("color", a.color);
  add("margin", a.margin);
  add("font-style", a.fontStyle);
  add("font-weight", a.fontWeight);
  add("background-color", a.backgroundColor);
  add("text-decoration", a.textDecoration);
  return decl.join(";");
}

function writeSheet() {
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.dataset.tmcode = "extension-decorations";
    document.head.appendChild(sheet);
  }
  sheet.textContent = [...rules.values()].join("\n");
}

export function createDecorationType(key: string, options: DecorationOptionsDTO) {
  const safe = key.replace(/[^\w-]/g, "");
  const t: DecoType = { options };
  const base = css(options);
  const dark = css(options.dark);
  const light = css(options.light);
  if (base || dark || light) {
    t.className = safe;
    rules.set(key, [base && `.monaco-editor .${safe}{${base}}`, dark && `.tm-root:not([data-theme^="light"]) .monaco-editor .${safe}{${dark}}`, light && `.tm-root[data-theme^="light"] .monaco-editor .${safe}{${light}}`].filter(Boolean).join("\n"));
  }
  const before = attachmentCss(options.before);
  const after = attachmentCss(options.after);
  if (before) {
    t.beforeClass = `${safe}-before`;
    rules.set(`${key}:before`, `.monaco-editor .${t.beforeClass}::before{${before}}`);
  }
  if (after) {
    t.afterClass = `${safe}-after`;
    rules.set(`${key}:after`, `.monaco-editor .${t.afterClass}::after{${after}}`);
  }
  types.set(key, t);
  writeSheet();
}

export function disposeDecorationType(key: string) {
  types.delete(key);
  for (const k of [...rules.keys()]) if (k === key || k.startsWith(`${key}:`)) rules.delete(k);
  writeSheet();
  for (const ed of editors) {
    const map = collections.get(ed);
    map?.get(key)?.clear();
    map?.delete(key);
  }
}

function wire() {
  if (wired) return;
  wired = true;
  onCodeEditor((ed) => {
    editors.add(ed);
    // Decorations belong to an editor's current document, as in VS Code.
    ed.onDidChangeModel(() => {
      collections.get(ed)?.forEach((c) => c.clear());
      collections.delete(ed);
    });
    ed.onDidDispose(() => editors.delete(ed));
  });
}

export function setDecorations(targets: monaco.editor.ICodeEditor[], key: string, ranges: DecorationRangeDTO[]) {
  wire();
  const t = types.get(key);
  if (!t) return;
  const o = t.options;
  for (const ed of targets) {
    editors.add(ed);
    let map = collections.get(ed);
    if (!map) collections.set(ed, (map = new Map()));
    const decos: monaco.editor.IModelDeltaDecoration[] = ranges.map((r) => {
      let beforeClass = t.beforeClass;
      let afterClass = t.afterClass;
      // Per-range before/after text (renderOptions) gets its own small rule.
      if (r.renderOptions?.before || r.renderOptions?.after) {
        const id = `${key.replace(/[^\w-]/g, "")}-r${++uniq % 5000}`;
        if (r.renderOptions.before) {
          beforeClass = `${id}-before`;
          rules.set(`${key}:r:${beforeClass}`, `.monaco-editor .${beforeClass}::before{${attachmentCss({ ...o.before, ...r.renderOptions.before })}}`);
        }
        if (r.renderOptions.after) {
          afterClass = `${id}-after`;
          rules.set(`${key}:r:${afterClass}`, `.monaco-editor .${afterClass}::after{${attachmentCss({ ...o.after, ...r.renderOptions.after })}}`);
        }
      }
      return {
        range: fromRange(r.range),
        options: {
          className: t.className,
          isWholeLine: !!o.isWholeLine,
          beforeContentClassName: beforeClass,
          afterContentClassName: afterClass,
          hoverMessage: r.hoverMessage?.map((h) => ({ value: h.value })),
          overviewRuler: o.overviewRulerColor ? { color: o.overviewRulerColor, position: (o.overviewRulerLane ?? 7) as monaco.editor.OverviewRulerLane } : undefined,
          stickiness: (o.rangeBehavior ?? 0) as monaco.editor.TrackedRangeStickiness,
        },
      };
    });
    writeSheet();
    const existing = map.get(key);
    if (existing) existing.set(decos);
    else map.set(key, ed.createDecorationsCollection(decos));
  }
}

export function clearAllDecorations() {
  for (const ed of editors) {
    collections.get(ed)?.forEach((c) => c.clear());
    collections.delete(ed);
  }
  types.clear();
  rules.clear();
  if (sheet) writeSheet();
}
