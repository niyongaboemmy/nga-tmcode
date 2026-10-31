import { onCodeEditor } from "../monaco/editors";
import { monaco } from "../monaco/setup";
import { useWorkbench } from "../state/store";

/**
 * Accessibility signals (VS Code's): short sounds for what a screen reader
 * user can't see — the cursor reaching a line with an error, a terminal
 * command or a task failing or finishing, the debugger stopping. On with the
 * screen reader ("auto"), always, or never (accessibility.signals).
 */

export type Signal = "lineHasError" | "lineHasWarning" | "terminalCommandFailed" | "taskCompleted" | "taskFailed" | "debugStopped";

/** Each signal's notes (Hz) and length: falling for problems, rising for success. */
export const TONES: Record<Signal, { notes: number[]; ms: number }> = {
  lineHasError: { notes: [660, 440], ms: 90 },
  lineHasWarning: { notes: [550], ms: 80 },
  terminalCommandFailed: { notes: [520, 350], ms: 110 },
  taskCompleted: { notes: [440, 660], ms: 90 },
  taskFailed: { notes: [440, 300], ms: 120 },
  debugStopped: { notes: [700, 700], ms: 70 },
};

export function signalsOn(): boolean {
  const s = useWorkbench.getState().settings;
  const mode = s["accessibility.signals"] ?? "auto";
  if (mode === "off") return false;
  if (mode === "on") return true;
  return s["editor.accessibilitySupport"] === "on";
}

let ctx: AudioContext | null = null;
/** Signals played (dev builds: window.__TMCODE_SIGNALS__, for tests). */
export const played: Signal[] = [];
if (typeof window !== "undefined" && import.meta.env?.DEV) (window as unknown as { __TMCODE_SIGNALS__: Signal[] }).__TMCODE_SIGNALS__ = played;

export function signal(name: Signal) {
  if (!signalsOn()) return;
  played.push(name);
  if (played.length > 50) played.shift();
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    const { notes, ms } = TONES[name];
    let t = ctx.currentTime;
    for (const hz of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + ms / 1000);
      t += ms / 1000;
    }
  } catch {
    /* no audio here */
  }
}

let wired = false;
/** The cursor moving onto a line with an error or a warning. */
export function wireSignals() {
  if (wired) return;
  wired = true;
  onCodeEditor((editor) => {
    let lastLine = -1;
    editor.onDidChangeCursorPosition((e) => {
      const line = e.position.lineNumber;
      if (line === lastLine) return;
      lastLine = line;
      const model = editor.getModel();
      if (!model || !signalsOn()) return;
      const markers = monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) => m.startLineNumber <= line && m.endLineNumber >= line);
      if (markers.some((m) => m.severity === monaco.MarkerSeverity.Error)) signal("lineHasError");
      else if (markers.some((m) => m.severity === monaco.MarkerSeverity.Warning)) signal("lineHasWarning");
    });
  });
}
