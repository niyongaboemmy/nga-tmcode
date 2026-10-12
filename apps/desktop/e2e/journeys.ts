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
