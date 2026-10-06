import type { ExtensionHost } from "../platform/types";

/**
 * The Open VSX registry (open-vsx.org, the marketplace VS Code forks use).
 * Requests go through the platform (Rust on the desktop: no CORS, host
 * allow-list), and responses are normalised to `GalleryExtension`.
 */

export const OPEN_VSX = "https://open-vsx.org";

export interface GalleryExtension {
  /** "publisher.name", lower-cased. */
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  publisher: string;
  verified: boolean;
  downloadCount: number;
  averageRating?: number;
  reviewCount: number;
  iconUrl?: string;
  downloadUrl?: string;
  readmeUrl?: string;
  /** The extension's package.json on Open VSX (contributions before installing). */
  manifestUrl?: string;
  changelogUrl?: string;
  /** Details only. */
  categories?: string[];
  tags?: string[];
  license?: string;
  repository?: string;
  homepage?: string;
  timestamp?: string;
  deprecated?: boolean;
}

export interface SearchResult {
  total: number;
  offset: number;
  extensions: GalleryExtension[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const s = (v: unknown) => (typeof v === "string" ? v : "");
const opt = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** One extension from an Open VSX search hit or details response. */
export function normalizeGalleryExtension(raw: Record<string, unknown>): GalleryExtension {
  const namespace = s(raw.namespace);
  const name = s(raw.name);
  const files = (raw.files && typeof raw.files === "object" ? raw.files : {}) as Record<string, unknown>;
  const publishedBy = (raw.publishedBy && typeof raw.publishedBy === "object" ? raw.publishedBy : {}) as Record<string, unknown>;
  const downloads = (raw.downloads && typeof raw.downloads === "object" ? raw.downloads : {}) as Record<string, unknown>;
  return {
    id: `${namespace}.${name}`.toLowerCase(),
    namespace,
    name,
    displayName: s(raw.displayName) || name,
    description: s(raw.description),
    version: s(raw.version),
    publisher: s(raw.namespaceDisplayName) || s(publishedBy.fullName) || namespace,
    verified: raw.verified === true,
    downloadCount: num(raw.downloadCount),
    averageRating: typeof raw.averageRating === "number" ? raw.averageRating : undefined,
    reviewCount: num(raw.reviewCount),
    iconUrl: opt(files.icon),
    // Declarative extensions are "universal"; platform-specific builds only matter for code.
    downloadUrl: opt(files.download) ?? opt(downloads.universal),
    readmeUrl: opt(files.readme),
    manifestUrl: opt(files.manifest),
    changelogUrl: opt(files.changelog),
    categories: Array.isArray(raw.categories) ? raw.categories.filter((c): c is string => typeof c === "string") : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((c): c is string => typeof c === "string" && !c.startsWith("__")) : undefined,
    license: opt(raw.license),
    repository: opt(raw.repository),
    homepage: opt(raw.homepage),
    timestamp: opt(raw.timestamp),
    deprecated: raw.deprecated === true,
  };
}

export function searchUrl(query: string, offset = 0, size = 30): string {
  const q = new URLSearchParams({ query: query.trim(), offset: String(offset), size: String(size), sortBy: "relevance", sortOrder: "desc", includeAllVersions: "false" });
  // `@category:"themes"` style filters, as in VS Code's search box.
  const cat = /@category:"?([^"]+)"?/.exec(query);
  if (cat) {
    q.set("query", query.replace(cat[0], "").trim());
    q.set("category", cat[1]);
  }
  return `${OPEN_VSX}/api/-/search?${q}`;
}

export async function searchGallery(host: ExtensionHost, query: string, offset = 0, size = 30): Promise<SearchResult> {
  const raw = JSON.parse(await host.fetch(searchUrl(query, offset, size), "text")) as { totalSize?: number; offset?: number; extensions?: Record<string, unknown>[]; error?: string };
  if (raw.error) throw new Error(raw.error);
  return { total: num(raw.totalSize), offset: num(raw.offset), extensions: (raw.extensions ?? []).map(normalizeGalleryExtension) };
}

const details = new Map<string, Promise<GalleryExtension>>();
const names = new Map<string, string>();

/** Display name of an extension seen in the gallery this session (tab titles). */
export function cachedGalleryName(id: string): string | undefined {
  return names.get(id.toLowerCase());
}

/** Remembers a search hit, so its details editor opens instantly. */
export function rememberGallery(ext: GalleryExtension) {
  names.set(ext.id, ext.displayName);
  if (!details.has(ext.id)) details.set(ext.id, Promise.resolve(ext));
}

/** Details of "publisher.name" (cached for this session; `fresh` re-asks Open VSX). */
export function getGalleryExtension(host: ExtensionHost, id: string, fresh = false): Promise<GalleryExtension> {
  const key = id.toLowerCase();
  let p = fresh ? undefined : details.get(key);
  if (!p) {
    p = fetchGalleryExtension(host, key);
    p.then((g) => names.set(g.id, g.displayName)).catch(() => {});
    details.set(key, p);
    p.catch(() => details.delete(key));
  }
  return p;
}

export function clearGalleryCache() {
  details.clear();
}

async function fetchGalleryExtension(host: ExtensionHost, id: string): Promise<GalleryExtension> {
  const [ns, ...rest] = id.split(".");
  const name = rest.join(".");
  if (!ns || !name) throw new Error(`Invalid extension id ${id}`);
  const raw = JSON.parse(await host.fetch(`${OPEN_VSX}/api/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`, "text")) as Record<string, unknown>;
  if (typeof raw.error === "string") throw new Error(raw.error);
  return normalizeGalleryExtension(raw);
}

/** "1.2M", "45.3K", "812" — as VS Code shows install counts. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(n);
}

const iconCache = new Map<string, Promise<string | null>>();

/** Data URL of a gallery icon (images are fetched through the host; the CSP allows data: images only). */
export function galleryIcon(host: ExtensionHost, url: string): Promise<string | null> {
  let p = iconCache.get(url);
  if (!p) {
    const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
    p = host
      .fetch(url, "base64")
      .then((b64) => `data:${mime};base64,${b64}`)
      .catch(() => null);
    iconCache.set(url, p);
  }
  return p;
}

/**
 * Extensions suggested when the search box is empty (VS Code shows "Popular"
 * and workspace recommendations). Declarative ones that work fully in TMCode.
 */
export const RECOMMENDED = [
  // Verified in TMCode's extension host (docs/RECOMMENDED_EXTENSIONS.md).
  "esbenp.prettier-vscode",
  "dbaeumer.vscode-eslint",
  "usernamehw.errorlens",
  "streetsidesoftware.code-spell-checker",
  "christian-kohler.path-intellisense",
  "formulahendry.auto-rename-tag",
  "bradlc.vscode-tailwindcss",
  "dsznajder.es7-react-js-snippets",
  "ritwickdey.liveserver",
  "humao.rest-client",
  "formulahendry.code-runner",
  "eamodio.gitlens",
  "aaron-bond.better-comments",
  "wayou.vscode-todo-highlight",
  "oderwat.indent-rainbow",
  "naumovs.color-highlight",
  "lyuwenhan.code-formatter-and-minifier",
  // Themes and icons (declarative, fully supported).
  "github.github-vscode-theme",
  "dracula-theme.theme-dracula",
  "akamud.vscode-theme-onedark",
  "pkief.material-icon-theme",
  "vscode-icons-team.vscode-icons",
  "catppuccin.catppuccin-vsc-icons",
];
