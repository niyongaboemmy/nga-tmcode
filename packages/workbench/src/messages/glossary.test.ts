import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, msg, releaseSkipReason, type MessageId } from "./catalog";

/**
 * The glossary (workflow plan §3.4): one word for each thing, everywhere the
 * user reads. Use the left column; the right column must never appear in the
 * catalogue or in the workbench's user-facing strings.
 */
const BANNED: [RegExp, string][] = [
  [/Open My Project/, "Continue"],
  [/Continue in TMCode/, "Continue"],
  [/\(Continue\)/, "a Continue button"],
  [/Save online\b/, "Save to Task Mentor"],
  [/Submit Project/, "Submit"],
  [/Withdraw Submission/, "Withdraw to Edit"],
  [/Locked until graded/, "Submitted · Withdraw to Edit"],
  [/Completed \(read-only\)/i, "Closed"],
  [/Task Mentor Projects view/, "All My Projects (or a button)"],
  [/Sign in with NGA \(Central MIS/, "Sign in"],
  [/Sign in again/, "Sign in"],
  [/Projects ›/, "a button instead of a menu path"],
  [/Help › Welcome/, "Home"],
  [/["'`>]Working["'`<]/, "In progress"],
  [/answered \$\{?res\.status|answered \d{3}\./, "plain words, with the code behind Details"],
];

const sample = { what: '"To-do list"', title: "To-do list", name: "Ben", n: 2, done: 1, total: 2, list: "Ben: not handed in yet", score: 18, max: 20, why: "you're offline", doing: "save", method: "GET", path: "/x", status: 500, code: "X", files: 3 };
const texts = (Object.keys(CATALOG) as MessageId[]).map((id) => [id, msg(id, sample)] as const);

describe("message catalogue", () => {
  it("every message renders to words (no undefined, no empty text)", () => {
    for (const [id, text] of texts) {
      expect(text, id).toBeTruthy();
      expect(text, id).not.toMatch(/undefined|\[object Object\]|NaN/);
    }
  });

  it("keeps technical codes out of the main text (they go behind Details)", () => {
    for (const [id, text] of texts) {
      if (id === "api.details") continue;
      expect(text, id).not.toMatch(/\b[A-Z]{3,}_[A-Z_]+\b|\bHTTP_\d+|\b[45]\d\d\b/);
    }
  });

  it("names release skip reasons in words, never server codes", () => {
    expect(releaseSkipReason("GRADE_CHANGED")).toBe("changed by another teacher");
    expect(releaseSkipReason("SOME_NEW_CODE")).toBe("Task Mentor refused it");
    expect(releaseSkipReason("SOME_NEW_CODE")).not.toMatch(/some new code/i);
  });

  it("uses the glossary", () => {
    for (const [id, text] of texts) for (const [bad, use] of BANNED) expect(bad.test(text), `${id}: "${text}" — use ${use}`).toBe(false);
  });
});

/** Source files minus comments (block, line and JSX comments), so notes for developers may name old words. */
function stripComments(src: string) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function files(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!["vendor", "themes", "textmate"].includes(name)) files(p, out);
    } else if (/\.(tsx|ts)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name) && !p.includes(`${join("platform", "memory")}`)) out.push(p);
  }
  return out;
}

describe("glossary in the workbench", () => {
  const root = join(__dirname, "..");
  const scanned = [...files(join(root, "projects")), ...files(join(root, "grading")), ...files(join(root, "parts")), ...files(join(root, "state")), join(root, "Workbench.tsx")];

  it("scans the workbench", () => expect(scanned.length).toBeGreaterThan(30));

  it("never uses the words the glossary replaces", () => {
    const hits: string[] = [];
    for (const f of scanned) {
      const code = stripComments(readFileSync(f, "utf8"));
      for (const [bad, use] of BANNED) {
        const m = code.match(bad);
        if (m) hits.push(`${f.slice(root.length + 1)}: "${m[0]}" — use ${use}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
