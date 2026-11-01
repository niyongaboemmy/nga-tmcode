/**
 * The request interpreter (reports/TMCode prompt interpreter layer.md, group Q): a request is
 * turned into a visible, editable intent card before the agent acts on it, never rewritten
 * silently. This file is the part both sides share (TMCode and Task Mentor keep a copy, like the
 * Learning filter): the card's shape, language detection, the gate's signals, the validators that
 * make intent preservation checkable by code (the quote-span rule, paths that exist), the
 * agent hand-off, and a few small helpers (understood-diff, completeness, example → test).
 *
 * No dependencies: plain TypeScript so Task Mentor's copy runs as is.
 */

// ── shapes ──

export const TASK_TYPES = ["explain", "fix", "add-feature", "change", "refactor", "test", "run", "learn", "other"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** A language mix: "rw+en" is Kinyarwanda with English words, the usual student request. */
export type IntentLang = "en" | "fr" | "rw" | "rw+en" | "rw+fr" | "fr+en" | "other";

/** Who put a field on the card: the user's own words, or the interpreter (shown with a "why"). */
export type By = "you" | "ai";

export interface IntentItem {
  text: string;
  by: By;
  /** Why the interpreter added it (Guided teaches with it). */
  why?: string;
  /** requirements: the span of the user's words it comes from (the quote-span rule). */
  quote?: string;
  /** assumptions: the user keeps it (true) or removed it (false). */
  keep?: boolean;
}

export interface IntentExample {
  input: string;
  output: string;
  /** The user's tick: yes (✓), no (✗), or not decided yet. */
  verdict: "yes" | "no" | null;
  by: By;
  why?: string;
}

export interface IntentQuestion {
  id: string;
  text: string;
  choices: string[];
  answer?: string | null;
}

export interface IntentCard {
  version: 1;
  /** The user's text, verbatim: always sent to the agent, and authoritative. */
  original: string;
  language: IntentLang;
  /** One sentence in the user's reply language (≤ 40 words). */
  restated: string;
  /** The same goal in plain English for the agent (≤ 120 words). */
  spec_en: string;
  task_type: TaskType;
  inputs: string;
  outputs: string;
  examples: IntentExample[];
  edge_cases: IntentItem[];
  /** Files or symbols to touch; each exists in the workspace. */
  targets: string[];
  requirements: IntentItem[];
  assumptions: IntentItem[];
  open_questions: IntentQuestion[];
  /** "WHEN … THE PROGRAM SHALL …" or a test name. */
  acceptance_checks: string[];
  out_of_scope: string[];
  /** The student's word → the technical term (Kinyarwanda / French only). */
  glossary: { term: string; en: string }[];
  confidence: "low" | "medium" | "high";
}

/** Learning's prompt coach: what is missing and the student's own words by role. Never a rewrite. */
export type MissingId = "goal" | "inputs" | "outputs" | "example" | "edge_case" | "target" | "success";

export interface CoachResult {
  version: 1;
  language: IntentLang;
  /** What the request doesn't say yet, each as a question for the student. */
  missing: { id: MissingId; label: string; question: string }[];
  /** The request cut into the student's own words, each with what it does. */
  segments: { text: string; kind: "goal" | "input" | "output" | "example" | "edge" | "target" | "vague" | "other"; note?: string }[];
  /** One encouraging line on what is already clear. */
  praise?: string;
}

export const CARD_LIMITS = { restatedWords: 40, specWords: 120, specWordsHard: 160, examples: 4, edgeCases: 4, questions: 2, choices: 4, requirements: 8, assumptions: 6, checks: 6, outOfScope: 4, glossary: 6, targets: 8 } as const;

// ── text helpers ──

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (v: unknown, max: number): string =>
  typeof v === "string" || typeof v === "number" ? String(v).replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const capWords = (s: string, n: number) => {
  const w = words(s);
  return w.length <= n ? s : `${w.slice(0, n).join(" ")}…`;
};
/** Lower-case, accents folded, punctuation dropped, spaces collapsed: how spans are compared. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@./_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const tokens = (s: string) => new Set(fold(s).split(" ").filter((w) => w.length > 2));
/** Token overlap (Jaccard) between two texts: 1 means the same words. */
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both || 1);
}

// ── language ──

/** Distinctive Kinyarwanda words (short ones that are also English or French words are left out). */
const RW = new Set(
  "ndashaka nshaka ndifuza niba ariko kandi cyangwa ntabwo ntibi ntiri ubwo iyo igihe ngo nk'uko kugira gukora gukoresha kwerekana kwandika gusoma kubika gusiba kongeramo guhindura kubara kohereza kwinjira gusohoka gufunga gufungura gushyira gushaka kureba kugaragaza bigaragare igaragare herekane yerekane yandike ijambobanga ijambo ikosa amakosa ubutumwa umukoresha abakoresha urupapuro amapaji ipaji buto ifoto amafoto izina amazina imibare umubare urutonde amakuru ububiko porogaramu mudasobwa telefoni neza nabi mbi cyane gato byose buri mbere nyuma hejuru hasi ibumoso iburyo ari iri iyi aya uyu ubu iki ibi bya cya rya ya ry ry' iki? ese mwiriwe muraho murakoze yego oya ntabwo sinzi simbizi nifuza ndagira ngo ko ni bikore bikosore ongeramo ifite bifite rifite ufite eshatu ebyiri rimwe kabiri gatatu yayo yabo yinjije yinjiza ibare itange kosora sobanura ubusa ribi ryiza".split(/\s+/),
);
const FR = new Set(
  "je veux voudrais j'aimerais il elle nous vous ils le la les un une des du de au aux pour avec sans quand si mais ou est sont être avoir pas ne plus que qui quoi dans sur sous mot passe erreur message afficher affiche ajouter ajoute supprimer modifier changer créer page bouton liste nombre fichier fonction quand lorsque doit faut faire s'il connexion utilisateur données tableau vide".split(/\s+/),
);
const EN = new Set(
  "i want would like the a an to of in on for with when if and or but is are be should must make add show display create delete remove change fix bug error page button list number file function return returns login password user data empty test tests run write explain why how what this that it my".split(/\s+/),
);
/** Kinyarwanda look: verb prefixes and noun classes, with a vowel ending. */
const RW_SHAPE = /^(ku|gu|kw|gw|n?da|nti|ntu|ni|ba|bi|by|cy|rw|ry|ur|um|im|in|ib|ig|ama|aba|ubu|uru|aka|utu)[a-z']{3,}[aeiou]$/;

/** Which languages a request is written in (a rough count of marker words; code and paths ignored). */
export function detectLanguage(text: string): IntentLang {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\S+[/.]\S+/g, " ")
    .toLowerCase();
  const list = plain.split(/[^\p{L}']+/u).filter((w) => w.length > 1);
  if (!list.length) return "en";
  let rw = 0;
  let fr = 0;
  let en = 0;
  for (const w of list) {
    if (RW.has(w)) rw += 1;
    else if (RW_SHAPE.test(w) && !EN.has(w) && !FR.has(w)) rw += 0.6;
    if (FR.has(w) || /[éèêàçù]/.test(w)) fr += 1;
    if (EN.has(w)) en += 1;
  }
  const n = list.length;
  // A one- or two-word request needs one marker; longer ones a share of the words.
  const has = (x: number) => x >= (n <= 2 ? 0.6 : 1.5) && x / n >= 0.12;
  const rwOn = has(rw);
  const frOn = has(fr) && fr >= en * 0.6;
  const enOn = has(en);
  if (rwOn && enOn) return "rw+en";
  if (rwOn && frOn) return "rw+fr";
  if (rwOn) return "rw";
  if (frOn && enOn && en >= 2 && fr >= 2) return fr >= en ? "fr" : "fr+en";
  if (frOn) return "fr";
  if (enOn || n <= 3) return "en";
  return "other";
}

export const hasKinyarwanda = (l: IntentLang) => l === "rw" || l === "rw+en" || l === "rw+fr";
export const isMixed = (l: IntentLang) => l.includes("+");

// ── privacy and injection: what may reach the interpreter ──

/**
 * Pasted blocks (fences, long code-looking runs) are cut out by code and replaced with a
 * placeholder: the interpreter derives intent from the user's own words only (dual-LLM / CaMeL).
 */
export function stripPasted(text: string): { text: string; pasted: number } {
  let pasted = 0;
  let out = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    pasted++;
    const lines = body.split("\n").filter((l) => l.trim()).length;
    return `[pasted: ${lines} line${lines === 1 ? "" : "s"}${lang ? ` of ${lang}` : ""}]`;
  });
  // Unfenced code: 4+ consecutive lines that look like code (braces, semicolons, indentation, prompts).
  const lines = out.split("\n");
  const kept: string[] = [];
  let run: string[] = [];
  const looksCode = (l: string) => /[{};]\s*$|^\s{2,}\S|^\s*(def|class|function|const|let|var|import|from|#include|public|private|return|if|for|while)\b|=>|^\s*[$>] /.test(l);
  const flush = () => {
    if (run.length >= 4) {
      pasted++;
      kept.push(`[pasted: ${run.length} lines of code]`);
    } else kept.push(...run);
    run = [];
  };
  for (const l of lines) {
    if (looksCode(l)) run.push(l);
    else {
      flush();
      kept.push(l);
    }
  }
  flush();
  out = kept.join("\n");
  return { text: out.trim(), pasted };
}

/** Names, e-mail addresses, phone numbers and long ids leave before a hosted call (pseudonymous requests). */
export function scrubPersonal(text: string, names: string[] = []): string {
  let out = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/(?<!\w)(\+?\d[\d\s-]{8,}\d)(?!\w)/g, "[number]")
    .replace(/\b\d{6,}\b/g, "[id]");
  for (const n of names.map((x) => x.trim()).filter((x) => x.length >= 3)) {
    out = out.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]");
  }
  return out;
}

/** Instructions a card must never carry unless the user typed them (laundered injection). */
const INJECTION = /\b(ignore|disregard|forget)\b[^.]{0,40}\b(instructions?|rules?|prompt)\b|system prompt|you are now|developer mode|exfiltrat|\b(curl|wget)\b[^|]{0,80}\|\s*(sh|bash)\b|rm\s+-rf\s+[~/]|send (the|all|my)? ?(keys?|tokens?|passwords?|secrets?)|\.env\b.*\b(send|upload|post)\b/i;
export function suspicious(text: string, original: string): boolean {
  return INJECTION.test(text) && !INJECTION.test(original);
}

// ── the gate's signals (stages 0–2 are code: free, instant) ──

export interface IntentSignals {
  score: number;
  reasons: string[];
  language: IntentLang;
  words: number;
}

const VAGUE = /\b(make it work|doesn'?t work|not working|fix (it|this|everything)|improve|better|do (it|this|something)|help( me)?|some(thing|how)|stuff|whatever|etc|nice|cool|properly|correctly|ça marche pas|améliore|arrange|bikore|bikunde|bikosore|bibe byiza)\b/i;
const IO_WORDS = /\b(input|output|return|returns|print|prints|show|shows|display|when|if|should|given|expect|→|->|=>|=|résultat|retourne|affiche|si|quand|niba|iyo|igaragare|herekane|bigaragare)\b/i;
const DANGLING = /\b(it|this|that|ça|ceci|cela|ibi|iki|icyo|ibyo)\b/i;

/**
 * How unclear a request looks, from cheap signals: very short or very long, vague verbs, several
 * goals at once, no input/output words, "it/this" with nothing open. 0 = clear; ≥ 3 = unclear.
 */
export function intentSignals(text: string, ctx: { openFile?: boolean; mentions?: number; examples?: boolean } = {}): IntentSignals {
  const plain = stripPasted(text).text;
  const n = words(plain).length;
  const reasons: string[] = [];
  let score = 0;
  if (n < 8) {
    score += 1;
    reasons.push("short");
  }
  if (n > 120) {
    score += 1;
    reasons.push("long");
  }
  if (VAGUE.test(plain)) {
    score += 2;
    reasons.push("vague");
  }
  const goals = plain.split(/\b(?:and then|and also|also|then|plus|and|et aussi|puis|kandi|hanyuma)\b|;|\n[-*•]/i).filter((s) => words(s).length >= 2).length;
  if (goals >= 3) {
    score += 1;
    reasons.push("several goals");
  }
  if (!IO_WORDS.test(plain) && !ctx.examples) {
    score += 1;
    reasons.push("no input/output");
  }
  if (DANGLING.test(plain) && !ctx.openFile && !ctx.mentions && n < 20) {
    score += 1;
    reasons.push("refers to something not open");
  }
  const language = detectLanguage(plain);
  return { score, reasons, language, words: n };
}

// ── validating what the interpreter returned ──

export interface NormalizeOptions {
  /** Workspace paths (and repo_map symbols): targets must be among them. Null: unknown, keep only paths the user named. */
  paths?: string[] | null;
  symbols?: string[] | null;
  /** The language the restatement must be in (else the user's). */
  replyLanguage?: string | null;
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Does `quote` appear in `original` (folded)? A quote of at least two words, or one long word. */
export function quoted(quote: string, original: string): boolean {
  const q = fold(quote);
  if (!q) return false;
  if (q.split(" ").length < 2 && q.length < 6) return false;
  return fold(original).includes(q);
}

/** The best span of the user's words a requirement comes from, when the model didn't give one. */
function findSpan(text: string, original: string): string | null {
  const o = fold(original).split(" ");
  const t = new Set(fold(text).split(" ").filter((w) => w.length > 2));
  let best: { from: number; to: number; hits: number } | null = null;
  for (let i = 0; i < o.length; i++) {
    let hits = 0;
    for (let j = i; j < Math.min(o.length, i + 12); j++) {
      if (t.has(o[j])) hits++;
      if (hits >= 3 && (!best || hits > best.hits)) best = { from: i, to: j, hits };
    }
  }
  return best ? o.slice(best.from, best.to + 1).join(" ") : null;
}

function resolveTarget(raw: string, original: string, opts: NormalizeOptions): string | null {
  const t = raw.trim().replace(/^@/, "").replace(/^\.\//, "");
  if (!t || t.length > 300) return null;
  const paths = opts.paths;
  if (paths) {
    if (paths.includes(t)) return t;
    const bySuffix = paths.filter((p) => p.endsWith(`/${t}`) || p === t);
    if (bySuffix.length === 1) return bySuffix[0];
    const base = t.slice(t.lastIndexOf("/") + 1);
    const byBase = paths.filter((p) => p.slice(p.lastIndexOf("/") + 1) === base);
    if (byBase.length === 1) return byBase[0];
  }
  if (opts.symbols?.includes(t)) return t;
  // Unknown workspace: only what the user named.
  if (!paths && fold(original).includes(fold(t))) return t;
  return null;
}

function item(v: unknown, by: By, max = 200): IntentItem | null {
  const o = typeof v === "string" ? { text: v } : asObj(v);
  const text = clean(o.text ?? o.item ?? o.value, max);
  if (!text) return null;
  const why = clean(o.why ?? o.reason, 160);
  const quote = clean(o.quote ?? o.span, 200);
  return { text, by: o.by === "you" ? "you" : by, ...(why ? { why } : {}), ...(quote ? { quote } : {}) };
}

/**
 * The card a model returned, made safe: enums, lengths, at most 2 questions, targets that exist,
 * and the quote-span rule (a requirement the user didn't say becomes an assumption they can
 * remove). Null when it can't be used (no goal, an over-long spec, laundered instructions): the
 * caller then sends the user's words as they are.
 */
export function normalizeCard(raw: unknown, original: string, opts: NormalizeOptions = {}): { card: IntentCard; notes: string[] } | null {
  const r = asObj(typeof raw === "string" ? safeJson(raw) : raw);
  const notes: string[] = [];
  const spec = clean(r.spec_en ?? r.spec ?? r.goal, 2000);
  if (!spec) return null;
  if (words(spec).length > CARD_LIMITS.specWordsHard) return null;
  // Instructions inside pasted blocks are never the user's own words.
  const all = JSON.stringify(r);
  if (suspicious(all, stripPasted(original).text)) return null;
  const language = (["en", "fr", "rw", "rw+en", "rw+fr", "fr+en", "other"] as const).includes(r.language as IntentLang) ? (r.language as IntentLang) : detectLanguage(original);
  const task = (TASK_TYPES as readonly string[]).includes(String(r.task_type)) ? (r.task_type as TaskType) : "other";
  const requirements: IntentItem[] = [];
  const assumptions: IntentItem[] = [];
  for (const v of asArray(r.requirements).slice(0, CARD_LIMITS.requirements * 2)) {
    const it = item(v, "you");
    if (!it) continue;
    const quote = it.quote && quoted(it.quote, original) ? it.quote : findSpan(it.text, original);
    if (quote) requirements.push({ text: it.text, by: "you", quote });
    else {
      notes.push(`moved to assumptions: ${it.text}`);
      assumptions.push({ text: it.text, by: "ai", why: it.why ?? "You didn't say this; keep it only if you want it.", keep: true });
    }
  }
  for (const v of asArray(r.assumptions)) {
    const it = item(v, "ai");
    if (it) assumptions.push({ ...it, by: "ai", keep: true });
  }
  const examples: IntentExample[] = asArray(r.examples)
    .map((v) => {
      const o = asObj(v);
      const input = clean(o.input ?? o.in, 200);
      const output = clean(o.output ?? o.out ?? o.expected, 200);
      if (!input) return null;
      const youSaid = quoted(input, original) || (output !== "" && quoted(output, original));
      const why = clean(o.why, 160);
      return { input, output, verdict: null, by: youSaid ? "you" : "ai", ...(why ? { why } : {}) } as IntentExample;
    })
    .filter((x): x is IntentExample => !!x)
    .slice(0, CARD_LIMITS.examples);
  const edge_cases = asArray(r.edge_cases)
    .map((v) => item(v, "ai", 120))
    .filter((x): x is IntentItem => !!x)
    .map((x) => ({ ...x, by: (quoted(x.text, original) ? "you" : "ai") as By }))
    .slice(0, CARD_LIMITS.edgeCases);
  const targets: string[] = [];
  for (const v of asArray(r.targets)) {
    const t = resolveTarget(clean(v, 300), original, opts);
    if (t && !targets.includes(t)) targets.push(t);
    else if (clean(v, 300)) notes.push(`dropped unknown target: ${clean(v, 80)}`);
  }
  const open_questions: IntentQuestion[] = asArray(r.open_questions ?? r.questions)
    .map((v, i): IntentQuestion | null => {
      const o = typeof v === "string" ? { text: v } : asObj(v);
      const text = clean(o.text ?? o.question, 240);
      if (!text) return null;
      const choices = asArray(o.choices ?? o.options)
        .map((c) => clean(c, 100))
        .filter((c) => c && !/^other\b/i.test(c))
        .slice(0, CARD_LIMITS.choices);
      return { id: `q${i + 1}`, text, choices, answer: null };
    })
    .filter((x): x is IntentQuestion => !!x)
    .slice(0, CARD_LIMITS.questions);
  const glossary = hasKinyarwanda(language) || language.startsWith("fr")
    ? asArray(r.glossary)
        .map((v) => {
          const o = asObj(v);
          const term = clean(o.term ?? o.word, 60);
          const en = clean(o.en ?? o.english ?? o.meaning, 60);
          return term && en ? { term, en } : null;
        })
        .filter((x): x is { term: string; en: string } => !!x)
        .slice(0, CARD_LIMITS.glossary)
    : [];
  const confidence = r.confidence === "low" || r.confidence === "high" ? r.confidence : "medium";
  const restatedRaw = clean(r.restated ?? r.restatement, 600) || spec;
  if (words(spec).length > CARD_LIMITS.specWords) notes.push("spec shortened");
  const card: IntentCard = {
    version: 1,
    original,
    language,
    restated: capWords(restatedRaw, CARD_LIMITS.restatedWords),
    spec_en: capWords(spec, CARD_LIMITS.specWords),
    task_type: task,
    inputs: clean(r.inputs, 200),
    outputs: clean(r.outputs, 200),
    examples,
    edge_cases,
    targets: targets.slice(0, CARD_LIMITS.targets),
    requirements: requirements.slice(0, CARD_LIMITS.requirements),
    assumptions: assumptions.slice(0, CARD_LIMITS.assumptions),
    open_questions,
    acceptance_checks: asArray(r.acceptance_checks).map((v) => clean(v, 200)).filter(Boolean).slice(0, CARD_LIMITS.checks),
    out_of_scope: asArray(r.out_of_scope).map((v) => clean(v, 160)).filter(Boolean).slice(0, CARD_LIMITS.outOfScope),
    glossary,
    confidence: open_questions.length && confidence === "high" ? "medium" : confidence,
  };
  return { card, notes };
}

const MISSING_LABEL: Record<MissingId, string> = {
  goal: "What it should do",
  inputs: "What goes in",
  outputs: "What comes out",
  example: "An example",
  edge_case: "An unusual case",
  target: "Where in the project",
  success: "How you'll know it works",
};

/** Learning's coach answer, made safe: no rewritten request and no code survive (only questions and the student's own words). */
export function normalizeCoach(raw: unknown, original: string): CoachResult | null {
  const r = asObj(typeof raw === "string" ? safeJson(raw) : raw);
  const ids = Object.keys(MISSING_LABEL) as MissingId[];
  const missing = asArray(r.missing)
    .map((v) => {
      const o = typeof v === "string" ? { id: v } : asObj(v);
      const id = ids.includes(o.id as MissingId) ? (o.id as MissingId) : null;
      if (!id) return null;
      const question = noCode(clean(o.question, 240));
      return { id, label: MISSING_LABEL[id], question: question || defaultQuestion(id) };
    })
    .filter((x): x is { id: MissingId; label: string; question: string } => !!x)
    .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)
    .slice(0, 5);
  const kinds = ["goal", "input", "output", "example", "edge", "target", "vague", "other"] as const;
  // Segments must be the student's own words: anything not in the request is dropped.
  const segments = asArray(r.segments)
    .map((v) => {
      const o = asObj(v);
      const text = clean(o.text, 300);
      if (!text || !fold(original).includes(fold(text))) return null;
      const kind = (kinds as readonly string[]).includes(String(o.kind)) ? (o.kind as (typeof kinds)[number]) : "other";
      const note = noCode(clean(o.note, 160));
      return { text, kind, ...(note ? { note } : {}) };
    })
    .filter((x): x is CoachResult["segments"][number] => !!x)
    .slice(0, 12);
  if (!missing.length && !segments.length) return null;
  const praise = noCode(clean(r.praise, 160));
  return { version: 1, language: detectLanguage(original), missing, segments, ...(praise ? { praise } : {}) };
}

function defaultQuestion(id: MissingId): string {
  return {
    goal: "In one sentence, what should the program do?",
    inputs: "What does the program get (typed by the user, a file, a list…)?",
    outputs: "What should it give back or show?",
    example: "Can you give one example: this input → this result?",
    edge_case: "What should happen with an empty, wrong or very large input?",
    target: "Which file or function is this about?",
    success: "How will you check that it works?",
  }[id];
}

/** Learning never shows code: fenced or inline code and code-looking lines are cut from coach text. */
function noCode(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]{12,}`/g, "")
    .replace(/\b(def|function|return|console\.log|print)\s*\(.*$/i, "")
    .trim();
}

function safeJson(s: string): unknown {
  const m = /\{[\s\S]*\}/.exec(s.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Parses a model's JSON answer (fences and prose around it allowed); null when it isn't JSON. */
export const parseModelJson = safeJson;

// ── comparing cards: understood-diff (Q9) and the consistency gate (Q15) ──

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** After an edit: does the new card mean what the old one meant? (the "same wrong program" trap) */
export function sameMeaning(a: IntentCard, b: IntentCard): boolean {
  return a.task_type === b.task_type && sameSet(a.targets, b.targets) && similarity(a.spec_en, b.spec_en) >= 0.85 && a.examples.length === b.examples.length;
}

/** Two samples of the interpreter: do they agree on what was meant? (ask only when they don't) */
export function cardsAgree(a: IntentCard, b: IntentCard): boolean {
  if (a.task_type !== b.task_type && a.task_type !== "other" && b.task_type !== "other") return false;
  const overlap = !a.targets.length || !b.targets.length || a.targets.some((t) => b.targets.includes(t));
  return overlap && similarity(a.spec_en, b.spec_en) >= 0.45;
}

/** When two samples disagree: one question that offers both meanings. */
export function disagreementQuestion(a: IntentCard, b: IntentCard): IntentQuestion {
  return { id: "q-meaning", text: "I can read your request two ways. Which did you mean?", choices: [capWords(a.spec_en, 18), capWords(b.spec_en, 18)], answer: null };
}

// ── completeness: what the user supplied unaided (the teacher's trend, Guided's fading) ──

export const COMPLETENESS_ITEMS = ["goal", "inputs", "outputs", "example", "edge_case", "target"] as const;
export type CompletenessItem = (typeof COMPLETENESS_ITEMS)[number];

/** Which items the user's own words carried (not the interpreter's additions), 0–1. */
export function completeness(card: IntentCard, mentions = 0): { score: number; have: CompletenessItem[]; missing: CompletenessItem[] } {
  const o = fold(card.original);
  const said = (s: string) => !!s && fold(s).split(" ").filter((w) => w.length > 3).some((w) => o.includes(w));
  const have: CompletenessItem[] = [];
  if (card.requirements.length) have.push("goal");
  if (said(card.inputs) || /\b(input|given|takes?|from|kuva|ivuye|entrée)\b/i.test(card.original)) have.push("inputs");
  if (said(card.outputs) || /\b(returns?|outputs?|prints?|shows?|displays?|affiche|retourne|igaragare|herekane|yerekane|ivuga)\b/i.test(card.original)) have.push("outputs");
  if (card.examples.some((e) => e.by === "you") || /(->|→|=>|\bshould (return|give|print)\b)/i.test(card.original)) have.push("example");
  if (card.edge_cases.some((e) => e.by === "you") || /\b(empty|zero|negative|wrong|invalid|missing|null|none|vide|ubusa|nabi|mbi)\b/i.test(card.original)) have.push("edge_case");
  if (mentions > 0 || card.targets.some((t) => o.includes(fold(t.slice(t.lastIndexOf("/") + 1)).replace(/\..*$/, "")))) have.push("target");
  const missing = COMPLETENESS_ITEMS.filter((x) => !have.includes(x));
  return { score: Math.round((have.length / COMPLETENESS_ITEMS.length) * 100) / 100, have, missing };
}

/** How many fields the interpreter added (Guided's fading watches this). */
export function additions(card: IntentCard): number {
  return card.assumptions.filter((a) => a.keep !== false).length + card.examples.filter((e) => e.by === "ai").length + card.edge_cases.filter((e) => e.by === "ai").length;
}

// ── the hand-off to the agent (Q4) ──

/**
 * What the agent receives: the user's words (authoritative) and the confirmed card, never a
 * substituted prompt. Rejected examples and removed assumptions are said as such.
 */
export function handoffText(card: IntentCard): string {
  const out: string[] = [card.original.trim(), "", "---", "Confirmed request (the user checked this card; their words above win where they differ):", `- Goal: ${card.spec_en}`];
  out.push(`- Kind of task: ${card.task_type}`);
  if (card.inputs) out.push(`- Inputs: ${card.inputs}`);
  if (card.outputs) out.push(`- Outputs: ${card.outputs}`);
  const yes = card.examples.filter((e) => e.verdict !== "no" && e.output);
  const no = card.examples.filter((e) => e.verdict === "no");
  if (yes.length) out.push(`- Examples the user ${yes.every((e) => e.verdict === "yes") ? "confirmed" : "gave or kept"}:\n${yes.map((e) => `  - ${e.input} → ${e.output}`).join("\n")}`);
  if (no.length) out.push(`- NOT wanted (the user rejected these):\n${no.map((e) => `  - ${e.input} → ${e.output}`).join("\n")}`);
  if (card.edge_cases.length) out.push(`- Edge cases to handle: ${card.edge_cases.map((e) => e.text).join("; ")}`);
  if (card.targets.length) out.push(`- Files or symbols: ${card.targets.join(", ")}`);
  if (card.requirements.length) out.push(`- Requirements (in the user's words): ${card.requirements.map((r) => `"${r.quote ?? r.text}"`).join("; ")}`);
  const kept = card.assumptions.filter((a) => a.keep !== false);
  const dropped = card.assumptions.filter((a) => a.keep === false);
  if (kept.length) out.push(`- Assumptions the user kept: ${kept.map((a) => a.text).join("; ")}`);
  if (dropped.length) out.push(`- Don't do (the user removed these assumptions): ${dropped.map((a) => a.text).join("; ")}`);
  const answered = card.open_questions.filter((q) => q.answer);
  if (answered.length) out.push(`- Answers: ${answered.map((q) => `${q.text} → ${q.answer}`).join("; ")}`);
  if (card.acceptance_checks.length) out.push(`- Done when: ${card.acceptance_checks.join("; ")}`);
  if (card.out_of_scope.length) out.push(`- Out of scope: ${card.out_of_scope.join("; ")}`);
  return out.join("\n");
}

/** The card as a plan file (Save as Plan, B1). */
export function cardAsPlan(card: IntentCard): string {
  const lines = [`# Plan: ${capWords(card.spec_en, 14)}`, "", `> ${card.original.replace(/\n/g, "\n> ")}`, "", "## Goal", card.spec_en, ""];
  if (card.inputs || card.outputs) lines.push("## Inputs and outputs", `- In: ${card.inputs || "—"}`, `- Out: ${card.outputs || "—"}`, "");
  const ex = card.examples.filter((e) => e.verdict !== "no");
  if (ex.length) lines.push("## Examples", ...ex.map((e) => `- [${e.verdict === "yes" ? "x" : " "}] \`${e.input}\` → \`${e.output || "?"}\``), "");
  if (card.edge_cases.length) lines.push("## Edge cases", ...card.edge_cases.map((e) => `- ${e.text}`), "");
  if (card.targets.length) lines.push("## Files", ...card.targets.map((t) => `- ${t}`), "");
  if (card.acceptance_checks.length) lines.push("## Done when", ...card.acceptance_checks.map((c) => `- [ ] ${c}`), "");
  const kept = card.assumptions.filter((a) => a.keep !== false);
  if (kept.length) lines.push("## Assumptions", ...kept.map((a) => `- ${a.text}`), "");
  return lines.join("\n");
}

// ── accepted examples → unit tests (Q12, TiCoder) ──

const CALL = /^\s*([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*$/;

/** Is this example a function call with a literal result (`average([1, 2]) → 1.5`)? */
export function callExample(e: Pick<IntentExample, "input" | "output">): { fn: string; args: string; expected: string } | null {
  const m = CALL.exec(e.input);
  if (!m || !e.output.trim()) return null;
  const expected = e.output.trim();
  // A literal: number, string, list/array, object/dict, boolean, null/None.
  if (!/^(-?\d+(\.\d+)?|"[^"]*"|'[^']*'|\[[\s\S]*\]|\{[\s\S]*\}|\([\s\S]*\)|true|false|True|False|null|None|undefined)$/.test(expected)) return null;
  return { fn: m[1], args: m[2], expected };
}

/**
 * The confirmed call-shaped examples as a test file in the project's language (Python unittest
 * or node:test), next to the target. Null when no example is a call with a literal result.
 */
export function examplesToTests(examples: IntentExample[], target: string | null): { path: string; content: string } | null {
  const rows = examples.filter((e) => e.verdict === "yes").map(callExample).filter((x): x is NonNullable<ReturnType<typeof callExample>> => !!x);
  if (!rows.length || !target) return null;
  const dir = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
  const base = target.slice(target.lastIndexOf("/") + 1);
  const stem = base.replace(/\.[^.]+$/, "");
  const at = (p: string) => (dir ? `${dir}/${p}` : p);
  if (/\.py$/.test(base)) {
    const fns = [...new Set(rows.map((r) => r.fn))];
    const py = (v: string) => v.replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False").replace(/\bnull\b/g, "None");
    const body = rows.map((r, i) => `    def test_example_${i + 1}(self):\n        self.assertEqual(${r.fn}(${py(r.args)}), ${py(r.expected)})`).join("\n\n");
    return { path: at(`test_${stem}_examples.py`), content: `# Examples you confirmed on TMCode AI's card (accepted rows become tests).\nimport unittest\n\nfrom ${stem} import ${fns.join(", ")}\n\n\nclass ConfirmedExamples(unittest.TestCase):\n${body}\n\n\nif __name__ == "__main__":\n    unittest.main()\n` };
  }
  if (/\.(m?[jt]sx?|cjs)$/.test(base)) {
    const fns = [...new Set(rows.map((r) => r.fn))];
    const ext = /\.ts$/.test(base) ? "ts" : /\.mjs$/.test(base) ? "mjs" : "js";
    const js = (v: string) => v.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
    const body = rows.map((r, i) => `test("example ${i + 1}: ${r.fn}(${r.args.replace(/"/g, "'").slice(0, 40)})", () => {\n  assert.deepStrictEqual(${r.fn}(${js(r.args)}), ${js(r.expected)});\n});`).join("\n\n");
    return { path: at(`${stem}.examples.test.${ext}`), content: `// Examples you confirmed on TMCode AI's card (accepted rows become tests).\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ${fns.join(", ")} } from "./${base.replace(/\.ts$/, ".js")}";\n\n${body}\n` };
  }
  return null;
}

// ── a deterministic interpreter (the browser build's mock, the eval's rule baseline) ──

const GLOSSARY_RW: Record<string, string> = {
  ijambobanga: "password",
  "ijambo ry'ibanga": "password",
  ikosa: "error",
  amakosa: "errors",
  ubutumwa: "message",
  urupapuro: "page",
  ipaji: "page",
  buto: "button",
  ifoto: "image",
  izina: "name",
  amazina: "names",
  imibare: "numbers",
  umubare: "number",
  urutonde: "list",
  kubika: "save",
  gusiba: "delete",
  kongeramo: "add",
  kwerekana: "show",
  umukoresha: "user",
  kwinjira: "log in",
};
const GLOSSARY_FR: Record<string, string> = { "mot de passe": "password", erreur: "error", bouton: "button", liste: "list", afficher: "show", ajouter: "add", supprimer: "delete", utilisateur: "user", connexion: "login", fichier: "file", "page de connexion": "login page" };

function taskOf(t: string): TaskType {
  if (/\b(fix|bug|error|broken|crash|fails?|kosora|corrige|répare)\b/i.test(t)) return "fix";
  if (/\b(explain|what does|why|sobanura|explique)\b/i.test(t)) return "explain";
  if (/\b(tests?|unit test|teste)\b/i.test(t)) return "test";
  if (/\b(refactor|clean up|tidy|simplify)\b/i.test(t)) return "refactor";
  if (/\b(run|start|launch|lance)\b/i.test(t)) return "run";
  if (/\b(how do i|how to|learn|comment faire|nigute)\b/i.test(t)) return "learn";
  if (/\b(change|rename|update|modify|move|hindura|modifie|change)\b/i.test(t)) return "change";
  if (/\b(add|create|make|build|new|show|display|ajoute|crée|nshaka|ndashaka|kongeramo|ivuga|yerekane|herekane)\b/i.test(t)) return "add-feature";
  return "other";
}

/**
 * A rule-based card from the words alone: what the browser build's mock Task Mentor answers, and
 * the "rule" arm of the offline evaluation. Not the real interpreter (that is a model on Task Mentor).
 */
export function ruleCard(original: string, paths: string[] = []): IntentCard {
  const language = detectLanguage(original);
  const plain = stripPasted(original).text;
  const lower = plain.toLowerCase();
  const task = taskOf(plain);
  const targets = paths.filter((p) => {
    const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    const stem = base.replace(/\.[^.]+$/, "");
    return lower.includes(base) || (stem.length > 3 && new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower));
  });
  const clauses = plain
    .split(/(?:,|;|\.|\band\b|\bthen\b|\bkandi\b|\bet\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 2)
    .slice(0, 4);
  const examples: IntentExample[] = [];
  for (const m of plain.matchAll(/([^\s,;]+(?:\([^)]*\))?)\s*(?:->|→|=>|should (?:return|give|print))\s*([^\s,;]+)/gi)) examples.push({ input: m[1], output: m[2], verdict: null, by: "you" });
  const edge: IntentItem[] = [];
  if (/\b(list|array|urutonde|liste)\b/i.test(plain)) edge.push({ text: "an empty list", by: "ai", why: "Untested edge cases are the most common bug." });
  if (/\b(password|login|ijambobanga|mot de passe|connexion)\b/i.test(plain)) edge.push({ text: "an empty password", by: "ai", why: "Forms are often sent with a field left blank." });
  if (/\b(divide|average|mean|ratio)\b/i.test(plain)) edge.push({ text: "dividing by zero (no values)", by: "ai", why: "An average of nothing divides by zero." });
  const glossary: { term: string; en: string }[] = [];
  const dict = hasKinyarwanda(language) ? GLOSSARY_RW : language.startsWith("fr") ? GLOSSARY_FR : {};
  for (const [term, en] of Object.entries(dict)) if (lower.includes(term)) glossary.push({ term, en });
  let spec = plain.replace(/\s+/g, " ").trim();
  for (const g of glossary) spec = spec.replace(new RegExp(g.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), g.en);
  const sig = intentSignals(original, { mentions: targets.length });
  const open_questions: IntentQuestion[] = sig.reasons.includes("vague") || (!targets.length && !examples.length && sig.words < 8)
    ? [{ id: "q1", text: task === "fix" ? "What goes wrong now?" : "What should the result look like?", choices: task === "fix" ? ["It shows an error", "It gives a wrong result", "It does nothing"] : ["A message on the page", "A value returned by a function", "A file saved"], answer: null }]
    : [];
  return {
    version: 1,
    original,
    language,
    restated: capWords(`You want to: ${plain.replace(/\s+/g, " ")}`, CARD_LIMITS.restatedWords),
    spec_en: capWords(hasKinyarwanda(language) || language.startsWith("fr") ? `(from ${language}) ${spec}` : spec, CARD_LIMITS.specWords),
    task_type: task,
    inputs: /\b(password|login|form)\b/i.test(spec) ? "what the user types in the form" : /\b(list|array)\b/i.test(spec) ? "a list of values" : "",
    outputs: /\b(error|message)\b/i.test(spec) ? "a message on the page" : /\b(return|average|sum|count)\b/i.test(spec) ? "the computed value" : "",
    examples: examples.slice(0, CARD_LIMITS.examples),
    edge_cases: edge.slice(0, CARD_LIMITS.edgeCases),
    targets,
    requirements: clauses.map((c) => ({ text: c, by: "you" as By, quote: c })),
    assumptions: targets.length ? [{ text: "Keep the rest of the file as it is", by: "ai", why: "Small, focused changes are easier to check.", keep: true }] : [],
    open_questions,
    acceptance_checks: examples.length ? examples.map((e) => `WHEN ${e.input} THE PROGRAM SHALL give ${e.output}`) : [],
    out_of_scope: [],
    glossary,
    confidence: open_questions.length ? "low" : targets.length || examples.length ? "high" : "medium",
  };
}

/** The coach's rule-based answer (mock and eval baseline): missing items from the card's completeness. */
export function ruleCoach(original: string): CoachResult {
  const card = ruleCard(original);
  const c = completeness(card);
  const missing = c.missing.map((id) => ({ id: (id === "edge_case" ? "edge_case" : id) as MissingId, label: MISSING_LABEL[id as MissingId], question: defaultQuestion(id as MissingId) }));
  const segments: CoachResult["segments"] = card.requirements.map((r) => {
    const t = r.quote ?? r.text;
    if (VAGUE.test(t)) return { text: t, kind: "vague", note: "Say exactly what should happen instead." };
    return { text: t, kind: /\b(when|if|niba|iyo|si|quand)\b/i.test(t) ? "edge" : "goal" };
  });
  const vague = VAGUE.exec(original);
  if (vague && !segments.some((x) => x.kind === "vague")) segments.push({ text: vague[0], kind: "vague", note: "Say exactly what should happen instead." });
  return { version: 1, language: card.language, missing: missing.slice(0, 5), segments, ...(c.have.length ? { praise: `You already said: ${c.have.join(", ").replace("_", " ")}.` } : {}) };
}
