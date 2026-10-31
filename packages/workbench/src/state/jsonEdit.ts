/**
 * Sets or removes one top-level property of a JSON-with-comments object,
 * keeping the rest of the text (comments, order, formatting) as it is: the
 * Settings editor's Workspace tab writes .vscode/settings.json this way.
 */

interface Prop {
  key: string;
  /** Offsets of the property: from its key's quote to the end of its value. */
  start: number;
  valueStart: number;
  end: number;
}

/** Top-level properties of the object, and where its closing brace is (-1: not an object). */
function scan(text: string): { props: Prop[]; open: number; close: number } {
  const props: Prop[] = [];
  let depth = 0;
  let open = -1;
  let close = -1;
  let i = 0;
  let expectKey = false;
  let cur: Partial<Prop> | null = null;
  const skipString = (from: number) => {
    let j = from + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    return j + 1;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"') {
      const end = skipString(i);
      if (depth === 1 && expectKey) {
        cur = { key: JSON.parse(text.slice(i, end)) as string, start: i };
        expectKey = false;
      }
      i = end;
      continue;
    }
    if (c === "{" || c === "[") {
      if (depth === 0 && c === "{") {
        open = i;
        expectKey = true;
      }
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && c === "}") {
        if (cur?.valueStart !== undefined) props.push({ ...(cur as Prop), end: trimEnd(text, i) });
        close = i;
        break;
      }
    } else if (c === ":" && depth === 1 && cur && cur.valueStart === undefined) {
      cur.valueStart = i + 1;
    } else if (c === "," && depth === 1) {
      if (cur?.valueStart !== undefined) props.push({ ...(cur as Prop), end: trimEnd(text, i) });
      cur = null;
      expectKey = true;
    }
    i++;
  }
  return { props, open, close };
}

/** The end of a value: before trailing spaces and comments up to `limit`. */
function trimEnd(text: string, limit: number) {
  let j = limit;
  // Step back over whitespace and line comments between the value and the comma / brace.
  const before = text.slice(0, limit);
  const lastLine = before.lastIndexOf("\n");
  const commentAt = before.indexOf("//", lastLine + 1);
  if (commentAt >= 0 && !/"[^"]*$/.test(before.slice(lastLine + 1, commentAt))) j = commentAt;
  while (j > 0 && /\s/.test(text[j - 1])) j--;
  return j;
}

/** The text with `key` set to `value` (undefined removes it). Not an object: a new one. */
export function setJsonProperty(text: string, key: string, value: unknown): string {
  const src = text.trim() ? text : "{\n}\n";
  const { props, open, close } = scan(src);
  if (open < 0 || close < 0) return `${JSON.stringify(value === undefined ? {} : { [key]: value }, null, 2)}\n`;
  const json = (v: unknown) => JSON.stringify(v);
  const existing = props.find((p) => p.key === key);
  if (existing && value !== undefined) return `${src.slice(0, existing.valueStart)} ${json(value)}${src.slice(existing.end)}`;
  if (existing) {
    // Remove it with its comma (the one after it, else the one before it).
    let from = existing.start;
    let to = existing.end;
    const after = src.slice(to).match(/^\s*,/);
    if (after) to += after[0].length;
    else {
      const before = src.slice(0, from).match(/,\s*$/);
      if (before) from -= before[0].length;
    }
    // Take the line with it when the property was alone on its line.
    const lineStart = src.lastIndexOf("\n", from - 1) + 1;
    if (/^\s*$/.test(src.slice(lineStart, from)) && src[to] === "\n") {
      from = lineStart;
      to += 1;
    }
    return src.slice(0, from) + src.slice(to);
  }
  if (value === undefined) return text;
  const indent = (src.slice(open + 1).match(/\n([ \t]+)"/) ?? [])[1] ?? "  ";
  const last = props[props.length - 1];
  if (!last) return `${src.slice(0, open + 1)}\n${indent}${json(key)}: ${json(value)}\n${src.slice(close)}`;
  // A trailing comma already there: the new property goes after it.
  const trailing = src.slice(last.end, close).match(/^\s*,/);
  const at = last.end + (trailing ? trailing[0].length : 0);
  return `${src.slice(0, at)}${trailing ? "" : ","}\n${indent}${json(key)}: ${json(value)}${src.slice(at)}`;
}
