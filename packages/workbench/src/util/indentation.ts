/** Leading whitespace converted between tabs and spaces (VS Code's Convert Indentation to Spaces / Tabs). */
export function convertIndentation(text: string, toSpaces: boolean, tabSize: number): string {
  return text
    .split(/(\r?\n)/)
    .map((part, i) => {
      if (i % 2) return part;
      const lead = /^[ \t]*/.exec(part)![0];
      if (!lead) return part;
      let col = 0;
      for (const ch of lead) col = ch === "\t" ? col + tabSize - (col % tabSize) : col + 1;
      const indent = toSpaces ? " ".repeat(col) : "\t".repeat(Math.floor(col / tabSize)) + " ".repeat(col % tabSize);
      return indent + part.slice(lead.length);
    })
    .join("");
}
