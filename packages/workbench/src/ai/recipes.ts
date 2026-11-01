import type { ChatMode } from "./chat";

/**
 * Slash recipes (proposal L6): one word for a common job, each a known-good prompt with its checks.
 * In Industrial the agent does the work; in Learning the same recipe becomes a step-by-step guide
 * the student follows (the tutor never writes the code). `/review`, `/debug`, `/tour` and `/plan`
 * run TMCode AI's own actions.
 */

export interface Recipe {
  id: string;
  label: string;
  /** What the agent does (Industrial). */
  build: string;
  /** What the tutor guides (Learning). */
  guide: string;
}

const CHECK = "When you're done, check get_problems and run the tests or the build if the project has them, then summarise what changed.";

export const RECIPES: Recipe[] = [
  { id: "add-page", label: "Add a page", build: `Add a new page{arg} to this app, linked from the existing navigation, matching the project's style. ${CHECK}`, guide: "Guide me, step by step, to add a new page{arg} to this app: which file to create, how to link it, what to check. I write the code." },
  { id: "add-form", label: "Add a form", build: `Add a form{arg} with labelled inputs, validation and clear error messages, wired to the existing code. ${CHECK}`, guide: "Guide me to build a form{arg}: the inputs, validation and error messages to think about, one step at a time. I write the code." },
  { id: "add-auth", label: "Add sign-in", build: `Add sign-in{arg} with secure defaults: hashed passwords, sessions, CSRF protection, and every route requiring sign-in unless it is public on purpose. Never hard-code secrets (use .env). ${CHECK}`, guide: "Explain how sign-in should work in this app{arg} (passwords, sessions, protecting routes) and guide me through building it safely. I write the code." },
  { id: "add-db", label: "Add a database", build: `Add a local database{arg} (SQLite unless the project already uses another), with a schema file, a small data-access module and no credentials in the code. ${CHECK}`, guide: "Guide me to add a database{arg}: the tables I need, how the code should talk to it, what to keep out of the code. I write the code." },
  { id: "add-api", label: "Add an API route", build: `Add an API route{arg} with input validation, clear errors and a test. ${CHECK}`, guide: "Guide me to design and write an API route{arg}: inputs, validation, errors and a test. I write the code." },
  { id: "seed", label: "Seed data", build: `Write realistic sample data{arg} and a script to load it, kept apart from real data. ${CHECK}`, guide: "Help me plan realistic sample data{arg} and how to load it. I write it." },
  { id: "responsive", label: "Make it responsive", build: `Make the UI{arg} work well on phones (≤ 400 px), tablets and desktops, without horizontal scrolling. ${CHECK}`, guide: "Review how the UI{arg} behaves on a phone and guide me to make it responsive, one change at a time. I write the code." },
  { id: "a11y", label: "Accessibility", build: `Fix accessibility{arg}: labels, contrast, keyboard use, focus order, alt text. ${CHECK}`, guide: "Point out accessibility problems{arg} (labels, contrast, keyboard, alt text) and explain how I can fix each. I write the code." },
  { id: "dark-mode", label: "Dark mode", build: `Add a dark mode{arg} using CSS variables and prefers-color-scheme, with a toggle. ${CHECK}`, guide: "Explain how to add dark mode with CSS variables{arg} and guide me through it. I write the code." },
  { id: "polish", label: "Polish", build: `Polish the UI{arg}: spacing, alignment, consistent fonts and colours, empty and loading states. Keep the behaviour the same. ${CHECK}`, guide: "Review the UI{arg} and list what would make it look more polished, explaining why. I make the changes." },
  { id: "test", label: "Write tests", build: `Write tests{arg} for the important behaviour, including edge cases, using the project's test framework (or the standard one for the language). Run them. ${CHECK}`, guide: "Suggest test cases{arg} in words: inputs, expected outputs and edge cases. I write the tests." },
  { id: "readme", label: "Write a README", build: "Write README.md{arg}: what the project does, how to install and run it, how it is organised, and how it was built.", guide: "Help me plan a good README{arg}: the sections, what each should say. I write it." },
  { id: "explain-project", label: "Explain the project", build: "Explain this project{arg}: start with repo_map, then describe the main parts and how they connect, in plain words.", guide: "Explain this project{arg}: start with repo_map, then describe the main parts and how they connect, in plain words." },
];

/** `/review`, `/debug`, `/tour`, `/plan`: TMCode AI's own actions. */
export const ACTION_RECIPES = ["review", "debug", "tour", "plan"] as const;
export type ActionRecipe = (typeof ACTION_RECIPES)[number];

export type Expanded = { kind: "ask"; prompt: string; mode: ChatMode } | { kind: "action"; action: ActionRecipe; arg: string } | null;

/** "/add-form contact" → the recipe's prompt for this layer (null: not a recipe). */
export function expandRecipe(input: string, tutor: boolean, agentMode: ChatMode): Expanded {
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  if (!m) return null;
  const id = m[1].toLowerCase();
  const arg = (m[2] ?? "").trim();
  if ((ACTION_RECIPES as readonly string[]).includes(id)) return { kind: "action", action: id as ActionRecipe, arg };
  const r = RECIPES.find((x) => x.id === id);
  if (!r) return null;
  const text = (tutor ? r.guide : r.build).replace("{arg}", arg ? ` (${arg})` : "");
  return { kind: "ask", prompt: text, mode: tutor ? "chat" : agentMode === "chat" || agentMode === "plan" ? "manual" : agentMode };
}

/** The recipes whose id starts with what was typed after "/" (the input's suggestions). */
export function recipeSuggestions(typed: string): { id: string; label: string }[] {
  const q = typed.toLowerCase();
  return [...RECIPES.map((r) => ({ id: r.id, label: r.label })), { id: "review", label: "Review my code" }, { id: "debug", label: "Debug with me" }, { id: "tour", label: "Tour this project" }, { id: "plan", label: "Plan before building" }].filter((r) => r.id.startsWith(q));
}
