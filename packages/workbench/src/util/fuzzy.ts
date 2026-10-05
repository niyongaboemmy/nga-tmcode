/**
 * Small fuzzy matcher in the spirit of VS Code's quick open: every query
 * character must appear in order; contiguous runs, word starts and an early
 * first hit score higher. Returns the matched indices for highlighting.
 */
export interface FuzzyMatch {
  score: number;
  indices: number[];
}

function isWordStart(text: string, i: number) {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  return /[\s/\\._\-:]/.test(prev) || (prev === prev.toLowerCase() && cur !== cur.toLowerCase());
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  // The typed phrase appearing as-is ("toggle panel" in "Toggle Panel Visibility")
  // beats any scattered match, as in VS Code's command palette.
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  const at = t.indexOf(phrase);
  if (at >= 0) {
    const indices = [...phrase].map((ch, i) => (ch === " " ? -1 : at + i)).filter((i) => i >= 0);
    return { score: 100 + phrase.length * 6 + (isWordStart(text, at) ? 10 : 0) - at * 0.1 - text.length * 0.01, indices };
  }
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    indices.push(found);
    score += 1;
    if (found === prevMatch + 1) score += 5;
    else if (prevMatch >= 0) score -= Math.min(3, (found - prevMatch) * 0.1);
    if (isWordStart(text, found)) score += 3;
    prevMatch = found;
    ti = found + 1;
  }
  score -= indices[0] * 0.1;
  score -= (text.length - q.length) * 0.01;
  return { score, indices };
}

/** Splits `text` into plain and highlighted runs for rendering. */
export function highlightRuns(text: string, indices: number[]): { text: string; hit: boolean }[] {
  const set = new Set(indices);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return runs;
}
