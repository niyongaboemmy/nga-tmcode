import { beforeEach, describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../platform/memory";
import type { Platform } from "../platform/types";
import { initWorkbench, resetWorkbenchForTests, useWorkbench } from "../state/store";
import { api, notifyError, TmError } from "./service";

/** N5: Task Mentor's failures in plain words, the codes behind Details. */
function platformAnswering(status: number, body: Record<string, unknown>) {
  const memory = new Map<string, unknown>();
  return {
    kind: "web",
    os: "mac",
    version: "test",
    fs: new MemoryFileSystem({}),
    store: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => void memory.set(k, v) },
    account: { request: async () => ({ status, body }) },
    async openFolder() {
      return null;
    },
    async reopenFolder() {
      return null;
    },
  } as unknown as Platform;
}

describe("api() errors", () => {
  beforeEach(() => resetWorkbenchForTests());

  it("a 500 with no message says so in words, with the code and request id as details", async () => {
    await initWorkbench(platformAnswering(500, { request_id: "r-42" }));
    const e = (await api("GET", "/assignments").catch((x) => x)) as TmError;
    expect(e).toBeInstanceOf(TmError);
    expect(e.message).toBe("Task Mentor had a problem. Try again in a minute.");
    expect(e.message).not.toMatch(/500/);
    expect(e.details).toBe("GET /assignments → 500 HTTP_500 · request r-42");
  });

  it("keeps Task Mentor's own words when it sends some", async () => {
    await initWorkbench(platformAnswering(409, { code: "QUIZ_NOT_OPEN", message: "Open the quiz in Task Mentor first." }));
    const e = (await api("POST", "/x").catch((x) => x)) as TmError;
    expect(e.message).toBe("Open the quiz in Task Mentor first.");
    expect(e.code).toBe("QUIZ_NOT_OPEN");
  });

  it("notifyError puts the details behind the Details link", async () => {
    await initWorkbench(platformAnswering(502, {}));
    notifyError(await api("GET", "/y").catch((x) => x));
    const n = useWorkbench.getState().notifications.at(-1)!;
    expect(n.message).toBe("Task Mentor had a problem. Try again in a minute.");
    expect(n.details).toMatch(/GET \/y → 502/);
    expect(n.kind).toBe("failure");
  });
});
