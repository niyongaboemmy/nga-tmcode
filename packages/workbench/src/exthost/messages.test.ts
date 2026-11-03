import { beforeEach, describe, expect, it } from "vitest";
import { dismissNotification, resetWorkbenchForTests, useWorkbench } from "../state/store";
import { recordToasts, unreadCount, visibleToasts } from "../state/notificationCenter";
import { resetSpamProtectionForTests, showMessage, spamCheck } from "./messages";

describe("extension messages", () => {
  beforeEach(() => {
    resetWorkbenchForTests();
    resetSpamProtectionForTests();
  });

  it("shows one toast for the same question asked again and again, and answers every ask", async () => {
    const asks = Array.from({ length: 50 }, () => showMessage("info", "Take a 5-question survey?", {}, ["Yes", "No"]));
    const list = useWorkbench.getState().notifications;
    expect(list).toHaveLength(1);
    list[0].actions![1].run();
    expect(await Promise.all(asks)).toEqual(Array(50).fill(1));
    expect(useWorkbench.getState().notifications).toHaveLength(0);
  });

  it("answers undefined when the toast closes without a choice, and can ask again after", async () => {
    const first = showMessage("warning", "Reload?", {}, ["Reload"]);
    dismissNotification(useWorkbench.getState().notifications[0].id);
    expect(await first).toBeNull();
    void showMessage("warning", "Reload?", {}, ["Reload"]);
    expect(useWorkbench.getState().notifications).toHaveLength(1);
  });

  it("keeps different messages apart", () => {
    void showMessage("info", "A", {}, ["OK"]);
    void showMessage("info", "B", {}, ["OK"]);
    void showMessage("error", "A", {}, ["OK"]);
    expect(useWorkbench.getState().notifications).toHaveLength(3);
  });

  it("info that asks waits quietly under the bell, buttons and all; plain info and warnings still pop up", () => {
    void showMessage("info", "Take a survey?", {}, ["Yes"]);
    void showMessage("info", "Committed", {}, []);
    void showMessage("warning", "Reload to update", {}, ["Reload"]);
    const all = useWorkbench.getState().notifications;
    expect(all).toHaveLength(3);
    expect(visibleToasts(all, false).map((n) => n.message)).toEqual(["Committed", "Reload to update"]);
    // The bell counts it until it is seen.
    expect(unreadCount(recordToasts([], all, 0))).toBe(1);
  });

  it("pops up info too when notifications.extensionInfo is toast", () => {
    useWorkbench.setState({ settings: { ...useWorkbench.getState().settings, "notifications.extensionInfo": "toast" } });
    void showMessage("info", "Take a survey?", {}, ["Yes"]);
    expect(visibleToasts(useWorkbench.getState().notifications, false)).toHaveLength(1);
  });

  it("spam protection: a fourth new toast within 800 ms goes to the centre only, as in VS Code", () => {
    let times: number[] = [];
    const spam = [0, 100, 200, 300, 1200].map((t) => {
      const r = spamCheck(times, t);
      times = r.times;
      return r.spam;
    });
    expect(spam).toEqual([false, false, false, true, false]);
  });
});
