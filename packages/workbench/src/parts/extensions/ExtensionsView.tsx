import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { executeCommand } from "../../commands/registry";
import { useExam } from "../../exam/state";
import { getPlatform, openContextMenu, openEditorInput, useWorkbench } from "../../state/store";
import { ActionButton, Codicon } from "../../widgets/icons";
import { SkeletonCard } from "../../widgets/Skeleton";
import { RECOMMENDED, formatCount, galleryIcon, getGalleryExtension, rememberGallery, searchGallery, type GalleryExtension } from "../../extensions/gallery";
import { extensionHost, installExtension, installFromVsix, setExtensionEnabled, uninstallExtension, useExtensions, type InstalledExtension } from "../../extensions/service";
import { parseJsonc } from "../../textmate/jsonc";
import { setExtensionsQuery, useExtensionsView } from "../../extensions/viewState";
import { RuntimeBadge } from "../../exthost/ui";

/**
 * VS Code's Extensions view over Open VSX: a marketplace search box; with no
 * query, the Installed and Recommended sections. Rows open the extension's
 * details editor.
 */

export function openExtensionEditor(id: string) {
  openEditorInput({ kind: "extension", id: `extension:${id}`, extensionId: id, preview: false });
}

/** Exams lock extensions down; the view says so instead of offering them. */
export function useExtensionsBlocked() {
  const examPhase = useExam((s) => s.phase);
  const practice = useWorkbench((s) => s.policy.mode === "practice");
  return examPhase === "active" || examPhase === "locked" || examPhase === "submitting" || !practice;
}

/** Icon of a gallery or installed extension, as a data: URL (null while loading or when there is none). */
export function useExtensionIcon(gallery?: GalleryExtension | null, installed?: InstalledExtension) {
  const [src, setSrc] = useState<string | null>(null);
  const iconUrl = gallery?.iconUrl;
  const localIcon = installed?.manifest.icon;
  const id = installed?.id;
  useEffect(() => {
    const host = extensionHost();
    if (!host) return;
    let live = true;
    const load = async () => {
      if (id && localIcon) {
        try {
          const b64 = await host.readFile(id, localIcon, "base64");
          return `data:${localIcon.toLowerCase().endsWith(".svg") ? "image/svg+xml" : localIcon.toLowerCase().endsWith(".jpg") ? "image/jpeg" : "image/png"};base64,${b64}`;
        } catch {
          /* fall back to the gallery icon */
        }
      }
      return iconUrl ? galleryIcon(host, iconUrl) : null;
    };
    void load().then((v) => live && setSrc(v));
    return () => {
      live = false;
    };
  }, [iconUrl, localIcon, id]);
  return src;
}

export function ExtensionIcon({ gallery, installed, size }: { gallery?: GalleryExtension | null; installed?: InstalledExtension; size: number }) {
  const src = useExtensionIcon(gallery, installed);
  return src ? (
    <img className="tm-ext-icon" src={src} width={size} height={size} alt="" draggable={false} />
  ) : (
    <span className="tm-ext-icon tm-ext-icon--placeholder" style={{ width: size, height: size }} aria-hidden>
      <Codicon name="extensions" style={{ fontSize: Math.round(size * 0.55) }} />
    </span>
  );
}

export function Rating({ value, count }: { value?: number; count?: number }) {
  if (value === undefined) return null;
  return (
    <span className="tm-ext-stat" title={`Average rating: ${value.toFixed(1)} out of 5${count ? ` (${count} ratings)` : ""}`}>
      <Codicon name="star-full" className="tm-ext-star" />
      {value.toFixed(1)}
    </span>
  );
}

/** Install / manage button of a row (VS Code: "Install", or a gear for installed ones). */
function RowAction({ ext, installed }: { ext: GalleryExtension | null; installed?: InstalledExtension }) {
  const busy = useExtensions((s) => s.busy[installed?.id ?? ext?.id ?? ""]);
  if (busy) {
    return (
      <span className="tm-ext-busy" role="status">
        <Codicon name="loading" className="codicon-modifier-spin" />
        {busy === "installing" ? "Installing" : "Uninstalling"}
      </span>
    );
  }
  if (!installed) {
    return ext ? (
      <button
        type="button"
        className="tm-button tm-ext-install"
        onClick={(e) => {
          e.stopPropagation();
          void installExtension(ext);
        }}
      >
        Install
      </button>
    ) : null;
  }
  return (
    <ActionButton
      icon="gear"
      label="Manage"
      className="tm-ext-manage"
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openContextMenu(r.left, r.bottom + 2, [
          installed.enabled
            ? { kind: "item", label: "Disable", run: () => void setExtensionEnabled(installed.id, false) }
            : { kind: "item", label: "Enable", run: () => void setExtensionEnabled(installed.id, true) },
          { kind: "item", label: "Uninstall", run: () => void uninstallExtension(installed.id) },
          { kind: "separator" },
          ...(installed.manifest.themes.length ? [{ kind: "item" as const, label: "Set Color Theme", run: () => executeCommand("workbench.action.selectTheme") }] : []),
          ...(installed.manifest.iconThemes.length ? [{ kind: "item" as const, label: "Set File Icon Theme", run: () => executeCommand("workbench.action.selectIconTheme") }] : []),
          { kind: "item", label: "Copy Extension ID", run: () => void navigator.clipboard?.writeText(installed.id).catch(() => {}) },
        ]);
      }}
    />
  );
}

function ExtensionRow({ ext, installed }: { ext: GalleryExtension | null; installed?: InstalledExtension }) {
  const name = installed?.manifest.displayName ?? ext?.displayName ?? "";
  const description = installed?.manifest.description || ext?.description || "";
  const publisher = ext?.publisher ?? installed?.manifest.publisher ?? "";
  const id = installed?.id ?? ext!.id;
  const open = () => {
    if (ext) rememberGallery(ext);
    openExtensionEditor(id);
  };
  return (
    <div
      className={`tm-ext-row ${installed && !installed.enabled ? "is-disabled" : ""}`}
      role="listitem"
      tabIndex={0}
      data-ext-id={id}
      aria-label={`${name}, ${publisher}${installed ? (installed.enabled ? ", installed" : ", disabled") : ""}`}
      onClick={open}
      onKeyDown={(e: KeyboardEvent) => e.key === "Enter" && e.target === e.currentTarget && open()}
    >
      <ExtensionIcon gallery={ext} installed={installed} size={42} />
      <div className="tm-ext-row-main">
        <div className="tm-ext-row-line">
          <span className="tm-ext-name">{name}</span>
          {installed && !installed.enabled && <span className="tm-ext-tag">Disabled</span>}
          <span className="tm-ext-row-stats">
            {ext && ext.downloadCount > 0 && (
              <span className="tm-ext-stat" title={`${ext.downloadCount.toLocaleString()} downloads`}>
                <Codicon name="cloud-download" />
                {formatCount(ext.downloadCount)}
              </span>
            )}
            {ext && <Rating value={ext.averageRating} count={ext.reviewCount} />}
          </span>
        </div>
        <div className="tm-ext-desc" title={description}>
          {description}
        </div>
        <div className="tm-ext-row-line">
          <span className="tm-ext-publisher">
            {ext?.verified && <Codicon name="verified-filled" className="tm-ext-verified" title="Verified publisher" />}
            {publisher}
          </span>
          {installed && <RuntimeBadge ext={installed} />}
          <span className="tm-ext-row-action">
            <RowAction ext={ext} installed={installed} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Marketplace-row placeholders (the shared skeleton card). */
function MarketplaceSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading extensions">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

function Section({ title, count, children, defaultOpen = true }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`tm-ext-section ${open ? "is-open" : ""}`} aria-label={title}>
      <div className="tm-pane-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} />
        <span className="tm-pane-title">{title}</span>
        {count !== undefined && <span className="tm-badge">{count}</span>}
      </div>
      {open && (
        <div className="tm-ext-list" role="list" aria-label={title}>
          {children}
        </div>
      )}
    </section>
  );
}

/** Workspace recommendations (.vscode/extensions.json) first, then TMCode's picks. */
function useRecommendations(installedIds: Set<string>) {
  const workspace = useWorkbench((s) => s.workspace?.root);
  const [state, setState] = useState<{ items: GalleryExtension[] | null; error: string | null }>({ items: null, error: null });
  useEffect(() => {
    const host = extensionHost();
    if (!host) return;
    let live = true;
    (async () => {
      let ids = [...RECOMMENDED];
      if (workspace) {
        const text = await getPlatform().fs.readFile(".vscode/extensions.json").catch(() => null);
        try {
          const rec = text ? parseJsonc<{ recommendations?: unknown }>(text).recommendations : null;
          if (Array.isArray(rec)) ids = [...rec.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()), ...ids];
        } catch {
          /* malformed extensions.json */
        }
      }
      ids = [...new Set(ids)];
      const results = await Promise.allSettled(ids.map((id) => getGalleryExtension(host, id)));
      const items = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (!live) return;
      setState({ items, error: !items.length && results.length ? "Could not reach Open VSX. Check your internet connection." : null });
    })();
    return () => {
      live = false;
    };
  }, [workspace]);
  return { items: state.items?.filter((e) => !installedIds.has(e.id)) ?? null, error: state.error };
}

function useSearch(query: string) {
  const [state, setState] = useState<{ items: GalleryExtension[] | null; total: number; error: string | null; loading: boolean }>({ items: null, total: 0, error: null, loading: false });
  useEffect(() => {
    const host = extensionHost();
    const q = query.trim();
    if (!host || !q || q.startsWith("@installed") || q.startsWith("@recommended")) {
      setState({ items: null, total: 0, error: null, loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(() => {
      searchGallery(host, q)
        .then((r) => live && setState({ items: r.extensions, total: r.total, error: null, loading: false }))
        .catch((e) => live && setState({ items: null, total: 0, error: `Error while searching Open VSX: ${String((e as Error)?.message ?? e)}`, loading: false }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  return state;
}

export function ExtensionsView() {
  const host = extensionHost();
  const blocked = useExtensionsBlocked();
  const query = useExtensionsView((s) => s.query);
  const focusSeq = useExtensionsView((s) => s.focusSeq);
  const installed = useExtensions((s) => s.installed);
  const loaded = useExtensions((s) => s.loaded);
  const inputRef = useRef<HTMLInputElement>(null);
  const installedIds = useMemo(() => new Set(installed.map((e) => e.id)), [installed]);
  const byId = useMemo(() => new Map(installed.map((e) => [e.id, e])), [installed]);
  const search = useSearch(blocked ? "" : query);
  const recommended = useRecommendations(installedIds);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusSeq]);

  if (!host) {
    return <div className="tm-pane tm-ext-view"><p className="tm-ext-message">Extensions are available in the TMCode desktop app.</p></div>;
  }
  if (blocked) {
    return (
      <div className="tm-pane tm-ext-view">
        <p className="tm-ext-message">
          <Codicon name="lock" /> Extensions are disabled during exams.
        </p>
      </div>
    );
  }

  const q = query.trim();
  const showInstalledOnly = q.startsWith("@installed");
  const showRecommendedOnly = q.startsWith("@recommended");
  const filterInstalled = (list: InstalledExtension[]) => {
    const term = q.replace(/^@installed/, "").trim().toLowerCase();
    return term ? list.filter((e) => `${e.manifest.displayName} ${e.id} ${e.manifest.description}`.toLowerCase().includes(term)) : list;
  };

  return (
    <div className="tm-pane tm-ext-view">
      <div className="tm-ext-search">
        <div className="tm-input-box">
          <input
            ref={inputRef}
            className="tm-input"
            type="search"
            aria-label="Search Extensions in Open VSX"
            placeholder="Search Extensions in Open VSX"
            value={query}
            spellCheck={false}
            onChange={(e) => setExtensionsQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setExtensionsQuery("")}
          />
          {query && <ActionButton icon="clear-all" label="Clear Extensions Search Results" onClick={() => setExtensionsQuery("", true)} />}
        </div>
      </div>
      {search.loading && <div className="tm-progress" role="progressbar" aria-label="Searching Open VSX" />}
      <div className="tm-pane-body tm-scroll tm-ext-body">
        {q && !showInstalledOnly && !showRecommendedOnly ? (
          search.error ? (
            <p className="tm-ext-message is-error">{search.error}</p>
          ) : search.items === null ? (
            <MarketplaceSkeleton count={6} />
          ) : search.items.length === 0 ? (
            <p className="tm-ext-message">No extensions found.</p>
          ) : (
            <div className="tm-ext-list" role="list" aria-label="Open VSX search results">
              {search.items.map((ext) => (
                <ExtensionRow key={ext.id} ext={ext} installed={byId.get(ext.id)} />
              ))}
            </div>
          )
        ) : (
          <>
            {!showRecommendedOnly && (
              <Section title="Installed" count={loaded ? filterInstalled(installed).length : undefined}>
                {!loaded ? (
                  <MarketplaceSkeleton count={2} />
                ) : installed.length === 0 ? (
                  <p className="tm-ext-message">No extensions installed. Themes, languages, snippets, formatters and other extensions from Open VSX work in TMCode.</p>
                ) : (
                  filterInstalled(installed).map((e) => <InstalledRow key={e.id} ext={e} />)
                )}
              </Section>
            )}
            {!showInstalledOnly && (
              <Section title="Recommended" count={recommended.items?.length}>
                {recommended.error ? (
                  <p className="tm-ext-message is-error">{recommended.error}</p>
                ) : recommended.items === null ? (
                  <MarketplaceSkeleton count={3} />
                ) : recommended.items.length === 0 ? (
                  <p className="tm-ext-message">All recommended extensions are installed.</p>
                ) : (
                  recommended.items.map((ext) => <ExtensionRow key={ext.id} ext={ext} />)
                )}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** An installed row also shows gallery stats once they are known (cached, never blocking). */
function InstalledRow({ ext }: { ext: InstalledExtension }) {
  const [gallery, setGallery] = useState<GalleryExtension | null>(null);
  useEffect(() => {
    const host = extensionHost();
    if (!host) return;
    let live = true;
    getGalleryExtension(host, ext.id)
      .then((g) => live && setGallery(g))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ext.id]);
  return <ExtensionRow ext={gallery} installed={ext} />;
}

/** Title-bar actions of the view (left of the "..." menu). */
export function ExtensionsTitleActions() {
  const blocked = useExtensionsBlocked();
  if (blocked || !extensionHost()) return null;
  return (
    <>
      <ActionButton icon="refresh" label="Refresh" onClick={() => executeCommand("workbench.extensions.action.refreshExtension")} />
      <ActionButton
        icon="filter"
        label="Filter Extensions..."
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openContextMenu(r.left, r.bottom + 2, [
            { kind: "item", label: "Installed", run: () => setExtensionsQuery("@installed", true) },
            { kind: "item", label: "Recommended", run: () => setExtensionsQuery("@recommended", true) },
            { kind: "separator" },
            { kind: "item", label: "Themes", run: () => setExtensionsQuery('@category:"themes"', true) },
            { kind: "item", label: "Programming Languages", run: () => setExtensionsQuery('@category:"programming languages"', true) },
            { kind: "item", label: "Snippets", run: () => setExtensionsQuery('@category:"snippets"', true) },
            { kind: "separator" },
            { kind: "item", label: "Install from VSIX...", disabled: !extensionHost()?.installVsix, run: () => void installFromVsix() },
          ]);
        }}
      />
    </>
  );
}
