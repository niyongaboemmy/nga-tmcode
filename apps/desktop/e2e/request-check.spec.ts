import { expect, test, type Page } from "@playwright/test";

/**
 * The request check (reports/TMCode prompt interpreter layer.md) in the browser build, with the
 * mock Task Mentor (platform/memoryAi.ts answers /interpret with the shared rule card and coach):
 * Guided's card with "your turn" and the hand-off; a Kinyarwanda request restated with a
 * glossary; Open's on-demand ✨ / ⌘⇧Enter, Esc back to the words, "as typed"; Learning's coach
 * with the live checklist; pass-through when the check fails; the A/B holdout; the live request
 * meter; Prompt Problems; and the card in a narrow side bar.
 */

const mock = (page: Page, js: string) => page.evaluate(`(() => { const m = window.__TMCODE_PROJECTS__; return ${js}; })()`);

async function fresh(page: Page, policy: Record<string, unknown>, interpreter: Record<string, unknown> | null = null) {
  await page.goto("/");
  await page.evaluate(
    ([p, i]) => {
      localStorage.clear();
      localStorage.setItem("tmcode:mock-account", "signed-in");
      localStorage.setItem("tmcode:e2e-no-home", "1");
      localStorage.setItem("tmcode:mock-ai-policy", JSON.stringify(p));
      if (i) localStorage.setItem("tmcode:mock-interpreter", JSON.stringify(i));
    },
    [policy, interpreter] as const,
  );
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTestId("ai-input")).toBeVisible();
}

const STUDENT = { allowed: true, reason: "ALLOWED_BY_TEACHER", message: "", layer: "industrial", mode: "full", staff: false, thirdPartyExtensions: false };
const STAFF = { allowed: true, reason: "ALLOWED_BY_ROLE", message: "", layer: "industrial", staff: true };
const LEARNER = { allowed: true, reason: "ALLOWED_BY_TEACHER", message: "", layer: "learning", staff: false };

async function type(page: Page, text: string) {
  const input = page.getByTestId("ai-input");
  await input.click();
  await input.fill(text);
}

test("Guided: the card shows what was understood; the student adds their part; the agent gets the words plus the card", async ({ page }) => {
  await fresh(page, STUDENT);
  await type(page, "write a function that sorts the students list");
  // The live meter shows which of the six things the request says.
  await expect(page.getByTestId("request-meter")).toBeVisible();
  await page.keyboard.press("Enter");
  const card = page.getByTestId("intent-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("intent-restated")).toContainText("sorts the students list");
  await expect(page.getByTestId("intent-panel")).toHaveAttribute("data-stage", "full");
  // Your turn: nothing goes until the student says one thing themselves.
  await expect(page.getByTestId("intent-your-turn")).toContainText("Your turn");
  await expect(page.getByTestId("intent-confirm")).toBeDisabled();
  await page.getByTestId("intent-edge-add").fill("two students with the same name");
  await page.getByTestId("intent-edge-add").press("Enter");
  await expect(page.getByTestId("intent-your-turn")).toContainText("you added your part");
  // An example with a result, ticked ✓.
  await page.getByTestId("intent-example-add-input").fill('sort_students(["Bo", "Al"])');
  await page.getByTestId("intent-example-add-output").fill('["Al", "Bo"]');
  await page.getByTestId("intent-example-add").click();
  await expect(page.getByTestId("intent-example").last()).toHaveClass(/is-yes/);
  await page.getByTestId("intent-confirm").click();
  await expect(page.getByTestId("intent-panel")).toHaveCount(0);
  // The question shows the student's words, marked as checked; the AI got the card too.
  const q = page.locator(".tm-chat-q").last();
  await expect(q.locator(".tm-chat-q-text")).toHaveText("write a function that sorts the students list");
  await expect(q.getByTestId("ai-question-checked")).toContainText("Checked");
  const body = (await mock(page, "m.lastAiChatBody()")) as { messages: { role: string; content: string }[] };
  const sent = String(body.messages.filter((m) => m.role === "user").pop()?.content);
  expect(sent.startsWith("write a function that sorts the students list")).toBe(true);
  expect(sent).toContain("Confirmed request");
  expect(sent).toContain("two students with the same name");
  expect(sent).toContain('sort_students(["Bo", "Al"]) → ["Al", "Bo"]');
  // The interpreter saw the words and file paths, never file contents.
  const interp = (await mock(page, "m.lastInterpretBody()")) as { text: string; paths?: string[]; guided?: boolean };
  expect(interp.text).toBe("write a function that sorts the students list");
  expect(interp.guided).toBe(true);
  // The Activity log has the evidence.
  if (!(await page.locator(".tm-panel").isVisible())) await page.keyboard.press("ControlOrMeta+j");
  await page.locator(".tm-panel-tab", { hasText: "Activity" }).click();
  await expect(page.getByTestId("activity-view")).toContainText("Request check (full card): confirmed after editing", { timeout: 10000 });
});

test("a Kinyarwanda request is restated in the student's words, with the English terms", async ({ page }) => {
  await fresh(page, STUDENT);
  await type(page, "ndashaka kwerekana ubutumwa bw'ikosa niba ijambobanga ari ribi");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("intent-card")).toBeVisible();
  await expect(page.getByTestId("intent-language")).toContainText("Kinyarwanda");
  const g = page.getByTestId("intent-glossary");
  await expect(g).toContainText("ijambobanga");
  await expect(g).toContainText("password");
  // What the AI gets is in English.
  await page.getByTestId("intent-for-ai").click();
  await expect(page.getByTestId("intent-spec")).toHaveValue(/password/);
});

test("Open (staff): on demand with ✨ or ⌘⇧Enter; Esc goes back to the words; 'as typed' sends them", async ({ page }) => {
  await fresh(page, STAFF);
  // A clear request goes straight to the AI.
  await type(page, "Explain what the loop in js/app.js does, line by line.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-chat-answer").last()).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("intent-panel")).toHaveCount(0);
  await expect(page.getByTestId("request-meter")).toHaveCount(0);
  await expect(page.getByTestId("ai-send")).toBeVisible({ timeout: 10000 });
  // ✨ checks on demand.
  await type(page, "add a form");
  await page.getByTestId("ai-check-meaning").click();
  await expect(page.getByTestId("intent-card")).toBeVisible();
  await expect(page.getByTestId("intent-your-turn")).toHaveCount(0);
  // Esc: back to the words.
  await page.getByTestId("intent-panel").press("Escape");
  await expect(page.getByTestId("intent-panel")).toHaveCount(0);
  await expect(page.getByTestId("ai-input")).toHaveValue("add a form");
  // ⌘⇧Enter: check again; ⌘Enter on the card: send as typed.
  await page.getByTestId("ai-input").press("ControlOrMeta+Shift+Enter");
  await expect(page.getByTestId("intent-card")).toBeVisible();
  await page.getByTestId("intent-as-is").click();
  await expect(page.locator(".tm-chat-q").last().locator(".tm-chat-q-text")).toHaveText("add a form");
  await expect(page.locator(".tm-chat-q").last().getByTestId("ai-question-checked")).toHaveCount(0);
});

test("Learning: the coach shows what's missing in the student's own words, never a rewrite; the checklist ticks as they improve it", async ({ page }) => {
  await fresh(page, LEARNER);
  await type(page, "make it work");
  await page.keyboard.press("Enter");
  const coach = page.getByTestId("coach-panel");
  await expect(coach).toBeVisible();
  await expect(page.getByTestId("coach-segment").filter({ hasText: "make it work" })).toHaveClass(/is-vague/);
  await expect(page.getByTestId("coach-missing").first()).toBeVisible();
  // There is no improved request anywhere: only questions.
  await expect(coach).not.toContainText("Here is a better");
  await page.getByTestId("coach-improve").click();
  await expect(page.getByTestId("ai-input")).toHaveValue("make it work");
  const checklist = page.getByTestId("coach-checklist");
  await expect(checklist).toBeVisible();
  const doneBefore = await checklist.locator(".tm-pcoach-tick.is-done").count();
  await type(page, "make the average function return 0 when the list is empty, for example average([]) -> 0");
  await expect.poll(async () => checklist.locator(".tm-pcoach-tick.is-done").count()).toBeGreaterThan(doneBefore);
  await page.keyboard.press("Enter");
  await expect(coach).toBeVisible();
  await page.getByTestId("coach-ask-anyway").click();
  await expect(page.locator(".tm-chat-q").last().locator(".tm-chat-q-text")).toContainText("average([]) -> 0");
});

test("when the check fails, the words go as they are and a small note says so", async ({ page }) => {
  await fresh(page, STUDENT, { fail: "INTERPRETER_INVALID" });
  await type(page, "write a function that sorts the students list");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("intent-note")).toContainText("your words went as they are");
  await expect(page.locator(".tm-chat-q").last().locator(".tm-chat-q-text")).toHaveText("write a function that sorts the students list");
});

test("the A/B holdout never sees the card or the meter", async ({ page }) => {
  await fresh(page, STUDENT, { arm: "holdout" });
  await type(page, "write a function that sorts the students list");
  await expect(page.getByTestId("request-meter")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-chat-q").last()).toBeVisible();
  await expect(page.getByTestId("intent-panel")).toHaveCount(0);
});

test("a Prompt Problem: the AI writes from the student's words only, and passes when the words say it all", async ({ page }) => {
  await fresh(page, STUDENT, {
    prompt_problem: {
      language: "javascript",
      entry: "solution.js",
      examples: [
        { input: "is_even(4)", output: "true" },
        { input: "is_even(7)", output: "false" },
      ],
      hidden: [{ input: "is_even(10)", output: "true" }],
      instructions: "Describe a function is_even.",
      hints: true,
    },
  });
  const pp = page.getByTestId("prompt-problem");
  await expect(pp).toBeVisible();
  await expect(page.getByTestId("prompt-problem-example")).toHaveCount(2);
  await expect(page.getByTestId("prompt-problem-hidden")).toContainText("1 hidden example");
  // A vague request: the AI guesses, and an example fails.
  await page.getByTestId("prompt-problem-input").fill("write is_even that says if a number is even");
  await page.getByTestId("prompt-problem-run").click();
  await expect(page.getByTestId("prompt-problem-example").nth(1)).toHaveClass(/is-fail/, { timeout: 10000 });
  await expect(page.getByTestId("prompt-problem-solved")).toHaveCount(0);
  // Say exactly how evenness is decided: solved, the hidden example too.
  await page.getByTestId("prompt-problem-input").fill("write is_even(n): true when n divided by 2 leaves remainder 0, otherwise false");
  await page.getByTestId("prompt-problem-run").click();
  await expect(page.getByTestId("prompt-problem-solved")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("prompt-problem-hidden")).toContainText("1/1 hidden examples passed");
  await expect(page.getByTestId("prompt-problem-score")).toHaveText("3/3");
});

test("the card fits a narrow side bar (no sideways scrolling)", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 760 });
  await fresh(page, STUDENT);
  await type(page, "write a function that sorts the students list");
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("intent-panel");
  await expect(page.getByTestId("intent-card")).toBeVisible();
  const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("intent-confirm")).toBeVisible();
});
