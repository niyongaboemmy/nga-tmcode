/**
 * Dev-only click and time counter for the golden journeys and usability
 * sessions (workflow plan 0.3): clicks and elapsed time between named
 * milestones ("home-shown", "first-start", "submitted", "first-student-open").
 * Off unless the dev build turns it on; nothing is ever sent anywhere.
 */

export type Milestone = "home-shown" | "first-start" | "submitted" | "first-student-open" | (string & {});

export interface JourneyMark {
  name: Milestone;
  /** Clicks since the journey started. */
  clicks: number;
  /** Milliseconds since the journey started. */
  ms: number;
}

interface JourneyState {
  on: boolean;
  start: number;
  clicks: number;
  marks: JourneyMark[];
}

const state: JourneyState = { on: false, start: 0, clicks: 0, marks: [] };
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
let listening = false;

function onClick() {
  if (state.on) state.clicks++;
}

/** Starts (or restarts) counting: from here, clicks and time are measured. */
export function startJourney() {
  state.on = true;
  state.start = now();
  state.clicks = 0;
  state.marks = [];
  if (!listening && typeof window !== "undefined") {
    // Capture: a click that closes a menu or opens a tab still counts.
    window.addEventListener("click", onClick, true);
    listening = true;
  }
}

/** A milestone reached (only the first time each name is reached counts). No-op unless a journey runs. */
export function markJourney(name: Milestone) {
  if (!state.on || state.marks.some((m) => m.name === name)) return;
  state.marks.push({ name, clicks: state.clicks, ms: Math.round(now() - state.start) });
}

/** What the journey measured so far. */
export function journeyReport(): { clicks: number; ms: number; marks: JourneyMark[] } {
  return { clicks: state.clicks, ms: state.on ? Math.round(now() - state.start) : 0, marks: [...state.marks] };
}

/** Stops counting (the marks stay readable until the next start). */
export function stopJourney() {
  state.on = false;
}

/** The handle the dev build exposes as `__TMCODE_DEBUG__.journey`. */
export const journeyDebug = { start: startJourney, mark: markJourney, report: journeyReport, stop: stopJourney };
