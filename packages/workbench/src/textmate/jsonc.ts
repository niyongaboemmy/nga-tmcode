/**
 * JSON with comments and trailing commas (VS Code's theme, snippet and
 * language-configuration files are all JSONC). Strips `//` and `/* *\/`
 * comments and trailing commas outside strings, then uses JSON.parse.
 */
export function parseJsonc<T = unknown>(text: string): T {
  let out = "";
  let i = 0;
  const n = text.length;
  // A BOM is common in files written on Windows.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === ",") {
      // Trailing comma: the next significant character closes an object/array.
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] === "/" && text[j + 1] === "/") {
          while (j < n && text[j] !== "\n") j++;
          continue;
        }
        if (text[j] === "/" && text[j + 1] === "*") {
          const end = text.indexOf("*/", j + 2);
          j = end < 0 ? n : end + 2;
          continue;
        }
        break;
      }
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return JSON.parse(out) as T;
}
