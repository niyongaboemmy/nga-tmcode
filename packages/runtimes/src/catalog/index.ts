/** The Runtime Catalog's data (§11): languages, runtimes and kinds. */
import type { Catalog, KindDef } from "../schema";
import { DATA_KINDS } from "./kinds/data";
import { JVM_KINDS } from "./kinds/jvm";
import { LONGTAIL_KINDS } from "./kinds/longtail";
import { OTHER_KINDS } from "./kinds/other";
import { SCRIPTING_KINDS } from "./kinds/scripting";
import { SYSTEMS_KINDS } from "./kinds/systems";
import { WEB_KINDS } from "./kinds/web";
import { LANGUAGES } from "./languages";
import { RUNTIMES } from "./runtimes";

/** Bumped when the catalog changes: `<year>.<month>.<n>`. */
export const CATALOG_VERSION = "2026.10.2";

export const KINDS: KindDef[] = [...SYSTEMS_KINDS, ...JVM_KINDS, ...SCRIPTING_KINDS, ...WEB_KINDS, ...DATA_KINDS, ...OTHER_KINDS, ...LONGTAIL_KINDS];

export { LANGUAGES, RUNTIMES };

export const CATALOG: Catalog = { version: CATALOG_VERSION, languages: LANGUAGES, runtimes: RUNTIMES, kinds: KINDS };

export const kindById = (id: string) => KINDS.find((k) => k.id === id) ?? null;
export const languageByKey = (key: string) => LANGUAGES.find((l) => l.key === key) ?? null;
export const runtimeById = (id: string) => RUNTIMES.find((r) => r.id === id) ?? null;
export const kindsOf = (language: string) => KINDS.filter((k) => k.language === language);
