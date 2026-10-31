import { expect, test, type Page } from "@playwright/test";

/**
 * TMCode AI attachments, as in Claude Code: the paperclip, long pasted text
 * as a "Pasted text" chip, files dropped on the chat (from the OS or the
 * Explorer). Their text goes along with the question; the chips can be
 * removed; images wait for a model that can read them.
 */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const mock = (page: Page, js: string) => page.evaluate(`(() => { const m = window.__TMCODE_PROJECTS__; return ${js}; })()`);
const lastTask = async (page: Page) => ((await mock(page, "m.lastAiChatBody()")) as { context?: { task?: string } } | null)?.context?.task ?? "";

async function openChat(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:mock-account", "signed-in");
    localStorage.setItem("tmcode:e2e-no-home", "1");
  });
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTestId("tmcode-ai-chat")).toBeVisible();
  await page.getByTestId("ai-agent-mode").click();
  await page.getByTestId("ai-mode-chat").click();
}

const chips = (page: Page) => page.getByTestId("ai-attachment");

test("attach with the paperclip, remove one, and the rest goes with the question", async ({ page }) => {
  await openChat(page);
  await page.getByTestId("ai-attach-input").setInputFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("remember: the sum must be 42") },
    { name: "calc.py", mimeType: "text/x-python", buffer: Buffer.from("def add(a, b):\n    return a - b\n") },
  ]);
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).first()).toContainText("notes.txt");
  await page.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(chips(page)).toHaveCount(1);

  await page.getByTestId("ai-input").fill("Why is add wrong?");
  await page.keyboard.press("Enter");
  const q = page.locator(".tm-chat-q").last();
  await expect(q).toContainText("Why is add wrong?");
  await expect(q.locator(".tm-chat-chip")).toContainText(["calc.py"]);
  await expect(chips(page)).toHaveCount(0);
  await expect.poll(() => lastTask(page)).toContain("Attached file calc.py:\n```\ndef add(a, b):");
  expect(await lastTask(page)).not.toContain("the sum must be 42");
});

test("long pasted text becomes a chip; a file alone is a question too", async ({ page }) => {
  await openChat(page);
  const long = Array.from({ length: 200 }, (_, i) => `Traceback line ${i}`).join("\n");
  await page.getByTestId("ai-input").focus();
  await page.evaluate((text) => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-testid="ai-input"]')!;
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, long);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page)).toContainText("Pasted text #1");
  await expect(page.getByTestId("ai-input")).toHaveValue("");
  // Short text still pastes into the box.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-testid="ai-input"]')!;
    const data = new DataTransfer();
    data.setData("text/plain", "short");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(chips(page)).toHaveCount(1);

  await page.getByTestId("ai-send").click();
  await expect(page.locator(".tm-chat-q").last()).toContainText("Look at the attached file.");
  await expect.poll(() => lastTask(page)).toContain("Pasted text #1:\n```\nTraceback line 0");
});

test("files dropped on the chat attach; images wait for a model that reads them", async ({ page }) => {
  await openChat(page);
  const drop = (files: { name: string; type: string; body: string }[]) =>
    page.evaluate((list) => {
      const target = document.querySelector('[data-testid="tmcode-ai-chat"]')!;
      const data = new DataTransfer();
      for (const f of list) data.items.add(new File([f.body], f.name, { type: f.type }));
      target.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    }, files);
  await drop([{ name: "index.html", type: "text/html", body: "<h1>Hi</h1>" }]);
  await expect(chips(page)).toContainText("index.html");
  await drop([{ name: "shot.png", type: "image/png", body: "\x89PNG" }]);
  await expect(page.getByTestId("ai-attach-error")).toContainText("can't read images");
  await expect(chips(page)).toHaveCount(1);
});

test("an Explorer file dragged onto the chat attaches the workspace file", async ({ page }) => {
  await openChat(page);
  await page.evaluate(() => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite("lib/util.js", "export const twice = (x) => x * 2;\n"));
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="tmcode-ai-chat"]')!;
    const data = new DataTransfer();
    data.setData("application/x-tmcode-path", "lib/util.js");
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(chips(page)).toContainText("util.js");
  await page.getByTestId("ai-input").fill("Explain");
  await page.keyboard.press("Enter");
  await expect.poll(() => lastTask(page)).toContain("Attached file lib/util.js:");
});

test("no more than five attachments", async ({ page }) => {
  await openChat(page);
  await page.getByTestId("ai-attach-input").setInputFiles(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, mimeType: "text/plain", buffer: Buffer.from(`file ${i}`) })));
  await expect(chips(page)).toHaveCount(5);
  await expect(page.getByTestId("ai-attach-error")).toContainText("up to 5 files");
});
