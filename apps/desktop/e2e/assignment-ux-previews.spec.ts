import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";

/**
 * 1.1: where a project is saved (asked at Start), a folder made outside
 * TMCode connected to an assignment, "not submitted" unmistakable (row chip,
 * banner, status bar), and previews: Markdown Edit / Preview with task boxes,
 * CSV tables, PDF pages and Word documents.
 */

type Mock = { state(): { projects: { id: number; assignment_id?: number | null }[] } };
const mock = <T>(page: Page, fn: (m: Mock) => T | Promise<T>) => page.evaluate(`(${fn.toString()})(window.__TMCODE_PROJECTS__)`) as Promise<T>;

async function fresh(page: Page, storage: Record<string, string> = {}) {
  await page.goto("/");
  await page.evaluate((s) => {
    localStorage.clear();
    localStorage.setItem("tmcode:mock-account", "signed-in");
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  }, storage);
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(name);
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText(name);
  await page.keyboard.press("Enter");
}

const row = (page: Page, id: number) => page.locator(`[data-testid="assignment-row"][data-assignment-id="${id}"]`);

async function showAssignments(page: Page) {
  await command(page, "View: Show Assignments");
  await expect(row(page, 51)).toContainText("Build a to-do list");
}

test("Start asks where to save the project, and a folder anywhere on the computer is used", async ({ page }) => {
  await fresh(page, { "tmcode:mock-pick-base": "Users/student/Documents/School" });
  await showAssignments(page);
  await row(page, 51).getByRole("button", { name: "Start" }).click();
  const pick = page.locator(".tm-quick-input");
  await expect(pick).toContainText("Where should");
  await expect(page.locator(".tm-qi-item", { hasText: "Projects Folder" })).toBeVisible();
  await expect(page.locator(".tm-qi-item", { hasText: "Use the Open Folder" })).toBeVisible();
  await page.locator(".tm-qi-item", { hasText: "Choose a Folder…" }).click();
  await expect(page.getByTestId("assignment-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
  const folders = await page.evaluate(() => JSON.parse(localStorage.getItem("tmcode:projects.folders") ?? "{}") as Record<string, string>);
  expect(Object.values(folders).some((p) => p.startsWith("memory://Users/student/Documents/School/"))).toBe(true);
  // The next project offers the same place first.
  expect(await page.evaluate(() => localStorage.getItem("tmcode:projects.lastBase"))).toBe('"Users/student/Documents/School"');
});

test("a folder made outside TMCode connects to an assignment that isn't started (it starts with those files)", async ({ page }) => {
  await fresh(page);
  await showAssignments(page);
  const hint = page.getByTestId("assignments-loose-folder");
  await expect(hint).toContainText("isn't connected to an assignment");
  await hint.getByTestId("assignments-connect-folder").click();
  await page.locator(".tm-qi-item", { hasText: "Build a to-do list" }).click();
  await expect(page.getByTestId("assignment-page")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => mock(page, (m) => m.state().projects.some((p) => p.assignment_id === 51)), { timeout: 15_000 }).toBe(true);
  // The student's own files stay, and the folder is now the assignment's work.
  await page.locator('.tm-activity[data-view="explorer"]').click();
  await expect(page.locator('.tm-explorer [data-path="main.py"]')).toBeVisible();
  await expect(page.getByTestId("assignment-banner")).toHaveAttribute("data-status", "in_progress", { timeout: 15_000 });
  await expect(hint).toHaveCount(0);
});

test("connecting a folder to an assignment that already has a project asks to replace it", async ({ page }) => {
  await fresh(page);
  await showAssignments(page);
  await row(page, 51).getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
  await command(page, "Projects: Disconnect This Folder from Task Mentor");
  await page.locator(".tm-dialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("assignment-banner")).toHaveCount(0);
  await command(page, "Projects: Connect This Folder to an Assignment");
  await page.locator(".tm-qi-item", { hasText: "Build a to-do list" }).click();
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toContainText("already has your project");
  await expect(dialog.getByRole("button", { name: "Continue" })).toBeVisible();
  await dialog.getByRole("button", { name: "Replace with This Folder" }).click();
  await expect(page.getByTestId("assignment-banner")).toBeVisible({ timeout: 15_000 });
  expect(await mock(page, (m) => m.state().projects.filter((p) => p.assignment_id === 51).length)).toBe(1);
});

test("not submitted is unmistakable: the row, a banner over the code and the status bar, until it is", async ({ page }) => {
  await fresh(page);
  await showAssignments(page);
  await row(page, 51).getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
  const banner = page.getByTestId("assignment-banner");
  await expect(banner).toHaveAttribute("data-status", "in_progress");
  await expect(banner).toContainText("Not submitted yet");
  await expect(page.locator(".tm-statusbar")).toContainText("not submitted");
  await showAssignments(page);
  await expect(row(page, 51).getByTestId("assignment-not-submitted-chip")).toBeVisible();

  // Submit stays on the brief (one door per step): the banner leads there.
  await banner.getByTestId("banner-go-submit").click();
  await expect(page.getByTestId("assignment-submit")).toBeFocused();
  await page.getByTestId("assignment-submit").click();
  await page.locator(".tm-dialog").getByRole("button", { name: /Submit/ }).first().click();
  await expect(banner).toHaveAttribute("data-status", "submitted", { timeout: 15_000 });
  await expect(banner).toContainText("Submitted");
  await expect(row(page, 51).getByTestId("assignment-not-submitted-chip")).toHaveCount(0);
  await expect(page.locator(".tm-statusbar")).toContainText("Submitted");
});

// ───────────── previews ─────────────

const NOTES = ["# Lab notes", "", "## Tasks", "", "- [ ] Write the tests", "- [x] Draw the diagram", "", "```md", "- [ ] not a task", "```", ""].join("\n");
const CSV = 'name,score,comment\nAda,18,"Clear, careful"\nBob,15,"Said ""done"""\nCleo,19,\n';

function minimalPdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 24 Tf 40 100 Td (Hello PDF) Tj ET";
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

async function minimalDocx(): Promise<string> {
  const JSZip = createRequire(import.meta.url)("jszip") as new () => { file(p: string, c: string): void; generateAsync(o: { type: "binarystring" }): Promise<string> };
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Lab report</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Aim:</w:t></w:r><w:r><w:t xml:space="preserve"> sort a list.</w:t></w:r></w:p></w:body></w:document>',
  );
  return zip.generateAsync({ type: "binarystring" });
}

async function withFiles(page: Page, files: Record<string, string>) {
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

test("Markdown opens in Edit; Preview renders it like GitHub, and ticking a task box edits the file", async ({ page }) => {
  await withFiles(page, { "notes.md": NOTES });
  await file(page, "notes.md").dblclick();
  const bar = page.getByTestId("viewmode-bar");
  await expect(bar).toHaveAttribute("data-mode", "edit");
  await expect(page.locator(".tm-editor-area .view-lines").first()).toContainText("# Lab notes");
  await page.getByTestId("viewmode-preview").click();
  const preview = page.getByTestId("markdown-preview");
  await expect(preview.locator("h1")).toHaveText(/Lab notes/);
  await expect(preview.locator("h2 .tm-md-anchor")).toHaveAttribute("href", "#tasks");
  const boxes = preview.locator(".tm-task-item input[type=checkbox]");
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(1)).toBeChecked();
  await boxes.nth(0).click();
  await expect(boxes.nth(0)).toBeChecked();
  // The source changed (unsaved, undoable), and the code block stays as written.
  await page.getByTestId("viewmode-edit").click();
  await expect(page.locator(".tm-editor-area .view-lines").first()).toContainText("- [x] Write the tests");
  await expect(page.locator(".tm-editor-area .view-lines").first()).toContainText("- [ ] not a task");
  await expect(page.locator(".tm-tab.is-active")).toHaveClass(/is-dirty/);
});

test("a CSV file previews as a table that can be filtered", async ({ page }) => {
  await withFiles(page, { "marks.csv": CSV });
  await file(page, "marks.csv").dblclick();
  await page.getByTestId("viewmode-preview").click();
  const table = page.getByTestId("csv-preview");
  await expect(table.locator("thead th")).toHaveText(["#", "name", "score", "comment"]);
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").nth(1)).toContainText('Said "done"');
  await table.getByLabel("Filter rows").fill("careful");
  await expect(table.locator("tbody tr")).toHaveCount(1);
});

test("PDF files open as pages, and Word documents as a page of text", async ({ page }) => {
  await withFiles(page, { "brief.pdf": minimalPdf(), "report.docx": await minimalDocx() });
  await file(page, "brief.pdf").dblclick();
  const viewer = page.getByTestId("document-viewer");
  await expect(viewer).toHaveAttribute("data-kind", "pdf");
  await expect(viewer.getByTestId("pdf-pages")).toHaveText("Page 1 of 1", { timeout: 20_000 });
  await expect(viewer.locator('canvas[data-rendered="true"]')).toHaveCount(1, { timeout: 20_000 });

  await file(page, "report.docx").dblclick();
  await expect(viewer).toHaveAttribute("data-kind", "docx");
  const docx = viewer.getByTestId("docx-page");
  await expect(docx.locator("h1")).toHaveText("Lab report", { timeout: 20_000 });
  await expect(docx.locator("strong")).toHaveText("Aim:");
});
