import type { IconDefinition, IconThemeDocument } from "./iconThemes";

/**
 * TMCode's coloured folders: VS Code's Seti file icons, plus a folder icon on
 * every folder, coloured by what the folder usually holds (src, tests, docs,
 * build output…), as popular VS Code icon themes do. The SVGs are drawn here
 * (no third-party assets) and inlined as data: URLs.
 */

const DEFAULT_COLOR = "#90A4AE";

/** Folder names (lower case) by colour. */
const GROUPS: [color: string, names: string[]][] = [
  ["#4CAF50", ["src", "source", "sources", "app", "apps", "main"]],
  ["#8BC34A", ["lib", "libs", "vendor", "packages", "node_modules", "bower_components", ".venv", "venv", "env", "site-packages"]],
  ["#FFB300", ["components", "component", "views", "view", "pages", "screens", "layouts", "widgets", "parts", "templates"]],
  ["#00BFA5", ["test", "tests", "__tests__", "spec", "specs", "e2e", "cypress", "testing", "__mocks__", "fixtures"]],
  ["#42A5F5", ["docs", "doc", "documentation", "guides", "wiki", "notes", "reports"]],
  ["#29B6F6", ["public", "static", "www", "wwwroot", "htdocs"]],
  ["#26A69A", ["assets", "images", "img", "icons", "media", "fonts", "audio", "video", "resources", "res"]],
  ["#EF5350", ["dist", "build", "out", "output", "target", "bin", "obj", "release", "releases", "coverage", ".next", ".nuxt"]],
  ["#F4511E", [".git", ".gitlab", ".husky"]],
  ["#78909C", [".github", ".circleci", ".devcontainer", "__pycache__", ".cache", "tmp", "temp", "logs", "log"]],
  ["#1E88E5", [".vscode", ".idea", ".tmcode", ".nga", ".claude", ".kilo", ".refact"]],
  ["#7E57C2", ["config", "configs", "configuration", "settings", ".config", "env-config", "deploy", "infra", "docker", "k8s"]],
  ["#FF7043", ["api", "apis", "routes", "router", "controllers", "server", "backend", "services", "service", "middleware", "handlers"]],
  ["#EC407A", ["models", "model", "types", "typings", "schemas", "schema", "entities", "database", "db", "migrations", "seeders", "sql", "data"]],
  ["#AB47BC", ["styles", "style", "css", "scss", "sass", "less", "theme", "themes"]],
  ["#26C6DA", ["client", "frontend", "web", "ui", "mobile", "android", "ios"]],
  ["#CDDC39", ["scripts", "script", "tools", "utils", "util", "helpers", "hooks", "commands", "cli", "tasks"]],
  ["#FFA726", ["store", "stores", "state", "redux", "context", "providers", "i18n", "locales", "lang", "translations"]],
];

const svg = (body: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`)}`;

function closed(color: string) {
  return svg(`<path fill="${color}" d="M6.3 2.5H2.6C1.7 2.5 1 3.2 1 4.1v7.8c0 .9.7 1.6 1.6 1.6h10.8c.9 0 1.6-.7 1.6-1.6V5.7c0-.9-.7-1.6-1.6-1.6H8z"/>`);
}

function open(color: string) {
  return svg(
    `<path fill="${color}" opacity=".7" d="M1 4.1c0-.9.7-1.6 1.6-1.6h3.7L8 4.1h5.4c.9 0 1.6.7 1.6 1.6v.6H4.4c-.7 0-1.3.4-1.5 1.1L1 12.5z"/>` +
      `<path fill="${color}" d="M2.9 7.6c.2-.6.8-1 1.5-1h10.9c.5 0 .9.5.7 1l-1.6 5c-.2.6-.8 1-1.5 1H1.7c-.5 0-.8-.5-.7-.9z"/>`,
  );
}

/** Seti's document with coloured folder icons added (Seti itself has none). */
export function withColouredFolders(seti: IconThemeDocument): IconThemeDocument {
  const defs: Record<string, IconDefinition> = { ...seti.iconDefinitions };
  const folderNames: Record<string, string> = {};
  const folderNamesExpanded: Record<string, string> = {};
  const add = (id: string, color: string) => {
    defs[`_tm_folder_${id}`] = { iconPath: closed(color) };
    defs[`_tm_folder_${id}_open`] = { iconPath: open(color) };
  };
  add("default", DEFAULT_COLOR);
  GROUPS.forEach(([color, names], i) => {
    add(String(i), color);
    for (const n of names) {
      folderNames[n] = `_tm_folder_${i}`;
      folderNamesExpanded[n] = `_tm_folder_${i}_open`;
    }
  });
  return {
    ...seti,
    iconDefinitions: defs,
    folder: "_tm_folder_default",
    folderExpanded: "_tm_folder_default_open",
    rootFolder: "_tm_folder_default",
    rootFolderExpanded: "_tm_folder_default_open",
    folderNames,
    folderNamesExpanded,
  };
}
