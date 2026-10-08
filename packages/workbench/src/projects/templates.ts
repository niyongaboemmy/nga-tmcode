/**
 * New Project templates: small, runnable starting points for every kind of
 * project TMCode runs (projects/templates/*), grouped by category. Run
 * Project, F5, the Testing view and the API Tester work on them straight away.
 */
import type { Template, TemplateCategory } from "./templates/kit";
import { BACKEND } from "./templates/backend";
import { DATA, LEARNING } from "./templates/learning";
import { LANGUAGES, MOBILE } from "./templates/languages";
import { FRONTEND, WEB } from "./templates/web";

export type { Template, TemplateCategory } from "./templates/kit";

export const TEMPLATES: Template[] = [...WEB, ...FRONTEND, ...BACKEND, ...MOBILE, ...LANGUAGES, ...DATA, ...LEARNING];

export const CATEGORY_ORDER: TemplateCategory[] = ["Websites", "Frontend frameworks", "Backend & APIs", "Mobile & desktop", "Languages", "Data & SQL", "Learning"];

export function templateById(id: string) {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}
