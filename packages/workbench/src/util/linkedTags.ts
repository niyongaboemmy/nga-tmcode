/**
 * Linked editing for markup tags (VS Code's `editor.linkedEditing`): with the
 * cursor on a tag name, the ranges of that name and of its matching opening
 * or closing tag, so renaming one renames both. Works for HTML, XML, Vue /
 * Svelte templates and JSX/TSX (attributes in quotes and `{…}` are skipped).
 * Offsets are 0-based [start, end). Pure.
 */

export interface TagRange {
  start: number;
  end: number;
}

const NAME = /[A-Za-z][\w\-.:]*/y;
const MAX_TEXT = 500_000;

interface Tag {
  name: string;
  /** Offsets of the name. */
  start: number;
  end: number;
  close: boolean;
  selfClosing: boolean;
  /** Offset just after the tag's `>` (or where scanning stopped). */
  after: number;
}

/** Where the tag whose name ends at `from` ends, and whether it is `<x/>`. */
function scanTagEnd(text: string, from: number): { after: number; selfClosing: boolean } {
  let braces = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || (ch === "`" && braces > 0)) {
      const j = text.indexOf(ch, i + 1);
      if (j < 0) return { after: text.length, selfClosing: false };
      i = j;
    } else if (ch === "{") braces++;
    else if (ch === "}") braces = Math.max(0, braces - 1);
    else if (braces === 0 && ch === ">") return { after: i + 1, selfClosing: text[i - 1] === "/" };
    else if (braces === 0 && ch === "<") return { after: i, selfClosing: false };
  }
  return { after: text.length, selfClosing: false };
}

/** The tags of `text` in order (comments, CDATA and `<!doctype>` skipped). */
function* tags(text: string): Generator<Tag> {
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) return;
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text[lt + 1] === "!" || text[lt + 1] === "?") {
      const end = text.indexOf(">", lt + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    const close = text[lt + 1] === "/";
    const at = lt + (close ? 2 : 1);
    NAME.lastIndex = at;
    const m = NAME.exec(text);
    if (!m) {
      i = lt + 1;
      continue;
    }
    const end = at + m[0].length;
    const { after, selfClosing } = scanTagEnd(text, end);
    yield { name: m[0], start: at, end, close, selfClosing, after };
    i = Math.max(after, end);
    // <script> and <style> hold code, not tags.
    if (!close && !selfClosing && /^(script|style)$/i.test(m[0])) {
      const closeAt = text.toLowerCase().indexOf(`</${m[0].toLowerCase()}`, i);
      i = closeAt < 0 ? text.length : closeAt;
    }
  }
}

/** The ranges to edit together for the cursor at `offset`, or null when it is not on a paired tag name. */
export function linkedTagRanges(text: string, offset: number): TagRange[] | null {
  if (text.length > MAX_TEXT) return null;
  const stack: Tag[] = [];
  let cursorTag: Tag | null = null;
  const iter = tags(text);
  for (let r = iter.next(); !r.done; r = iter.next()) {
    const t = r.value;
    if (!cursorTag && offset >= t.start && offset <= t.end) {
      if (t.selfClosing) return null;
      cursorTag = t;
      if (t.close) {
        // Its opening tag is the innermost unclosed one of the same name.
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].name === t.name) return [{ start: stack[k].start, end: stack[k].end }, { start: t.start, end: t.end }];
        }
        return null;
      }
      stack.push(t);
      continue;
    }
    if (t.selfClosing) continue;
    if (!t.close) {
      stack.push(t);
      continue;
    }
    // A closing tag: closes the innermost open tag of its name (HTML's forgiving rules for unclosed <li>, <p>…).
    let k = stack.length - 1;
    while (k >= 0 && stack[k].name !== t.name) k--;
    if (k < 0) continue;
    const open = stack[k];
    stack.length = k;
    if (open === cursorTag) return [{ start: open.start, end: open.end }, { start: t.start, end: t.end }];
  }
  return null;
}
