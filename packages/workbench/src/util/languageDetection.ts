/**
 * Guesses the language of an untitled buffer from what is typed in it, like
 * VS Code's `workbench.editor.languageDetection` (VS Code uses a small ML
 * model; TMCode uses a shebang, first-line markers and weighted keyword
 * patterns for the languages students type most). Returns a Monaco language
 * id, or null when nothing is clear enough. Pure.
 */

type Rule = [RegExp, number];

const SHEBANG: [RegExp, string][] = [
  [/python[0-9.]*\b/, "python"],
  [/\b(node|deno|bun)\b/, "javascript"],
  [/\b(ts-node|tsx)\b/, "typescript"],
  [/\b(bash|sh|zsh|dash|ksh)\b/, "shell"],
  [/\bruby\b/, "ruby"],
  [/\bperl\b/, "perl"],
  [/\bphp\b/, "php"],
];

const JS_RULES: Rule[] = [
  [/\b(const|let|var)\s+[\w$]+\s*=/, 2],
  [/\bfunction\s*[\w$]*\s*\(/, 3],
  [/=>/, 1],
  [/\bconsole\.(log|error|warn)\s*\(/, 3],
  [/\brequire\s*\(\s*['"]/, 3],
  [/^\s*import\s+.+\s+from\s+['"]/m, 2],
  [/^\s*export\s+(default|const|function|class)\b/m, 2],
  [/\b(document|window)\.\w+/, 2],
  [/===|!==/, 2],
  [/;\s*$/m, 0.5],
];

/** Only TypeScript has these; without one, the text is JavaScript. */
const TS_ONLY: Rule[] = [
  [/[\w$)\]]\s*:\s*(string|number|boolean|any|void|unknown|never)(\[\])?\b/, 3],
  [/^\s*(export\s+)?interface\s+\w+/m, 3],
  [/^\s*(export\s+)?type\s+\w+\s*(<[^>]*>)?\s*=/m, 3],
  [/\b(public|private|protected|readonly)\s+\w+\s*[:?(]/, 2],
  [/\bas\s+(const|string|number|any|unknown)\b/, 2],
  [/^\s*enum\s+\w+\s*\{/m, 2],
];

const RULES: Record<string, Rule[]> = {
  python: [
    [/^\s*def\s+\w+\s*\([^)]*\)\s*(->\s*[^:]+)?:/m, 4],
    [/^\s*class\s+\w+(\([^)]*\))?\s*:/m, 4],
    [/^\s*(if|elif|while|for|with|try|except|else)\b[^{;]*:\s*(#.*)?$/m, 2],
    [/^\s*from\s+[\w.]+\s+import\s+\w/m, 4],
    [/^\s*import\s+[\w.]+(\s+as\s+\w+)?\s*$/m, 2],
    [/\bprint\s*\(/, 1],
    [/\bself\.\w+/, 2],
    [/\b(None|True|False)\b/, 1],
    [/\b(elif|lambda|nonlocal)\b/, 2],
    [/\binput\s*\(|\brange\s*\(|\blen\s*\(/, 1],
    [/f"[^"]*\{[^}]+\}[^"]*"|f'[^']*\{[^}]+\}[^']*'/, 2],
  ],
  java: [
    [/\bpublic\s+static\s+void\s+main\s*\(\s*String/, 6],
    [/\bSystem\.out\.print(ln|f)?\s*\(/, 5],
    [/\b(public|private|protected)\s+(static\s+)?(final\s+)?(class|interface|enum|void|int|String|boolean|double)\b/, 3],
    [/^\s*package\s+[\w.]+\s*;/m, 4],
    [/^\s*import\s+java(x)?\.[\w.*]+\s*;/m, 5],
    [/\bnew\s+[A-Z]\w*(<[^>]*>)?\s*\(/, 1],
    [/\bString\[\]\s+\w+/, 3],
    [/@Override\b/, 3],
  ],
  c: [
    [/#include\s*<(stdio|stdlib|string|math|stdbool|ctype|time|unistd)\.h>/, 5],
    [/\bprintf\s*\(/, 2],
    [/\bscanf\s*\(/, 3],
    [/\b(malloc|calloc|free)\s*\(/, 2],
    [/\bint\s+main\s*\(/, 2],
    [/\bstruct\s+\w+\s*\{/, 1],
  ],
  cpp: [
    [/#include\s*<(iostream|vector|string|map|set|algorithm|fstream|sstream|memory|unordered_map)>/, 6],
    [/\bstd::\w+/, 4],
    [/\b(cout|cin)\s*(<<|>>)/, 5],
    [/\busing\s+namespace\s+std\s*;/, 6],
    [/\bint\s+main\s*\(/, 1],
    [/\btemplate\s*</, 3],
  ],
  html: [
    [/<!doctype\s+html/i, 8],
    [/<(html|head|body|div|span|p|a|script|style|h[1-6]|ul|ol|li|table|form|input|button|img|section|nav|header|footer|main)\b[^>]*>/i, 3],
    [/<\/(html|head|body|div|span|p|a|script|style|h[1-6]|ul|ol|li|table|form|button|section|nav|header|footer|main)>/i, 3],
    [/<meta\s|<link\s+rel=/i, 3],
  ],
  css: [
    [/^\s*(@media|@import|@keyframes|@font-face)\b/m, 4],
    [/\b(color|margin|padding|display|font-size|font-family|background(-color)?|border|width|height|flex|grid-template-columns)\s*:\s*[^;{}]+;/, 3],
    [/^[ \t]*[.#]?[a-z*][\w \t,>+~.#:-]*\{[ \t]*$/im, 2],
    [/^\s*[.#][\w-]+\s*\{/m, 2],
  ],
  sql: [
    [/\bselect\b[\s\S]+?\bfrom\b/i, 5],
    [/\b(create\s+table|insert\s+into|delete\s+from|alter\s+table|drop\s+table)\b/i, 6],
    [/\bupdate\s+\w+\s+set\b/i, 6],
    [/\b(where|group\s+by|order\s+by|inner\s+join|left\s+join|primary\s+key)\b/i, 1],
  ],
  shell: [
    [/^\s*(echo|cd|ls|export|sudo|apt(-get)?|brew|npm|pip3?|mkdir|rm|cp|mv|chmod|grep|curl|git)\s/m, 2],
    [/^\s*(fi|done|esac)\s*$/m, 3],
    [/^\s*(if|while)\s+\[\[?\s/m, 4],
    [/\$\{?\w+\}?|\$\(/, 1],
    [/^\s*\w+=("[^"]*"|'[^']*'|\S+)\s*$/m, 1],
  ],
  markdown: [
    [/^#{1,6}\s+\S/m, 2],
    [/^\s*[-*+]\s+\S/m, 1],
    [/^\s*\d+\.\s+\S/m, 1],
    [/!?\[[^\]]+\]\([^)\s]+\)/, 3],
    [/^```/m, 3],
    [/\*\*[^*\n]+\*\*|__[^_\n]+__/, 2],
    [/^>\s+\S/m, 1],
  ],
};

function score(text: string, rules: Rule[]) {
  let s = 0;
  for (const [re, w] of rules) if (re.test(text)) s += w;
  return s;
}

/** Enough evidence for a guess, and how far ahead of the next language it must be. */
const MIN_SCORE = 3;
const MIN_LEAD = 1;

export function detectLanguage(text: string): string | null {
  // The start of the buffer is enough, and keeps typing in a long buffer cheap.
  const sample = text.slice(0, 10_000);
  const trimmed = sample.trim();
  if (trimmed.length < 3) return null;
  const first = trimmed.split("\n", 1)[0];
  if (first.startsWith("#!")) {
    for (const [re, lang] of SHEBANG) if (re.test(first)) return lang;
  }
  if (/^<\?php\b/.test(first)) return "php";
  if (/^<\?xml\b/.test(first)) return "xml";
  if (/^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      /* not JSON: fall through to the keyword scores */
    }
  }
  const scores: [string, number][] = Object.entries(RULES).map(([lang, rules]) => [lang, score(sample, rules)]);
  const js = score(sample, JS_RULES);
  const ts = score(sample, TS_ONLY);
  scores.push(["javascript", js]);
  if (ts > 0) scores.push(["typescript", js + ts]);
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (!best || best[1] < MIN_SCORE) return null;
  if (best[0] === "typescript" && second?.[0] === "javascript") return "typescript";
  if (second && best[1] - second[1] < MIN_LEAD) return null;
  return best[0];
}
