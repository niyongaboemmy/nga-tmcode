import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * A .sql file's Preview draws its schema: tables as cards, foreign keys as lines with crow's-foot ends, a details panel,
 * search, dragging (remembered per file) and export as PNG / PDF, under the desktop app's Content Security Policy.
 */

const SCHEMA = `-- MySQL dump 10.13
CREATE TABLE \`AcademicYear\` (
  \`academic_year_id\` bigint NOT NULL AUTO_INCREMENT,
  \`name\` varchar(50) NOT NULL COMMENT 'e.g. 2025-2026',
  PRIMARY KEY (\`academic_year_id\`),
  UNIQUE KEY \`uq_name\` (\`name\`)
) ENGINE=InnoDB COMMENT='School years';

CREATE TABLE \`ClassGroup\` (
  \`class_group_id\` bigint NOT NULL AUTO_INCREMENT,
  \`name\` varchar(80) NOT NULL,
  PRIMARY KEY (\`class_group_id\`)
) ENGINE=InnoDB;

CREATE TABLE \`AcademicCalendar\` (
  \`calendar_id\` bigint NOT NULL AUTO_INCREMENT,
  \`academic_year_id\` bigint NOT NULL,
  \`class_group_id\` bigint DEFAULT NULL,
  \`created_at\` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`calendar_id\`),
  KEY \`idx_year\` (\`academic_year_id\`),
  CONSTRAINT \`cal_year\` FOREIGN KEY (\`academic_year_id\`) REFERENCES \`AcademicYear\` (\`academic_year_id\`) ON DELETE CASCADE,
  CONSTRAINT \`cal_class\` FOREIGN KEY (\`class_group_id\`) REFERENCES \`ClassGroup\` (\`class_group_id\`) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO \`AcademicYear\` VALUES (1,'2025-2026'),(2,'It\\'s; not a table');

CREATE VIEW \`v_calendars\` AS SELECT c.calendar_id AS calendar_id, y.name AS year_name FROM AcademicCalendar c JOIN AcademicYear y ON y.academic_year_id = c.academic_year_id;
`;

const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const appCsp = conf.app.security.csp as Record<string, string>;
// The dev server adds an inline React refresh preamble and a HMR socket.
const devExtra: Record<string, string> = { "script-src": "'unsafe-inline'", "connect-src": "ws: http://localhost:*" };
const csp = Object.entries(appCsp)
  .map(([k, v]) => `${k} ${v}${devExtra[k] ? ` ${devExtra[k]}` : ""}`)
  .join("; ");

async function withFiles(page: Page, files: Record<string, string>, opts: { csp?: boolean } = {}) {
  if (opts.csp)
    await page.route(/^http:\/\/localhost:\d+\/(\?.*)?$/, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": csp } });
    });
  await page.addInitScript((f) => {
    if (sessionStorage.getItem("tmcode:e2e-seeded")) return;
    sessionStorage.setItem("tmcode:e2e-seeded", "1");
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
    localStorage.setItem("tmcode:mock-folder:memory://practice-project", JSON.stringify(f));
  }, files);
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

const file = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);

async function openDiagram(page: Page, path: string) {
  await file(page, path).dblclick();
  await page.getByTestId("viewmode-preview").click();
  const d = page.getByTestId("sql-diagram");
  await expect(d).toHaveAttribute("data-state", /ready|empty/, { timeout: 15_000 });
  return d;
}

test("a .sql file previews as a schema diagram: tables, relationship lines, details and search", async ({ page }) => {
  await withFiles(page, { "schema.sql": SCHEMA });
  const d = await openDiagram(page, "schema.sql");
  await expect(d).toHaveAttribute("data-state", "ready");
  await expect(d.getByTestId("sql-diagram-stats")).toHaveText("3 tables · 1 view · 2 relationships");
  await expect(d.locator("svg [data-table]")).toHaveCount(4);
  await expect(d.locator("svg .sd-edges [data-rel]")).toHaveCount(2);
  // The INSERT's text never becomes a table.
  await expect(d.locator('svg [data-table="academicyear"] .sd-title')).toHaveText("AcademicYear");
  await expect(d.locator('svg [data-table="academiccalendar"] .sd-name')).toHaveText(["calendar_id", "academic_year_id", "class_group_id", "created_at"]);
  // The mandatory foreign key is solid with two bars at the parent; the nullable one is dashed with a ring.
  await expect(d.locator('[data-rel="academiccalendar#0"]')).not.toHaveClass(/is-optional/);
  await expect(d.locator('[data-rel="academiccalendar#1"]')).toHaveClass(/is-optional/);
  await expect(d.locator('[data-rel="academiccalendar#1"] .sd-ring')).toHaveCount(2);

  // Selecting a table opens its details and lights up its neighbours.
  await d.locator('svg [data-table="academicyear"] .sd-head').click();
  const details = d.getByTestId("sql-diagram-details");
  await expect(details).toHaveAttribute("data-table", "academicyear");
  await expect(details.locator("h3")).toHaveText("AcademicYear");
  await expect(details).toContainText("School years");
  await expect(details).toContainText("Referenced by (1)");
  await expect(details).toContainText("ON DELETE CASCADE");
  await expect(d.locator('svg [data-table="academicyear"]')).toHaveClass(/is-selected/);
  await expect(d.locator('svg [data-table="academiccalendar"]')).toHaveClass(/is-hl/);
  await expect(d.locator('svg [data-table="classgroup"]')).toHaveClass(/sd-dim/);
  await expect(d.locator('.sd-edges-hot [data-rel="academiccalendar#0"]')).toHaveClass(/is-hl/);
  // Its links move to the other table.
  await details.getByRole("button", { name: "AcademicCalendar" }).first().click();
  await expect(details).toHaveAttribute("data-table", "academiccalendar");
  await expect(details).toContainText("References (2)");
  await expect(details).toContainText("ON DELETE SET NULL");

  // Search marks matching tables and columns.
  await page.mouse.move(5, 5);
  const find = d.getByLabel("Find a table or column");
  await find.fill("class_group");
  await expect(d.locator(".tm-sqld-matches")).toHaveText("2 found");
  await expect(d.locator('svg [data-table="academicyear"]')).toHaveClass(/sd-dim/);
  await expect(d.locator('svg [data-table="classgroup"]')).toHaveClass(/is-match/);
  // Enter goes to each match in turn.
  await find.press("Enter");
  await expect(d.locator(".tm-sqld-matches")).toHaveText("1 of 2");
  await expect(details).toHaveAttribute("data-table", "classgroup");
  await find.press("Enter");
  await expect(details).toHaveAttribute("data-table", "academiccalendar");
  await find.press("Escape");

  // Keys only hides the other columns.
  await d.getByTestId("sql-diagram-keys").click();
  await expect(d.locator('svg [data-table="academiccalendar"] .sd-name')).toHaveText(["calendar_id", "academic_year_id", "class_group_id"]);
  await expect(d.locator('svg [data-table="academiccalendar"] .sd-more')).toHaveText("1 more column");
});

test("tables can be dragged, the layout is remembered for the file, and Reset Layout restores it", async ({ page }) => {
  await withFiles(page, { "schema.sql": SCHEMA });
  const d = await openDiagram(page, "schema.sql");
  const card = d.locator('svg [data-table="classgroup"]');
  const before = await card.getAttribute("transform");
  const box = (await card.locator(".sd-head").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 6 });
  await page.mouse.up();
  const after = await card.getAttribute("transform");
  expect(after).not.toBe(before);
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("tmcode:sql-diagram:schema.sql") ?? "{}").pos ?? {}))).toEqual(["classgroup"]);
  // Back to Edit and to Preview again: the moved table stays where it was put.
  await page.getByTestId("viewmode-edit").click();
  await page.getByTestId("viewmode-preview").click();
  await expect(card).toHaveAttribute("transform", after!);
  await d.getByTestId("sql-diagram-reset").click();
  await expect(card).toHaveAttribute("transform", before!);
  expect(await page.evaluate(() => localStorage.getItem("tmcode:sql-diagram:schema.sql"))).toBeNull();
});

test("the whole diagram exports as PNG and PDF under the app's CSP", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => /Content Security Policy/.test(m.text()) && violations.push(m.text()));
  await withFiles(page, { "db/schema.sql": SCHEMA }, { csp: true });
  await page.locator('.tm-explorer [data-path="db"]').click();
  const d = await openDiagram(page, "db/schema.sql");
  // Zoomed far in: the export is still the whole diagram.
  for (let i = 0; i < 4; i++) await d.getByRole("button", { name: "Zoom In (+)" }).click();

  const [png] = await Promise.all([page.waitForEvent("download"), d.getByTestId("sql-diagram-export-png").click()]);
  expect(png.suggestedFilename()).toBe("schema-diagram.png");
  const bytes = readFileSync((await png.path())!);
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  // Four cards side by side at 2×: far wider than the visible part at this zoom.
  expect(width).toBeGreaterThan(1200);
  expect(height).toBeGreaterThan(200);

  const [pdf] = await Promise.all([page.waitForEvent("download"), d.getByTestId("sql-diagram-export-pdf").click()]);
  expect(pdf.suggestedFilename()).toBe("schema-diagram.pdf");
  const doc = readFileSync((await pdf.path())!).toString("latin1");
  expect(doc.startsWith("%PDF-1.4")).toBe(true);
  expect(doc).toContain("/Filter /DCTDecode");
  expect(doc.trimEnd().endsWith("%%EOF")).toBe(true);
  expect(violations).toEqual([]);
});

test("a .sql file without tables says so, and lists what it skipped", async ({ page }) => {
  await withFiles(page, { "queries.sql": "SELECT * FROM users;\nUPDATE users SET name = 'x' WHERE id = 1;\n", "broken.sql": "CREATE TABLE ;\n" });
  const d = await openDiagram(page, "queries.sql");
  await expect(d).toHaveAttribute("data-state", "empty");
  await expect(d).toContainText("No tables to draw");
  await expect(d).toContainText("2 other statements");
  const b = await openDiagram(page, "broken.sql");
  await expect(b.getByTestId("sql-diagram-issues")).toContainText("Line 1");
  await expect(b.getByTestId("sql-diagram-issues")).toContainText("no table name");
});
