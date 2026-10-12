import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HINT_MS, RESULT_MS, UNDO_MS, kindOf, lifetimeOf, shownInDnd, withPolicy } from "./notifications";
import { dismissNotification, notify, notifyProgress, pauseToast, resetWorkbenchForTests, resumeToast, useWorkbench } from "./store";
import { markAllRead, recordToasts, unreadCount, visibleToasts } from "./notificationCenter";

const info = { severity: "info" as const };

describe("notification policy: kinds and lifetimes", () => {
  it("keeps older calls as they were: plain info 6 s, buttons and warnings stay, errors are failures", () => {
    expect(kindOf(info)).toBe("hint");
    expect(lifetimeOf(info)).toBe(HINT_MS);
    expect(lifetimeOf({ ...info, actions: [{ label: "Open" }] })).toBeNull();
    expect(lifetimeOf({ severity: "warning" })).toBeNull();
    expect(kindOf({ severity: "error" })).toBe("failure");
    expect(lifetimeOf({ severity: "error" })).toBeNull();
  });
  it("results last 8 s, or until dismissed when important", () => {
    expect(lifetimeOf({ ...info, kind: "result" })).toBe(RESULT_MS);
    expect(lifetimeOf({ ...info, kind: "result", actions: [{ label: "Open" }] })).toBe(RESULT_MS);
    expect(lifetimeOf({ ...info, kind: "result", important: true })).toBeNull();
  });
  it("external news, failures and progress stay", () => {
    expect(lifetimeOf({ ...info, kind: "external" })).toBeNull();
    expect(lifetimeOf({ ...info, kind: "failure" })).toBeNull();
    expect(lifetimeOf({ ...info, progress: 40 })).toBeNull();
    expect(lifetimeOf({ ...info, progress: null, cancel: () => {} })).toBeNull();
  });
  it("Undo keeps a toast for at least 10 s", () => {
    expect(lifetimeOf({ ...info, kind: "hint", undo: () => {} })).toBe(UNDO_MS);
    expect(kindOf({ ...info, undo: () => {} })).toBe("result");
  });
});

describe("notification policy: Do Not Disturb", () => {
  it("hides hints and ordinary results, shows failures, progress and important results", () => {
    expect(shownInDnd(info)).toBe(false);
    expect(shownInDnd({ ...info, kind: "result" })).toBe(false);
    expect(shownInDnd({ ...info, kind: "external" })).toBe(false);
    expect(shownInDnd({ severity: "error" })).toBe(true);
    expect(shownInDnd({ ...info, kind: "failure" })).toBe(true);
    expect(shownInDnd({ ...info, progress: null })).toBe(true);
    expect(shownInDnd({ ...info, kind: "result", important: true })).toBe(true);
    expect(shownInDnd({ ...info, kind: "external", bypassDnd: true })).toBe(true);
  });
  it("exams and teacher messages always get through, whatever the caller passed", () => {
    expect(withPolicy(info, { source: "exam", bypassDnd: false }).bypassDnd).toBe(true);
    expect(withPolicy(info, { source: "teacher" }).bypassDnd).toBe(true);
    expect(withPolicy(info, {}).bypassDnd).toBe(false);
  });
  it("hides nothing during an exam", () => {
    expect(shownInDnd(info, true)).toBe(true);
    const list = [
      { id: 1, message: "hint", ...info },
      { id: 2, message: "boom", severity: "error" as const },
    ];
    expect(visibleToasts(list, true).map((n) => n.id)).toEqual([2]);
    expect(visibleToasts(list, true, true).map((n) => n.id)).toEqual([1, 2]);
    expect(visibleToasts(list, false).map((n) => n.id)).toEqual([1, 2]);
  });
});

describe("notify() with the policy", () => {
  beforeEach(() => {
    resetWorkbenchForTests();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());
  const messages = () => useWorkbench.getState().notifications.map((n) => n.message);

  it("an important result survives past 10 s; an ordinary one goes after 8 s", () => {
    notify("info", "Submitted", undefined, { kind: "result", important: true });
    notify("info", "Workspace ready", undefined, { kind: "result" });
    vi.advanceTimersByTime(RESULT_MS + 1);
    expect(messages()).toEqual(["Submitted"]);
    vi.advanceTimersByTime(60_000);
    expect(messages()).toEqual(["Submitted"]);
  });

  it("a hovered toast keeps its remaining time", () => {
    const id = notify("info", "Copied path");
    vi.advanceTimersByTime(4000);
    pauseToast(id);
    vi.advanceTimersByTime(30_000);
    expect(messages()).toEqual(["Copied path"]);
    resumeToast(id);
    vi.advanceTimersByTime(1500);
    expect(messages()).toEqual(["Copied path"]);
    vi.advanceTimersByTime(1000);
    expect(messages()).toEqual([]);
  });

  it("replaceKey shows one time warning, not three", () => {
    const a = notify("warning", "10 minutes left", undefined, { replaceKey: "exam-time", source: "exam" });
    const b = notify("warning", "5 minutes left", undefined, { replaceKey: "exam-time", source: "exam" });
    notify("warning", "1 minute left", undefined, { replaceKey: "exam-time", source: "exam" });
    expect(b).toBe(a);
    expect(messages()).toEqual(["1 minute left"]);
    expect(useWorkbench.getState().notifications[0].bypassDnd).toBe(true);
  });

  it("a replaced toast's timer starts again", () => {
    notify("info", "Saving…", undefined, { kind: "hint", replaceKey: "k" });
    vi.advanceTimersByTime(HINT_MS - 100);
    notify("info", "Saved", undefined, { kind: "hint", replaceKey: "k" });
    vi.advanceTimersByTime(HINT_MS - 100);
    expect(messages()).toEqual(["Saved"]);
    vi.advanceTimersByTime(200);
    expect(messages()).toEqual([]);
  });

  it("keeps important toasts when the list is full", () => {
    notify("info", "Submitted", undefined, { kind: "result", important: true });
    for (let i = 0; i < 8; i++) notify("error", `e${i}`);
    expect(messages()).toContain("Submitted");
  });

  it("a progress notification updates its percentage until it closes", () => {
    const p = notifyProgress("Downloading the update");
    p.update({ progress: 42, message: "Downloading the update 42%" });
    expect(useWorkbench.getState().notifications[0]).toMatchObject({ progress: 42 });
    vi.advanceTimersByTime(60_000);
    expect(messages()).toHaveLength(1);
    p.close();
    expect(messages()).toHaveLength(0);
  });
});

describe("notification centre: unread", () => {
  it("counts things that arrived from outside until read", () => {
    let h = recordToasts([], [{ id: 1, message: "New assignment", severity: "info", kind: "external" }], 1);
    h = recordToasts(h, [{ id: 2, message: "Copied", severity: "info" }], 2);
    expect(unreadCount(h)).toBe(1);
    expect(h.find((x) => x.id === 2)?.unread).toBeFalsy();
  });
  it("markAllRead clears the count", async () => {
    const { useNotificationCenter } = await import("./notificationCenter");
    useNotificationCenter.setState({ history: recordToasts([], [{ id: 9, message: "Graded", severity: "info", kind: "external" }], 1) });
    expect(unreadCount(useNotificationCenter.getState().history)).toBe(1);
    markAllRead();
    expect(unreadCount(useNotificationCenter.getState().history)).toBe(0);
    dismissNotification(9);
  });
});

describe("calm messages: owners", () => {
  beforeEach(() => {
    resetWorkbenchForTests();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());
  const toasts = () => useWorkbench.getState().notifications.filter((n) => !n.silent).map((n) => n.message);

  it("a newer message about the same thing replaces the older one", () => {
    notify("info", "Submitted", undefined, { kind: "result", important: true, owner: "assignment:51" });
    notify("info", "Returned", undefined, { kind: "external", owner: "assignment:51" });
    notify("info", "Graded", undefined, { kind: "external", owner: "assignment:51" });
    expect(toasts()).toEqual(["Graded"]);
  });

  it("news about what is already in front goes to the centre only", () => {
    useWorkbench.setState({ groups: [{ id: 0, editors: [{ kind: "assignment", id: "assignment:51", assignmentId: 51, title: "x", preview: false }], activeId: "assignment:51" }] });
    notify("info", "Graded", undefined, { kind: "external", owner: "assignment:51" });
    expect(toasts()).toEqual([]);
    expect(useWorkbench.getState().notifications.find((n) => n.message === "Graded")?.silent).toBe(true);
    vi.advanceTimersByTime(1);
    expect(useWorkbench.getState().notifications).toHaveLength(0);
    // Errors are never silenced.
    notify("error", "Saving failed", undefined, { owner: "assignment:51" });
    expect(toasts()).toEqual(["Saving failed"]);
  });

  it("the centre keeps only the newest entry of a thing", () => {
    let h = recordToasts([], [{ id: 1, message: "Returned", severity: "info", kind: "external", owner: "assignment:51" }], 1);
    h = recordToasts(h, [{ id: 2, message: "Graded", severity: "info", kind: "external", owner: "assignment:51" }], 2);
    h = recordToasts(h, [{ id: 3, message: "Copied", severity: "info" }], 3);
    expect(h.map((x) => x.message)).toEqual(["Copied", "Graded"]);
  });

  it("shows at most two toasts", async () => {
    const { MAX_VISIBLE_TOASTS } = await import("./notifications");
    expect(MAX_VISIBLE_TOASTS).toBe(2);
  });
});
