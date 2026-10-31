import { describe, expect, it } from "vitest";
import { addAttachments, ATTACH_LIMITS, attachmentText, formatSize, fromAttachedFile, fromBrowserFile, pastedAttachment, textAttachment } from "./attachments";

describe("attachments", () => {
  it("cuts long files and says so", () => {
    const a = textAttachment("big.txt", "x".repeat(ATTACH_LIMITS.chars + 10), 999_999, "/tmp/big.txt");
    expect(a.text!.length).toBe(ATTACH_LIMITS.chars);
    expect(a.truncated).toBe(true);
    expect(attachmentText([a])).toContain("Attached file big.txt (only the start: the rest was cut):");
  });

  it("names workspace files by path, outside files by name", () => {
    const ws = textAttachment("util.js", "1", 1, "lib/util.js");
    const os = textAttachment("notes.md", "2", 1, "/Users/a/notes.md");
    const win = textAttachment("w.txt", "3", 1, "C:\\Users\\a\\w.txt");
    const text = attachmentText([ws, os, win]);
    expect(text).toContain("Attached file lib/util.js:");
    expect(text).toContain("Attached file notes.md:");
    expect(text).toContain("Attached file w.txt:");
  });

  it("keeps the total under the limit and leaves images out of the text", () => {
    const many = Array.from({ length: 4 }, (_, i) => textAttachment(`f${i}`, "y".repeat(ATTACH_LIMITS.chars), 1, `f${i}`));
    const image = fromAttachedFile({ path: "/a.png", name: "a.png", size: 4, text: null, truncated: false, image: { mime: "image/png", base64: "AAAA" } });
    expect(typeof image).not.toBe("string");
    const text = attachmentText([...many, image as never]);
    expect(text.replace(/[^y]/g, "").length).toBe(ATTACH_LIMITS.totalChars);
    expect(text).not.toContain("a.png");
  });

  it("numbers pasted text and refuses binary files", () => {
    const first = pastedAttachment("a", []);
    expect(pastedAttachment("b", [first]).name).toBe("Pasted text #2");
    expect(fromAttachedFile({ path: "/x.bin", name: "x.bin", size: 3, text: null, truncated: false, image: null })).toMatch(/not a text file/);
  });

  it("adds up to the limit, skips the same file twice, reports errors once", () => {
    const files = Array.from({ length: 7 }, (_, i) => textAttachment(`f${i}`, "t", 1, `/p/f${i}`));
    const { list, errors } = addAttachments([], [...files, "bad one", "bad one"]);
    expect(list).toHaveLength(ATTACH_LIMITS.count);
    expect([...errors].sort()).toEqual(["bad one", `You can attach up to ${ATTACH_LIMITS.count} files to one question.`].sort());
    const again = addAttachments([files[0]], [textAttachment("f0", "t", 1, "/p/f0")]);
    expect(again.list).toHaveLength(1);
  });

  it("reads browser files: text, images, binary", async () => {
    const text = await fromBrowserFile(new File(["hello"], "a.txt", { type: "text/plain" }));
    expect(typeof text !== "string" && text.text).toBe("hello");
    const img = await fromBrowserFile(new File([new Uint8Array([137, 80, 78, 71])], "s.png", { type: "image/png" }));
    expect(typeof img !== "string" && img.kind).toBe("image");
    expect(await fromBrowserFile(new File([new Uint8Array([1, 0, 2])], "b.bin"))).toMatch(/not a text file/);
  });

  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
