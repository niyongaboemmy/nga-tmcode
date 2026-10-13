/**
 * @nga/runtimes: the Runtime Catalog (languages, toolchains, project kinds),
 * kind and entry detection, test-report parsing and starter-project helpers.
 * Free of React and the DOM. The generated dist/catalog.json and
 * dist/starters.json are the artefacts other apps vendor.
 */
export * from "./schema";
export { CATALOG, CATALOG_VERSION, KINDS, LANGUAGES, RUNTIMES, kindById, kindsOf, languageByKey, runtimeById } from "./catalog";
export { detect, detectKind, entryFor, isEntrySource, isTestPath, javaMainClass, matchName, IGNORED_PATH, type DetectedKind, type DetectOptions, type FileReader } from "./detect";
export { startersFor } from "./starters";
export { validateCatalog, validateStarter, validateStarters, type StarterInput } from "./validate";
export * as testing from "./testing";
