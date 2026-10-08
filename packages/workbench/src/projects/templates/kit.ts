/** Shared bits of the New Project templates (projects/templates/*). */

export type TemplateCategory = "Websites" | "Frontend frameworks" | "Backend & APIs" | "Mobile & desktop" | "Languages" | "Data & SQL" | "Learning";

export interface Template {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** Task Mentor's project language. */
  language: string;
  category: TemplateCategory;
  /** Commands the template needs on this computer (shown, and checked before setup). */
  tools?: string[];
  /** The file to open first (default: the first source file). */
  main?: string;
  /** Run once in a terminal after the files are written (scaffolding, installs). */
  setup?: { command: string; note: string };
  files: Record<string, string>;
}

export const launch = (configs: object[]) => `${JSON.stringify({ version: "0.2.0", configurations: configs }, null, 2)}\n`;
export const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
export const gitignore = (extra: string[] = []) => ["node_modules/", "dist/", "build/", ".venv/", "__pycache__/", "target/", ".DS_Store", ...extra].join("\n") + "\n";

/** `.tmcode/tests.json`: input/expected-output tests the Testing view runs (beaker). */
export const ioTests = (entry: string, tests: [name: string, input: string, expected: string][]) =>
  json({ entry, tests: tests.map(([name, input, expected_output], i) => ({ id: `t${i + 1}`, name, input, expected_output })) });

export const readme = (title: string, lines: string[]) => `# ${title}\n\n${lines.join("\n")}\n`;
