/** Pure helpers over starter manifests (the files themselves live in starters/ and dist/starters.json). */
import { KINDS } from "./catalog";
import type { Purpose, StarterManifest } from "./schema";

const PURPOSE_ORDER: Purpose[] = ["hello", "io-exercise", "project", "api", "data", "algorithms", "web"];

/**
 * The starters for a language key or a kind id, in picker order
 * (hello → io-exercise → project → api → data → algorithms → web, then title).
 */
export function startersFor<T extends StarterManifest>(starters: T[], languageOrKind: string): T[] {
  const isKind = languageOrKind.includes("/");
  const lang = isKind ? (KINDS.find((k) => k.id === languageOrKind)?.language ?? null) : languageOrKind;
  return starters
    .filter((s) => (isKind ? s.kind === languageOrKind : s.language === lang))
    .sort((a, b) => PURPOSE_ORDER.indexOf(a.purpose) - PURPOSE_ORDER.indexOf(b.purpose) || a.title.localeCompare(b.title));
}
