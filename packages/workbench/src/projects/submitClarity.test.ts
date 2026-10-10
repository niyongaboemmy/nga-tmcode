import { describe, expect, it } from "vitest";
import { pulledSummary } from "./service";
import { formatBytes, manifestLine, manifestOf, notIncludedLine } from "./submitFlow";
import { agoText, SYNC_LABEL, syncLineText } from "./syncLabels";

describe("what is handed in", () => {
  it("counts files and size, and what is left out", () => {
    const m = manifestOf({
      files: Array.from({ length: 23 }, (_, i) => ({ path: `f${i}`, sha256: "x", size: 1 })),
      total_bytes: 1_258_291,
      skipped: [
        { path: "node_modules", reason: "folder", dir: true, size: null },
        { path: "video.mp4", reason: "too-large", dir: false, size: 20_000_000 },
      ],
      skipped_count: 2,
    });
    expect(manifestLine(m)).toBe("23 files, 1.2 MB will be handed in");
    expect(notIncludedLine(m)).toBe("2 not included");
    expect(notIncludedLine(manifestOf({ files: [], total_bytes: 0 }))).toBeNull();
    expect(manifestLine(manifestOf({ files: [{ path: "a", sha256: "x", size: 1 }], total_bytes: 1 }))).toBe("1 file, 1 byte will be handed in");
    expect(formatBytes(2048)).toBe("2 KB");
  });
});

describe("pulls say what changed", () => {
  it("names the files, deleted ones marked", () => {
    expect(pulledSummary(["src/a.js"], ["b.css"])).toBe("Got 2 changes from Task Mentor: a.js, b.css (deleted).");
    expect(pulledSummary(["a", "b", "c", "d", "e", "f"], [])).toBe("Got 6 changes from Task Mentor: a, b, c, d and 2 more.");
    expect(pulledSummary(["todo.md"], [])).toBe("Got 1 change from Task Mentor: todo.md.");
  });
});

describe("one sync vocabulary", () => {
  it("uses the Projects view's words, with time and count", () => {
    expect(SYNC_LABEL.synced).toBe("Saved online");
    expect(SYNC_LABEL["local-changes"]).toBe("Not saved yet");
    expect(SYNC_LABEL["remote-changes"]).toBe("Newer version online");
    const now = 10_000_000;
    expect(syncLineText("synced", { savedAt: now - 120_000, now })).toBe("Saved online · 2 min ago");
    expect(syncLineText("synced", { savedAt: now - 5_000, now })).toBe("Saved online · just now");
    expect(syncLineText("local-changes", { changes: 3 })).toBe("Not saved yet · 3 changes");
    expect(syncLineText("offline")).toBe("Offline");
    expect(agoText(now - 3 * 3600_000, now)).toBe("3 h ago");
  });
});
