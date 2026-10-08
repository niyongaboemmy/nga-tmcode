import { expect, test, type Page } from "@playwright/test";

/**
 * More technologies: New Project from Template (grouped catalog), the built-in
 * SQL runner, truth tables for .logic files, and the API Tester (against the
 * memory platform's to-do API on http://localhost:4000).
 */

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:mock-account", "signed-in");
  });
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

async function fromTemplate(page: Page, label: string, folder: string) {
  await command(page, "File: New Project from Template");
  await page.locator(".tm-quick-pick input").fill(label);
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: label }).first().click();
  await page.locator(".tm-quick-pick input").fill(folder);
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-toast", { hasText: `Created ${folder}` })).toBeVisible({ timeout: 15_000 });
}

test("the template catalog is grouped by category and covers many technologies", async ({ page }) => {
  await fresh(page);
  await command(page, "File: New Project from Template");
  const pick = page.locator(".tm-quick-pick");
  for (const group of ["Websites", "Frontend frameworks", "Backend & APIs", "Mobile & desktop", "Languages", "Data & SQL", "Learning"]) {
    await expect(pick).toContainText(group);
  }
  for (const label of ["Website with jQuery", "Angular", "Java API (Spring Boot)", "Flutter App"]) {
    await page.locator(".tm-quick-pick input").fill(label);
    await expect(pick.locator(".tm-qi-item", { hasText: label }).first()).toBeVisible();
  }
  await page.keyboard.press("Escape");
});

test("SQL: run a file in the built-in SQLite, see tables and the schema, explain, then an error at its line", async ({ page }) => {
  await fresh(page);
  await fromTemplate(page, "SQL (SQLite)", "school-db");
  await expect(page.locator(".tm-tab").filter({ hasText: "queries.sql" }).first()).toBeVisible();
  await command(page, "SQL: Run SQL File");
  const results = page.getByTestId("sql-results");
  await expect(results).toContainText("ran schema.sql, seed.sql first", { timeout: 20_000 });
  await expect(results.getByTestId("sql-statement")).toHaveCount(4);
  const first = results.getByTestId("sql-table").first();
  await expect(first.locator("thead")).toContainText("average");
  await expect(first.locator("tbody tr").first()).toContainText("Ada");
  await expect(results.getByTestId("sql-schema-table")).toHaveCount(3);
  await expect(results.getByTestId("sql-schema-table").filter({ hasText: "students" })).toContainText("4 rows");
  await results.getByTestId("sql-statement").first().getByRole("button", { name: "Explain" }).click();
  await expect(results.getByTestId("sql-plan")).toContainText(/SCAN|SEARCH/);

  // An error: shown on its statement and as a Problem at that line.
  await page.locator(".tm-tab").filter({ hasText: "queries.sql" }).filter({ hasNotText: "SQL:" }).click();
  await page.evaluate(() => (window as unknown as { __TMCODE_DEBUG__: { externalWrite(p: string, c: string): Promise<void> } }).__TMCODE_DEBUG__.externalWrite("queries.sql", "SELECT 1 AS one;\nSELECT nope FROM students;\n"));
  await command(page, "SQL: Run SQL File");
  await expect(results.locator(".tm-sql-stmt.is-error")).toContainText("no such column: nope");
  await expect(results.locator(".tm-sql-stmt.is-error .tm-sql-line")).toContainText("line 2");
});

test("SQL: Keep data mode keeps tables between runs; Fresh starts over", async ({ page }) => {
  await fresh(page);
  await fromTemplate(page, "SQL (SQLite)", "keep-db");
  await command(page, "SQL: Run SQL File");
  const results = page.getByTestId("sql-results");
  await expect(results.getByTestId("sql-statement")).toHaveCount(4, { timeout: 20_000 });
  await results.getByRole("radio", { name: "Keep data" }).click();
  await command(page, "View: Show Explorer");
  await page.locator(".tm-explorer [data-path='schema.sql']").dblclick();
  await command(page, "SQL: Run SQL File");
  const schema = page.getByTestId("sql-results").filter({ has: page.locator(".tm-sql-head", { hasText: "schema.sql" }) });
  await expect(schema.getByTestId("sql-schema-table")).toHaveCount(3);
  // Again, from the results tab: the tables are still there.
  await command(page, "SQL: Run SQL File");
  await expect(schema.locator(".tm-sql-stmt.is-error")).toContainText("already exists");
  // Fresh mode starts from an empty database again.
  await schema.getByRole("radio", { name: "Fresh each run" }).click();
  await command(page, "SQL: Run SQL File");
  await expect(schema.locator(".tm-sql-stmt.is-error")).toHaveCount(0);
});

test("Logic: truth tables, steps, tautology and equivalent expressions", async ({ page }) => {
  await fresh(page);
  await fromTemplate(page, "Logic & Truth Tables", "logic-lab");
  await expect(page.locator(".tm-tab", { hasText: "laws.logic" })).toBeVisible();
  await command(page, "Logic: Show Truth Tables");
  const logic = page.getByTestId("logic-page");
  await expect(logic.getByTestId("logic-equivalent")).toContainText("F ≡ G");
  await expect(logic.getByTestId("logic-equivalent")).toContainText("D1 ≡ D2");
  const exprs = logic.getByTestId("logic-expression");
  await expect(exprs.filter({ hasText: "I = " })).toContainText("Tautology");
  await expect(exprs.filter({ hasText: "X = " })).toContainText("Contradiction");
  await expect(exprs.filter({ hasText: "F = " }).getByTestId("logic-table").locator("tbody tr")).toHaveCount(4);
  await logic.getByRole("button", { name: "1 / 0" }).click();
  await expect(exprs.filter({ hasText: "F = " }).getByTestId("logic-table").locator("tbody tr").first()).toContainText("0");
});

test("API Tester: routes from the code, send requests, see status, JSON and validation errors", async ({ page }) => {
  await fresh(page);
  await fromTemplate(page, "Node.js API (Express)", "todo-api");
  await command(page, "Run: Open API Tester");
  const api = page.getByTestId("api-tester");
  await expect(api.getByTestId("api-route").filter({ hasText: "/api/todos/:id" }).first()).toBeVisible({ timeout: 10_000 });
  await expect(api.getByTestId("api-route")).toHaveCount(4);

  await api.getByTestId("api-url").fill("http://localhost:4000/api/todos");
  await api.getByTestId("api-send").click();
  await expect(api.getByTestId("api-status")).toContainText("200 OK");
  await expect(api.getByTestId("api-response")).toContainText("Learn SQL");

  await api.getByTestId("api-method").selectOption("POST");
  await api.getByTestId("api-body").fill("{ title: oops }");
  await api.getByTestId("api-send").click();
  await expect(api.getByTestId("api-response")).toContainText("The body isn't valid JSON");
  await api.getByTestId("api-body").fill('{ "title": "Write tests" }');
  await api.getByTestId("api-send").click();
  await expect(api.getByTestId("api-status")).toContainText("201 Created");
  await expect(api.getByTestId("api-response")).toContainText("Write tests");
  await api.getByRole("tab", { name: /History/ }).click();
  await expect(api.locator(".tm-api-route")).toHaveCount(2);
});
