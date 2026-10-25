import { getPlatform } from "../state/store";
import { useProjects } from "../projects/service";
import { refreshAiStatusSoon, sseParser } from "./service";

/**
 * Keeps a line open to Task Mentor (GET /api/tmcode/ai/events) so a changed AI setting lands in
 * seconds: the school's policy in MIS, a teacher's AI mode for a quiz or assignment, or the roles.
 * Each `changed` (and the `hello` of every new line, which may follow a gap) asks for the AI status
 * again; the event itself decides nothing. The status poll in ai/project.ts stays as the fallback.
 *
 * The line reconnects after 2 s, doubling to 60 s while it keeps failing; it is only open while
 * signed in. A Task Mentor without the endpoint (404) is not asked again this session.
 */

export const EVENTS_PATH = "/api/tmcode/ai/events";
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
/** Many apps hear the same `changed`: spread their status requests over this much time. */
const SPREAD_MS = 1_500;

export interface LiveDeps {
  /** platform account.stream; undefined on a platform without streams. */
  stream?: (path: string, on: (e: import("../platform/types").TmStreamEvent) => void) => Promise<{ cancel(): void }>;
  refresh(delayMs: number): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  random(): number;
}

/** One live line, reconnecting; `start`/`stop` follow the sign-in. Exported for tests. */
export function createAiLive(deps: LiveDeps) {
  let handle: { cancel(): void } | null = null;
  let retry: unknown = null;
  let delay = FIRST_RETRY_MS;
  let wanted = false;
  let unsupported = false;
  let epoch = 0;

  const scheduleReconnect = () => {
    if (!wanted || unsupported || retry) return;
    retry = deps.setTimer(() => {
      retry = null;
      void open();
    }, delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  };

  async function open() {
    if (!wanted || unsupported || handle || !deps.stream) return;
    const mine = ++epoch;
    const lost = () => {
      if (mine !== epoch) return;
      handle = null;
      scheduleReconnect();
    };
    const parse = sseParser((name) => {
      if (mine !== epoch) return;
      if (name === "hello") {
        delay = FIRST_RETRY_MS;
        deps.refresh(0);
      } else if (name === "changed") deps.refresh(Math.floor(deps.random() * SPREAD_MS));
    });
    try {
      const h = await deps.stream(EVENTS_PATH, (e) => {
        if (mine !== epoch) return;
        if (e.type === "status") {
          if (e.status === 404) {
            unsupported = true;
            epoch++;
            handle?.cancel();
            handle = null;
          } else if (e.status >= 400) lost();
        } else if (e.type === "data") parse(e.data);
        else lost();
      });
      if (mine !== epoch || !wanted) h.cancel();
      else handle = h;
    } catch {
      lost();
    }
  }

  return {
    start() {
      wanted = true;
      void open();
    },
    stop() {
      wanted = false;
      epoch++;
      handle?.cancel();
      handle = null;
      if (retry) deps.clearTimer(retry);
      retry = null;
      delay = FIRST_RETRY_MS;
    },
    /** For tests and the status bar: is a line open (or being opened)? */
    get open() {
      return !!handle;
    },
    get unsupported() {
      return unsupported;
    },
  };
}

let wired = false;

/** Opens the line while signed in to NGA (ai/project.ts wires it with the rest of TMCode AI). */
export function wireAiLive() {
  if (wired) return;
  wired = true;
  const account = getPlatform().account;
  const live = createAiLive({
    stream: account?.stream?.bind(account),
    refresh: (ms) => refreshAiStatusSoon(ms),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    random: Math.random,
  });
  const follow = (signedIn: boolean) => (signedIn ? live.start() : live.stop());
  follow(!!useProjects.getState().account?.signed_in);
  useProjects.subscribe((s, prev) => {
    if (!!s.account?.signed_in !== !!prev.account?.signed_in) follow(!!s.account?.signed_in);
  });
}
