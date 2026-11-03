import { beforeEach, describe, expect, it } from "vitest";
import { dismissNotification, resetWorkbenchForTests, useWorkbench } from "../state/store";
import { showMessage } from "./messages";

describe("extension messages", () => {
  beforeEach(() => resetWorkbenchForTests());

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
});
