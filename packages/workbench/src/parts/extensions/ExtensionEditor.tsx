import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { executeCommand } from "../../commands/registry";
import { Codicon } from "../../widgets/icons";
import { cachedGalleryName, formatCount, getGalleryExtension, OPEN_VSX, type GalleryExtension } from "../../extensions/gallery";
import { contributionSummary, parseManifest, type ExtensionManifest } from "../../extensions/manifest";
import { extensionHost, installedExtension, installExtension, setExtensionEnabled, uninstallExtension, useExtensions } from "../../extensions/service";
import { resolveRelative } from "../../textmate/themeData";
import { ExtensionIcon, Rating, useExtensionsBlocked } from "./ExtensionsView";

/**
 * The extension details editor (VS Code's "Extension: <name>" tab): header
 * with icon, publisher, installs and rating, the Install / Uninstall /
 * Disable buttons, then the README and the contributions TMCode applies.
 */

export function extensionTitle(id: string): string {
  const name = installedExtension(id)?.manifest.displayName ?? cachedGalleryName(id);
  return `Extension: ${name ?? id}`;
}

const md = new Marked({ gfm: true, breaks: false });
const purifier = DOMPurify(window);
// Images are loaded by the editor itself (through the host: the CSP allows data: images only).
purifier.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src");
    node.removeAttribute("src");
    node.removeAttribute("srcset");
    if (src) node.setAttribute("data-tm-src", src);
  }
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    node.setAttribute("title", href);
    node.removeAttribute("target");
  }
});

export function renderReadme(markdown: string): string {
  const html = md.parse(markdown, { async: false }) as string;
  return purifier.sanitize(html, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "base"],
    FORBID_ATTR: ["style"],
  });
}

const mimeOf = (p: string) => {
  const e = p.split("?")[0].split(".").pop()?.toLowerCase();
  return e === "svg" ? "image/svg+xml" : e === "gif" ? "image/gif" : e === "jpg" || e === "jpeg" ? "image/jpeg" : e === "webp" ? "image/webp" : "image/png";
};

interface Details {
  gallery: GalleryExtension | null;
  galleryError: string | null;
  /** Manifest of the installed copy, else the one on Open VSX. */
  manifest: ExtensionManifest | null;
  readme: string | null;
  /** Where relative README images live: "local" (installed files) or an Open VSX folder URL. */
  readmeBase: "local" | string | null;
}

function useDetails(id: string): Details {
  const installedVersion = useExtensions((s) => s.installed.find((e) => e.id === id)?.version);
  const [d, setD] = useState<Details>({ gallery: null, galleryError: null, manifest: null, readme: null, readmeBase: null });
  useEffect(() => {
    const host = extensionHost();
    if (!host) return;
    let live = true;
    const update = (patch: Partial<Details>) => live && setD((prev) => ({ ...prev, ...patch }));
    const installed = installedExtension(id);
    update({ manifest: installed?.manifest ?? null });
    if (installed) {
      (async () => {
        for (const name of ["README.md", "readme.md", "Readme.md", "README.markdown"]) {
          const text = await host.readFile(id, name, "text").catch(() => null);
          if (text !== null) return update({ readme: text, readmeBase: "local" });
        }
        update({ readme: "" });
      })();
    }
    getGalleryExtension(host, id)
      .then(async (g) => {
        update({ gallery: g });
        if (!installed && g.manifestUrl) {
          host
            .fetch(g.manifestUrl, "text")
            .then((t) => update({ manifest: parseManifest(t) }))
            .catch(() => {});
        }
        if (!installed) {
          const text = g.readmeUrl ? await host.fetch(g.readmeUrl, "text").catch(() => null) : null;
          update({ readme: text ?? "", readmeBase: g.readmeUrl ? g.readmeUrl.slice(0, g.readmeUrl.lastIndexOf("/") + 1) : null });
        }
      })
      .catch((e) => {
        update({ galleryError: String((e as Error)?.message ?? e) });
        if (!installed) update({ readme: "" });
      });
    return () => {
      live = false;
    };
  }, [id, installedVersion]);
  return d;
}

/** Loads README images through the host; images from anywhere else are left out. */
function useReadmeImages(container: React.RefObject<HTMLDivElement | null>, id: string, base: Details["readmeBase"], html: string) {
  useEffect(() => {
    const host = extensionHost();
    const root = container.current;
    if (!host || !root) return;
    let live = true;
    for (const img of root.querySelectorAll<HTMLImageElement>("img[data-tm-src]")) {
      const src = img.getAttribute("data-tm-src")!;
      const absolute = /^[a-z][a-z0-9+.-]*:/i.test(src);
      let load: Promise<string> | null = null;
      if (absolute && src.startsWith(`${OPEN_VSX}/`)) load = host.fetch(src, "base64").then((b) => `data:${mimeOf(src)};base64,${b}`);
      else if (!absolute && base === "local") load = host.readFile(id, resolveRelative("README.md", src.split("#")[0]), "base64").then((b) => `data:${mimeOf(src)};base64,${b}`);
      else if (!absolute && base) load = host.fetch(base + src.replace(/^\.\//, ""), "base64").then((b) => `data:${mimeOf(src)};base64,${b}`);
      if (!load) {
        img.replaceWith(Object.assign(document.createElement("span"), { className: "tm-ext-readme-img-missing", textContent: img.alt || "" }));
        continue;
      }
      load.then((url) => live && (img.src = url)).catch(() => live && img.remove());
    }
    return () => {
      live = false;
    };
  }, [container, id, base, html]);
}

function Features({ manifest }: { manifest: ExtensionManifest }) {
  const rows: [string, string[]][] = [
    ["Color Themes", manifest.themes.map((t) => `${t.label} (${t.uiTheme === "vs" ? "light" : t.uiTheme.startsWith("hc") ? "high contrast" : "dark"})`)],
    ["File Icon Themes", manifest.iconThemes.map((t) => t.label)],
    ["Programming Languages", manifest.languages.map((l) => `${l.aliases?.[0] ?? l.id}${l.extensions?.length ? ` — ${l.extensions.join(", ")}` : ""}`)],
    ["Syntax Highlighting (TextMate)", manifest.grammars.map((g) => `${g.language ?? "injection"}: ${g.scopeName}`)],
    ["Snippets", manifest.snippets.map((s) => `${s.language}: ${s.path}`)],
  ];
  const used = rows.filter(([, list]) => list.length);
  return (
    <div className="tm-ext-features">
      {used.length === 0 && <p className="tm-muted">This extension contributes nothing TMCode can use.</p>}
      {used.map(([title, list]) => (
        <section key={title}>
          <h3>
            {title} <span className="tm-badge">{list.length}</span>
          </h3>
          <ul>
            {list.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </section>
      ))}
      {manifest.unsupported.length > 0 && (
        <section>
          <h3>Not supported in TMCode</h3>
          <p className="tm-muted">{manifest.unsupported.join(", ")}</p>
        </section>
      )}
    </div>
  );
}

export function ExtensionEditor({ extensionId }: { extensionId: string }) {
  const id = extensionId.toLowerCase();
  const installed = useExtensions((s) => s.installed.find((e) => e.id === id));
  const busy = useExtensions((s) => s.busy[id]);
  const blocked = useExtensionsBlocked();
  const d = useDetails(id);
  const [tab, setTab] = useState<"details" | "features">("details");
  const readmeRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (d.readme ? renderReadme(d.readme) : ""), [d.readme]);
  useReadmeImages(readmeRef, id, d.readmeBase, html);

  const g = d.gallery;
  const manifest = d.manifest;
  const name = installed?.manifest.displayName ?? g?.displayName ?? id;
  const description = installed?.manifest.description || g?.description || "";
  const publisher = g?.publisher ?? installed?.manifest.publisher ?? id.split(".")[0];
  const updateAvailable = !!(installed && g && g.version && g.version !== installed.version);
  const summary = manifest ? contributionSummary(manifest) : [];

  if (!extensionHost()) return <div className="tm-ext-editor"><p className="tm-ext-message">Extensions are available in the TMCode desktop app.</p></div>;

  return (
    <div className="tm-ext-editor tm-scroll" role="document" aria-label={`Extension: ${name}`}>
      <header className="tm-ext-header">
        <ExtensionIcon gallery={g} installed={installed} size={128} />
        <div className="tm-ext-header-main">
          <div className="tm-ext-title-row">
            <h1 className="tm-ext-title">{name}</h1>
            {g?.deprecated && <span className="tm-ext-tag is-warning">Deprecated</span>}
          </div>
          <div className="tm-ext-subtitle">
            <span className="tm-ext-publisher">
              {g?.verified && <Codicon name="verified-filled" className="tm-ext-verified" title="Verified publisher" />}
              {publisher}
            </span>
            {g && g.downloadCount > 0 && (
              <span className="tm-ext-stat" title={`${g.downloadCount.toLocaleString()} downloads`}>
                <Codicon name="cloud-download" /> {formatCount(g.downloadCount)}
              </span>
            )}
            {g && <Rating value={g.averageRating} count={g.reviewCount} />}
            <span className="tm-ext-id">{id}</span>
          </div>
          <p className="tm-ext-description">{description}</p>
          <div className="tm-ext-actions">
            {busy ? (
              <span className="tm-ext-busy" role="status">
                <Codicon name="loading" className="codicon-modifier-spin" />
                {busy === "installing" ? "Installing" : "Uninstalling"}
              </span>
            ) : installed ? (
              <>
                {updateAvailable && (
                  <button type="button" className="tm-button" disabled={blocked} onClick={() => g && void installExtension(g)}>
                    Update to v{g!.version}
                  </button>
                )}
                {installed.enabled ? (
                  <button type="button" className="tm-button tm-button--secondary" disabled={blocked} onClick={() => void setExtensionEnabled(id, false)}>
                    Disable
                  </button>
                ) : (
                  <button type="button" className="tm-button" disabled={blocked} onClick={() => void setExtensionEnabled(id, true)}>
                    Enable
                  </button>
                )}
                <button type="button" className="tm-button tm-button--secondary" disabled={blocked} onClick={() => void uninstallExtension(id)}>
                  Uninstall
                </button>
                {installed.enabled && installed.manifest.themes.length > 0 && (
                  <button type="button" className="tm-button tm-button--secondary" disabled={blocked} onClick={() => executeCommand("workbench.action.selectTheme")}>
                    Set Color Theme
                  </button>
                )}
              </>
            ) : (
              <button type="button" className="tm-button" disabled={blocked || !g?.downloadUrl} onClick={() => g && void installExtension(g)}>
                Install
              </button>
            )}
          </div>
          {blocked && (
            <p className="tm-ext-notice" role="note">
              <Codicon name="lock" /> Extensions are disabled during exams.
            </p>
          )}
          {manifest?.hasCode && (
            <p className="tm-ext-notice is-warning" role="note">
              <Codicon name="warning" />
              <span>
                This extension contains code that TMCode cannot run yet.
                {summary.length ? ` TMCode ${installed ? "applies" : "will apply"} only its declarative parts (${summary.join(", ")}); its commands, views and other features will not work.` : " None of its features will work in TMCode."}
              </span>
            </p>
          )}
          {installed && !installed.enabled && <p className="tm-ext-notice">This extension is disabled.</p>}
        </div>
      </header>

      <div className="tm-ext-tabs" role="tablist" aria-label="Extension details">
        <button type="button" role="tab" aria-selected={tab === "details"} className={tab === "details" ? "is-active" : ""} onClick={() => setTab("details")}>
          Details
        </button>
        <button type="button" role="tab" aria-selected={tab === "features"} className={tab === "features" ? "is-active" : ""} onClick={() => setTab("features")}>
          Features
        </button>
      </div>

      <div className="tm-ext-content">
        <div className="tm-ext-main" role="tabpanel">
          {tab === "details" ? (
            d.readme === null ? (
              <div aria-busy="true" aria-label="Loading README">
                {[90, 75, 82, 60, 70].map((w, i) => (
                  <span key={i} className="tm-skeleton tm-ext-skeleton-line" style={{ width: `${w}%` }} />
                ))}
              </div>
            ) : html ? (
              <div
                ref={readmeRef}
                className="tm-ext-readme tm-md"
                dangerouslySetInnerHTML={{ __html: html }}
                onClick={(e) => {
                  // Links never navigate the workbench window.
                  if ((e.target as HTMLElement).closest("a")) e.preventDefault();
                }}
              />
            ) : (
              <p className="tm-muted">{d.galleryError ? `Could not load details from Open VSX (${d.galleryError}).` : "No README available."}</p>
            )
          ) : manifest ? (
            <Features manifest={manifest} />
          ) : (
            <p className="tm-muted">Loading…</p>
          )}
        </div>
        <aside className="tm-ext-aside" aria-label="More information">
          {installed && (
            <section>
              <h3>Installation</h3>
              <dl>
                <dt>Identifier</dt>
                <dd>{id}</dd>
                <dt>Version</dt>
                <dd>{installed.version}</dd>
              </dl>
            </section>
          )}
          <section>
            <h3>Marketplace</h3>
            <dl>
              {!installed && (
                <>
                  <dt>Identifier</dt>
                  <dd>{id}</dd>
                </>
              )}
              {g?.version && (
                <>
                  <dt>Latest version</dt>
                  <dd>{g.version}</dd>
                </>
              )}
              {g?.timestamp && (
                <>
                  <dt>Last released</dt>
                  <dd>{new Date(g.timestamp).toLocaleDateString()}</dd>
                </>
              )}
              <dt>Registry</dt>
              <dd>Open VSX</dd>
            </dl>
          </section>
          {!!(g?.categories?.length || manifest?.categories.length) && (
            <section>
              <h3>Categories</h3>
              <div className="tm-ext-chips">
                {(g?.categories?.length ? g.categories : manifest!.categories).map((c) => (
                  <span key={c} className="tm-ext-chip">
                    {c}
                  </span>
                ))}
              </div>
            </section>
          )}
          {(g?.repository || g?.license) && (
            <section>
              <h3>Resources</h3>
              <dl>
                {g.license && (
                  <>
                    <dt>License</dt>
                    <dd>{g.license}</dd>
                  </>
                )}
                {g.repository && (
                  <>
                    <dt>Repository</dt>
                    <dd className="tm-ext-url">{g.repository}</dd>
                  </>
                )}
              </dl>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
