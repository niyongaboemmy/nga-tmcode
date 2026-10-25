import { expect, test, type Page } from "@playwright/test";
import { command, openStudent, saveGradeAs, toast } from "./journeys";

/**
 * AI-assisted grading (docs/releases/0.22.0.md) against the memory account's mock Task Mentor:
 * an AI's draft (.tmcode/grading/draft.json, "Draft with AI", TMCode AI's agent) fills the grade
 * form as an AI draft the teacher reviews; only Save saves. Premium AI and own keys in TMCode AI.
 */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);
const mock = (page: Page, js: string) => page.evaluate(`(() => { const m = window.__TMCODE_PROJECTS__; return ${js}; })()`);
const ben = (page: Page) => mock(page, `m.gradeOf("assignment", 51, null, 21)`) as Promise<{ score: number; released: boolean; rubric_scores: { index: number; score: number; comment: string | null }[]; feedback: string } | null>;

async function teacher(page: Page, storage: Record<string, string> = {}) {
  await page.goto("/");
  await page.evaluate((extra) => {
    localStorage.clear();
    localStorage.setItem("tmcode:mock-account", "signed-in");
    for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
  }, storage);
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await mock(page, "m.setTeacher(true)");
  await command(page, "Grading: Refresh Grading");
  await expect(page.locator('.tm-activity[aria-label^="Grading"]')).toBeVisible({ timeout: 10_000 });
  await command(page, "View: Show Grading");
  await expect(page.getByTestId("grading-view")).toBeVisible();
}

async function gradeBen(page: Page) {
  await page.locator('[data-testid="grading-activity"][data-key="assignment:51:"]').click();
  await openStudent(page, "Ben Learner");
  await expect(page.getByTestId("load-project")).toHaveText(/open in the editor/, { timeout: 15_000 });
}

const scoreInputs = (page: Page) => page.getByTestId("grade-panel").locator(".tm-grade-criteria input.tm-grade-score");

test("an AI tool's draft.json fills the form as an AI draft; the teacher adjusts it and only Save saves", async ({ page }) => {
  await teacher(page);
  await gradeBen(page);

  // Claude Code (say) writes its draft: one score too high (14 of 12) is clamped.
  await externalWrite(
    page,
    ".tmcode/grading/draft.json",
    JSON.stringify({
      rubric_scores: [
        { index: 0, score: 14, comment: "Adding works (app.js:1)." },
        { index: 1, score: 6, comment: "Names are clear; the list variable could be const." },
      ],
      score: null,
      feedback: "Good start, Ben. Handle empty input next.",
      teacher_notes: "I could not run it in a browser.",
      confidence: "medium",
      by: "Claude Code",
    }),
  );
  const landed = toast(page, "Claude Code drafted grades for Ben Learner: review, adjust, then Save.");
  await expect(landed).toBeVisible();
  await expect(landed.getByRole("button", { name: "Review" })).toBeVisible();
  const banner = page.getByTestId("grade-ai-banner");
  await expect(banner).toContainText("AI draft by Claude Code");
  await expect(banner).toContainText("medium confidence");
  await expect(banner.getByTestId("grade-ai-notes")).toContainText("I could not run it in a browser.");
  await expect(banner.getByTestId("grade-ai-warnings")).toContainText('"Adding items works": 14 became 12');
  await expect(scoreInputs(page).nth(0)).toHaveValue("12");
  await expect(scoreInputs(page).nth(1)).toHaveValue("6");
  await expect(page.getByTestId("grade-feedback")).toHaveValue("Good start, Ben. Handle empty input next.");
  await expect(page.getByTestId("grade-ai-comment")).toHaveCount(2);
  // Nothing saved yet.
  expect(await ben(page)).toBeNull();
  if (process.env.AI_SHOTS) await page.screenshot({ path: `${process.env.AI_SHOTS}/ai-draft-banner.png` });

  // The teacher raises Code quality: that score is theirs now (its AI mark goes with the note still the AI's).
  const quality = page.getByTestId("grade-criterion").nth(1);
  await expect(quality.getByTestId("ai-tag")).toHaveCount(2);
  await scoreInputs(page).nth(1).fill("7");
  await expect(page.getByTestId("grade-total")).toContainText("19");
  await saveGradeAs(page, "release");
  await expect(page.getByTestId("grade-status")).toContainText("Grade saved: 19/20");
  await expect(page.getByTestId("grade-ai-banner")).toHaveCount(0);
  const saved = await ben(page);
  expect(saved?.score).toBe(19);
  expect(saved?.rubric_scores).toEqual([
    { index: 0, score: 12, comment: "Adding works (app.js:1)." },
    { index: 1, score: 7, comment: "Names are clear; the list variable could be const." },
  ]);

  // A broken draft says what is wrong and changes nothing.
  await externalWrite(page, ".tmcode/grading/draft.json", '{"rubric_scores": "all good", "by": "Gemini CLI"}');
  await expect(toast(page, /Gemini CLI's grading draft for Ben Learner couldn't be used: rubric_scores must be a list/)).toBeVisible();
  await expect(page.getByTestId("grade-ai-banner")).toHaveCount(0);
});

test("Draft with AI asks Task Mentor's AI (mode, focus), fills the form; Discard puts it back; an older Task Mentor says to update", async ({ page }) => {
  await teacher(page);
  await gradeBen(page);
  await page.getByTestId("grade-ai-draft").click();
  await page.getByTestId("grade-ai-prompt").fill("check input validation");
  await expect(page.getByTestId("grade-ai-box")).toContainText("Uses Free.");
  await page.getByTestId("grade-ai-run").click();
  const banner = page.getByTestId("grade-ai-banner");
  await expect(banner).toContainText("AI draft by TMCode AI · openai/gpt-oss-20b");
  await expect(page.getByTestId("grade-ai-box")).toHaveCount(0);
  await expect(scoreInputs(page).nth(0)).toHaveValue("10");
  await expect(scoreInputs(page).nth(1)).toHaveValue("8");
  await expect(page.getByTestId("grade-feedback")).toHaveValue(/focus: check input validation/);
  const body = (await mock(page, "m.lastAiDraftBody()")) as Record<string, unknown>;
  expect(body).toMatchObject({ mode: "free", instructions: "check input validation" });
  expect(body.byok).toBeUndefined();
  expect(await ben(page)).toBeNull();

  await banner.getByTestId("grade-ai-discard").click();
  await expect(page.getByTestId("grade-ai-banner")).toHaveCount(0);
  await expect(scoreInputs(page).nth(0)).toHaveValue("");

  // A Task Mentor without the endpoint.
  await page.evaluate(() => localStorage.setItem("tmcode:mock-ai-draft", "404"));
  await page.getByTestId("grade-ai-draft").click();
  await page.getByTestId("grade-ai-run").click();
  await expect(page.getByTestId("grade-ai-error")).toContainText("Update Task Mentor");
  await expect(scoreInputs(page).nth(0)).toHaveValue("");
});

test("TMCode AI's agent grades with the rubric: propose_grade fills the form, nothing is saved", async ({ page }) => {
  await teacher(page);
  await gradeBen(page);
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTestId("tmcode-ai-chat")).toBeVisible();
  await page.getByTestId("ai-input").fill("Grade this submission against the rubric");
  await page.getByTestId("ai-input").press("Enter");
  await expect(page.locator(".tm-chat-answer").last()).toContainText("I put a draft in your grade form", { timeout: 10_000 });
  const chatBody = (await mock(page, "m.lastAiChatBody()")) as { context?: { purpose?: string } };
  expect(chatBody.context?.purpose).toBe("grading");
  await page.locator(".tm-tab", { hasText: "Grade: Build a to-do list" }).click();
  await expect(page.getByTestId("grade-ai-banner")).toContainText("AI draft by TMCode AI");
  await expect(page.getByTestId("grade-ai-banner")).toContainText("high confidence");
  await expect(scoreInputs(page).nth(0)).toHaveValue("11");
  await expect(scoreInputs(page).nth(1)).toHaveValue("7");
  expect(await ben(page)).toBeNull();
});

test("premium models and own keys show where Task Mentor offers them; an own key goes with the request", async ({ page }) => {
  await teacher(page, { "tmcode:mock-ai-tiers": JSON.stringify({ premium: true, byok: true, staff: true }) });
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTestId("tmcode-ai-chat")).toBeVisible();
  await page.getByTestId("ai-mode").click();
  const picker = page.locator(".tm-quick-pick");
  await expect(picker).toContainText("Premium · 47 of 50 left today");
  await expect(picker).toContainText("claude-sonnet-4-5");
  await expect(picker).toContainText("Add Your Own API Key…");
  await picker.getByRole("option", { name: /claude-sonnet-4-5/ }).click();
  await expect(page.getByTestId("ai-mode")).toContainText("claude-sonnet-4-5 · Premium");

  // Settings › TMCode AI › Your API keys (from the model menu): the key goes to the keychain, never to localStorage.
  await page.getByTestId("ai-mode").click();
  await picker.getByRole("option", { name: /Add Your Own API Key/ }).click();
  const keys = page.getByTestId("ai-keys-settings");
  await expect(keys).toBeVisible();
  await expect(keys.getByTestId("ai-premium-note")).toContainText("47 of 50 requests left today");
  const openai = keys.locator('[data-provider="openai"]');
  await openai.getByTestId("ai-key-add").click();
  await openai.getByTestId("ai-key-input").fill("sk-test-123");
  await openai.getByTestId("ai-key-save").click();
  await expect(openai.getByTestId("ai-key-state")).toHaveText("Key saved");
  const stored = await page.evaluate(() => Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join("\n"));
  expect(stored).not.toContain("sk-test-123");

  await page.getByTestId("ai-mode").click();
  await expect(picker).toContainText("Your keys");
  await picker.getByRole("option", { name: /gpt-4\.1-mini/ }).click();
  await expect(page.getByTestId("ai-mode")).toContainText("gpt-4.1-mini · your OpenAI key");
  await page.getByTestId("ai-agent-mode").click();
  await page.getByTestId("ai-mode-chat").click();
  await page.getByTestId("ai-input").fill("Explain this code");
  await page.getByTestId("ai-input").press("Enter");
  await expect(page.locator(".tm-chat-answer").last().locator(".tm-chat-meta")).toBeVisible({ timeout: 10_000 });
  const body = (await mock(page, "m.lastAiChatBody()")) as { mode: string; byok?: { provider: string; key: string } };
  expect(body).toMatchObject({ mode: "byok:openai/gpt-4.1-mini", byok: { provider: "openai", key: "sk-test-123" } });
});

test("an older Task Mentor: no premium or own keys, Free only", async ({ page }) => {
  await teacher(page);
  await command(page, "TMCode AI: Manage Your API Keys");
  await expect(page.getByTestId("ai-keys-unavailable")).toContainText("doesn't accept own API keys yet");
  await page.keyboard.press("ControlOrMeta+i");
  await page.getByTestId("ai-mode").click();
  const picker = page.locator(".tm-quick-pick");
  await expect(picker).toContainText("Auto");
  await expect(picker).not.toContainText("Premium");
  await expect(picker).not.toContainText("Your keys");
});
