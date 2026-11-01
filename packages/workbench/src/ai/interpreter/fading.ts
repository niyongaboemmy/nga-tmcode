import type { CardStage } from "./policy";

/**
 * Guided's teach-and-fade (prompt interpreter report, Q7): the full card while a student learns
 * what a complete request says, then hint mode (missing items flagged, the student fills them in),
 * then only the one-line "Understood as …" strip. It moves on after a few requests the student
 * made complete with little help, and back when quality drops. The teacher can pin a stage
 * (Task Mentor's ai_help.interpreter), which wins over this. Per account, on this computer.
 */

export interface FadeEntry {
  /** Fields the interpreter added that the student kept. */
  additions: number;
  /** What the student's own words carried (0–1). */
  completeness: number;
  at: number;
}

export interface FadeState {
  stage: CardStage;
  history: FadeEntry[];
}

const ORDER: CardStage[] = ["full", "hint", "strip"];
const KEEP = 8;
/** Move on: the last 3 requests were complete (≥ 4 of 6 items) with at most one added field each. */
const ADVANCE = { window: 3, completeness: 0.66, additions: 1 };
/** Move back: the last 2 requests carried under half of the items. */
const REGRESS = { window: 2, completeness: 0.5 };

export const INITIAL: FadeState = { stage: "full", history: [] };

/** The next state after a card the student confirmed (pure). */
export function nextFade(state: FadeState, entry: FadeEntry): FadeState {
  const history = [...state.history, entry].slice(-KEEP);
  const i = ORDER.indexOf(state.stage);
  // The history restarts at each change of stage, so a fresh stage earns its own run.
  const recent = (n: number) => history.slice(-n);
  const lastAdv = recent(ADVANCE.window);
  if (i < ORDER.length - 1 && lastAdv.length === ADVANCE.window && lastAdv.every((e) => e.completeness >= ADVANCE.completeness && e.additions <= ADVANCE.additions)) {
    return { stage: ORDER[i + 1], history: [] };
  }
  const lastReg = recent(REGRESS.window);
  if (i > 0 && lastReg.length === REGRESS.window && lastReg.every((e) => e.completeness < REGRESS.completeness)) {
    return { stage: ORDER[i - 1], history: [] };
  }
  return { stage: state.stage, history };
}

const key = (account: string | number | null | undefined) => `tmcode:intent-fade:${account ?? "anon"}`;

export function loadFade(account: string | number | null | undefined): FadeState {
  try {
    const raw = localStorage.getItem(key(account));
    if (!raw) return INITIAL;
    const v = JSON.parse(raw) as FadeState;
    return ORDER.includes(v.stage) && Array.isArray(v.history) ? v : INITIAL;
  } catch {
    return INITIAL;
  }
}

export function saveFade(account: string | number | null | undefined, state: FadeState) {
  try {
    localStorage.setItem(key(account), JSON.stringify(state));
  } catch {
    /* private mode */
  }
}
