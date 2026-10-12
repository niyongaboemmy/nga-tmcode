import { expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Golden journeys (docs/plans/2026-10-12-workflow-ux-implementation-plan.md §4, 0.1/0.3):
 * shared setup, screenshots in test-results/journeys/ for a person to review,
 * and the dev build's click and time counter (`__TMCODE_DEBUG__.journey`).
 */

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test-results", "journeys");

export type Mock = Record<string, (...args: never[]) => unknown>;
export const mock = (page: Page, js: string) => page.evaluate(`(() => { const m = window.__TMCODE_PROJECTS__; return ${js}; })()`);

/**
 * Seeds the browser before the app starts (never goto → write → reload: a
 * startup save can overwrite the seed), once per test, and turns the journey
 * counter on from the first frame.
 */
export async function launch(page: Page, opts: { teacher?: boolean; signedIn?: boolean; storage?: Record<string, string> } = {}) {
  await page.addInitScript(
    ({ teacher, signedIn, storage }) => {
      (window as unknown as { __TMCODE_JOURNEY__: boolean }).__TMCODE_JOURNEY__ = true;
      if (sessionStorage.getItem("journey-seeded")) return;
      sessionStorage.setItem("journey-seeded", "1");
      localStorage.clear();
      if (signedIn) localStorage.setItem("tmcode:mock-account", "signed-in");
      if (teacher) localStorage.setItem("tmcode:mock-teacher", "1");
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    },
    { teacher: !!opts.teacher, signedIn: opts.signedIn !== false, storage: opts.storage ?? {} },
  );
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

export interface JourneyReport {
  clicks: number;
  ms: number;
  marks: { name: string; clicks: number; ms: number }[];
}

export const report = (page: Page) => page.evaluate(() => (window as unknown as { __TMCODE_DEBUG__: { journey: { report(): JourneyReport } } }).__TMCODE_DEBUG__.journey.report()) as Promise<JourneyReport>;

/** Clicks counted when a milestone was reached (undefined: not reached). */
export async function clicksTo(page: Page, milestone: string) {
  return (await report(page)).marks.find((m) => m.name === milestone)?.clicks;
}

let step = 0;
/** A numbered screenshot of this step, for the visual review at each release. */
export async function shot(page: Page, info: TestInfo, journey: string, name: string) {
  mkdirSync(OUT, { recursive: true });
  step++;
  await page.screenshot({ path: join(OUT, `${journey}-${info.project.name}-${String(step).padStart(2, "0")}-${name}.png`) });
}

/** Prints and saves the counter's numbers at the end of a journey. */
export async function finish(page: Page, info: TestInfo, journey: string) {
  const r = await report(page);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${journey}-${info.project.name}.json`), JSON.stringify(r, null, 2));
  console.log(`[journey ${journey} · ${info.project.name}] ${r.clicks} clicks, ${(r.ms / 1000).toFixed(1)} s · ${r.marks.map((m) => `${m.name}: ${m.clicks} clicks @ ${(m.ms / 1000).toFixed(1)} s`).join(" · ")}`);
  step = 0;
  return r;
}

export async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

export const toast = (page: Page, text: string | RegExp) => page.locator(".tm-toast", { hasText: text });

/** 0.16 grading footer: one split button. Clicks its main part when it already does `mode`, else picks `mode` from its menu. */
export async function saveGradeAs(page: Page, mode: "next" | "draft" | "release") {
  const id = { next: "grade-save-next", draft: "grade-save-draft", release: "grade-save" }[mode];
  const main = page.getByTestId(id);
  if (await main.count()) return main.click();
  await page.getByTestId("grade-save-menu").click();
  const label = { next: /^Save & Next/, draft: /^Save Draft/, release: /^Save( & Release)?( \(default\))?$/ }[mode];
  await page.locator(".tm-menu-item").filter({ has: page.locator(".tm-menu-label", { hasText: label }) }).click();
}

/** 0.16 grade panel: Preview, Compare, Return for Changes and Shortcuts are in "More Actions". */
export async function gradeMoreAction(page: Page, label: string | RegExp) {
  await page.getByTestId("grade-more").click();
  await page.locator(".tm-menu-item", { hasText: label }).click();
}

/** 0.16 "one door per step": how many Submit and Save buttons are visible right now. */
export async function visibleDoors(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const buttons = [...document.querySelectorAll("button")].filter(visible).map((b) => (b.textContent ?? "").trim());
    return {
      submit: buttons.filter((t) => /^(Submit|Submit Again|Submit…|Save and Submit)$/.test(t)).length,
      save: buttons.filter((t) => /^(Save|Save to Task Mentor)$/.test(t)).length,
    };
  });
}

/** 0.16 review focus: the student list folds behind the switcher while a submission is open. Shows it. */
export async function showRoster(page: Page) {
  const list = page.locator(".tm-grade-list");
  if (await list.isVisible()) return;
  const toggle = page.getByTestId("grade-switcher-toggle");
  if (await toggle.isVisible()) await toggle.click();
  await expect(list).toBeVisible();
}

/** Opens one student in the grading tab (0.16 opens the oldest waiting one by itself; this picks another). */
export async function openStudent(page: Page, name: string) {
  const panel = page.getByTestId("grade-panel");
  await expect(page.getByTestId("grade-row").first()).toBeAttached({ timeout: 15_000 });
  if ((await panel.count()) && ((await panel.locator("h2").first().textContent()) ?? "").includes(name)) return;
  await showRoster(page);
  const row = page.getByTestId("grade-row").filter({ hasText: name });
  if (!(await row.count())) await page.getByTestId("grade-filter-all").click();
  await row.first().click();
  await expect(panel).toContainText(name);
}
