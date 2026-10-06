import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { executeCommand } from "../commands/registry";
import { getPlatform, openContextMenu, openFile, revealView, select, toggleDir, useWorkbench, type ContextMenuItem } from "../state/store";
import { basename, dirname } from "../util/paths";
import { ActionButton, Codicon, FileIcon } from "../widgets/icons";
import {
  GIT_DOWNLOAD_URL,
  commit,
  discard,
  initRepository,
  openResource,
  redetectGit,
  stageResources,
  unstage,
  useGit,
  useGitAllowed,
  type CommitKind,
} from "./gitService";
import { groupsOf, primaryAction, type Resource } from "./model";

/** VS Code's Source Control view: commit box, Merge / Staged / Changes, and the recent commits. */
export function ScmView() {
  const allowed = useGitAllowed();
  const workspace = useWorkbench((s) => s.workspace);
  const info = useGit((s) => s.info);
  const loaded = useGit((s) => s.loaded);
  const status = useGit((s) => s.status);
  const hasGit = (() => {
    try {
      return !!getPlatform().git;
    } catch {
      return false;
    }
  })();

  if (!hasGit) {
    return (
      <div className="tm-view-empty tm-scm-empty">
        <p>Source Control is available in the TMCode desktop app, using the Git installed on your computer.</p>
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="tm-view-empty tm-scm-empty">
        <p>Source Control is turned off during exams.</p>
      </div>
    );
  }
  if (!workspace) {
    return (
      <div className="tm-view-empty tm-scm-empty">
        <p>In order to use git features, you can open a folder containing a git repository or clone from a URL.</p>
        <button className="tm-button tm-button--block" onClick={() => executeCommand("workbench.action.files.openFolder")}>
          Open Folder
        </button>
        <button className="tm-button tm-button--block" onClick={() => executeCommand("git.clone")}>
          Clone Repository
        </button>
        <p className="tm-muted">To learn more about how to use git and source control, read the Git guides on git-scm.com.</p>
      </div>
    );
  }
  if (info && !info.installed) return <InstallGit />;
  if (!loaded) return <ScmSkeleton />;
  if (!status) {
    return (
      <div className="tm-view-empty tm-scm-empty">
        <p>The folder currently open doesn't have a git repository. You can initialize a repository which will enable source control features powered by git.</p>
        <button className="tm-button tm-button--block" onClick={() => void initRepository()}>
          Initialize Repository
        </button>
        <p className="tm-muted">You can also clone a repository from a URL or from GitHub into another folder.</p>
        <button className="tm-button tm-button--block tm-button--secondary" onClick={() => executeCommand("git.clone")}>
          Clone Repository
        </button>
      </div>
    );
  }
  return <Repository />;
}

function ScmSkeleton() {
  return (
    <div className="tm-scm" aria-busy="true" aria-label="Loading source control">
      <div className="tm-scm-commit">
        <div className="tm-skeleton" style={{ height: 26 }} />
        <div className="tm-skeleton" style={{ height: 26, marginTop: 8 }} />
      </div>
      {[70, 52, 64, 44].map((w, i) => (
        <div key={i} className="tm-scm-skeleton-row">
          <span className="tm-skeleton" style={{ width: 16, height: 14 }} />
          <span className="tm-skeleton" style={{ width: `${w}%`, height: 10 }} />
        </div>
      ))}
    </div>
  );
}

function InstallGit() {
  const os = getPlatform().os;
  const steps =
    os === "mac"
      ? [
          <>
            Install Apple's Command Line Tools: open <strong>Terminal</strong> and run <code>xcode-select --install</code>
          </>,
          <>
            or install it with Homebrew: <code>brew install git</code>
          </>,
        ]
      : os === "windows"
        ? [
            <>Download and run the Git for Windows installer (keep the default options)</>,
            <>
              or in a terminal: <code>winget install --id Git.Git -e</code>
            </>,
          ]
        : [
            <>
              Debian / Ubuntu: <code>sudo apt install git</code>
            </>,
            <>
              Fedora: <code>sudo dnf install git</code> · Arch: <code>sudo pacman -S git</code>
            </>,
          ];
  return (
    <div className="tm-view-empty tm-scm-empty tm-scm-install">
      <p>
        <strong>Git not found.</strong> Install Git, a popular source control system, to track code changes and collaborate with others.
      </p>
      <ol>
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <button className="tm-button tm-button--block" onClick={() => getPlatform().git?.openExternal?.(GIT_DOWNLOAD_URL)}>
        Download Git
      </button>
      <button className="tm-button tm-button--block tm-button--secondary" onClick={() => void redetectGit()}>
        Reload
      </button>
      <p className="tm-muted">After installing, choose Reload. TMCode looks for git on your PATH and in the usual install locations.</p>
    </div>
  );
}

const COMMIT_MENU: { label: string; kind: CommitKind }[] = [
  { label: "Commit", kind: "commit" },
  { label: "Commit (Amend)", kind: "amend" },
  { label: "Commit & Push", kind: "commitPush" },
  { label: "Commit & Sync", kind: "commitSync" },
];

function Repository() {
  const status = useGit((s) => s.status)!;
  const busy = useGit((s) => s.busy);
  const remoteOp = useGit((s) => s.remoteOp);
  const message = useGit((s) => s.message);
  const commits = useGit((s) => s.log);
  const os = getPlatform().os;
  const groups = groupsOf(status);
  const primary = primaryAction(status);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const branch = status.branch ?? status.oid?.slice(0, 8) ?? "HEAD";

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener("tmcode:scm-focus-input", focus);
    return () => window.removeEventListener("tmcode:scm-focus-input", focus);
  }, []);

  // Grows with the message, up to ten lines, like VS Code's input.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 10 * 18 + 8)}px`;
  }, [message]);

  const working = !!busy || !!remoteOp;
  const primaryButton =
    primary === "sync" ? (
      <button type="button" className="tm-button tm-scm-primary" disabled={working} onClick={() => executeCommand("git.sync")} title={`Synchronize Changes (pull ${status.behind}, push ${status.ahead})`}>
        <Codicon name={remoteOp ? "sync" : "sync"} className={remoteOp ? "codicon-modifier-spin" : ""} /> Sync Changes {status.behind > 0 && `${status.behind}↓`} {status.ahead > 0 && `${status.ahead}↑`}
      </button>
    ) : primary === "publish" ? (
      <button type="button" className="tm-button tm-scm-primary" disabled={working} onClick={() => executeCommand("git.publish")} title={`Publish branch '${branch}'`}>
        <Codicon name="cloud-upload" /> Publish Branch
      </button>
    ) : (
      <div className="tm-scm-split">
        <button type="button" className="tm-button tm-scm-primary" disabled={working} onClick={() => void commit("commit")} title={`Commit Changes on "${branch}"`}>
          <Codicon name={busy === "Committing" ? "loading" : "check"} className={busy === "Committing" ? "codicon-modifier-spin" : ""} /> Commit
        </button>
        <button
          type="button"
          className="tm-button tm-scm-dropdown"
          disabled={working}
          aria-label="More commit actions"
          title="More Actions..."
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openContextMenu(r.right - 180, r.bottom + 2, COMMIT_MENU.map((m) => ({ kind: "item", label: m.label, run: () => void commit(m.kind) })));
          }}
        >
          <Codicon name="chevron-down" />
        </button>
      </div>
    );

  return (
    <div className="tm-scm tm-scroll">
      <div className="tm-scm-commit">
        <textarea
          ref={inputRef}
          className="tm-input tm-scm-input"
          rows={1}
          value={message}
          spellCheck
          placeholder={`Message (${os === "mac" ? "⌘Enter" : "Ctrl+Enter"} to commit on '${branch}')`}
          aria-label={`Source Control Input: Message (${os === "mac" ? "⌘Enter" : "Ctrl+Enter"} to commit on '${branch}')`}
          onChange={(e) => useGit.setState({ message: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (os === "mac" ? e.metaKey : e.ctrlKey)) {
              e.preventDefault();
              e.stopPropagation();
              void commit("commit");
            }
          }}
        />
        {primaryButton}
        {status.truncated && <p className="tm-scm-note">Too many changes: only the first 5000 are shown.</p>}
      </div>
      {groups.merge.length > 0 && <Section id="merge" title="Merge Changes" resources={groups.merge} />}
      {groups.staged.length > 0 && <Section id="staged" title="Staged Changes" resources={groups.staged} />}
      <Section id="changes" title="Changes" resources={groups.changes} />
      <CommitsPane commits={commits} />
    </div>
  );
}

function Section({ id, title, resources }: { id: "merge" | "staged" | "changes"; title: string; resources: Resource[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const staged = id === "staged";
  const treeRef = useRef<HTMLDivElement>(null);

  const actions =
    id === "staged" ? (
      <ActionButton icon="remove" label="Unstage All Changes" onClick={() => void unstage(resources.map((r) => r.path))} />
    ) : id === "merge" ? (
      <ActionButton icon="add" label="Stage All Merge Changes" onClick={() => void stageResources(resources)} />
    ) : (
      <>
        <ActionButton icon="discard" label="Discard All Changes" disabled={!resources.length} onClick={() => void discard(resources)} />
        <ActionButton icon="add" label="Stage All Changes" disabled={!resources.length} onClick={() => void stageResources(resources)} />
      </>
    );

  const onKeyDown = (e: KeyboardEvent) => {
    const rows = [...(treeRef.current?.querySelectorAll<HTMLElement>(".tm-scm-row") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") rows[Math.min(rows.length - 1, at + 1)]?.focus();
    else if (e.key === "ArrowUp") rows[Math.max(0, at - 1)]?.focus();
    else return;
    e.preventDefault();
  };

  return (
    <div className={`tm-scm-section is-${id}`} data-section={id}>
      <div
        className="tm-scm-section-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setCollapsed(!collapsed)}
      >
        <Codicon name={collapsed ? "chevron-right" : "chevron-down"} />
        <span className="tm-scm-section-title">{title}</span>
        <span className="tm-scm-section-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
        <span className="tm-badge tm-scm-count" aria-label={`${resources.length} changes`}>
          {resources.length}
        </span>
      </div>
      {!collapsed && (
        <div ref={treeRef} role="tree" aria-label={title} onKeyDown={onKeyDown}>
          {resources.map((r, i) => (
            <Row key={`${id}:${r.path}`} r={r} staged={staged} first={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ r, staged, first }: { r: Resource; staged: boolean; first: boolean }) {
  const name = basename(r.path);
  const folder = dirname(r.path);
  const revealInExplorer = async () => {
    revealView("explorer");
    const parts = r.path.split("/");
    for (let j = 1; j < parts.length; j++) await toggleDir(parts.slice(0, j).join("/"), true);
    select(r.path);
  };
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      ...(r.untracked || r.group === "merge" ? [] : ([{ kind: "item", label: "Open Changes", run: () => openResource(r, { pinned: true }) }] as ContextMenuItem[])),
      { kind: "item", label: "Open File", disabled: r.deleted, run: () => openFile(r.path, { pinned: true }) },
      { kind: "separator" },
      staged
        ? { kind: "item", label: "Unstage Changes", run: () => void unstage([r.path]) }
        : { kind: "item", label: "Stage Changes", run: () => void stageResources([r]) },
      ...(staged ? [] : ([{ kind: "item", label: r.untracked ? "Delete File" : "Discard Changes", danger: true, run: () => void discard([r]) }] as ContextMenuItem[])),
      { kind: "separator" },
      { kind: "item", label: "Reveal in Explorer View", disabled: r.deleted, run: () => void revealInExplorer() },
    ];
    openContextMenu(e.clientX, e.clientY, items);
  };
  return (
    <div
      className={`tm-list-row tm-scm-row is-${r.color} ${r.deleted ? "is-deleted" : ""}`}
      role="treeitem"
      tabIndex={first ? 0 : -1}
      data-path={r.path}
      title={`${r.path}${r.origPath ? ` ← ${r.origPath}` : ""} • ${r.tooltip}`}
      onClick={() => openResource(r)}
      onDoubleClick={() => openResource(r, { pinned: true })}
      onKeyDown={(e) => {
        if (e.key === "Enter") openResource(r, { pinned: true });
        else if (e.key === " ") openResource(r);
        else return;
        e.preventDefault();
      }}
      onContextMenu={menu}
    >
      <FileIcon path={r.path} />
      <span className="tm-scm-name">{name}</span>
      {folder && <span className="tm-scm-folder">{folder}</span>}
      <span className="tm-scm-row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <ActionButton icon="go-to-file" label="Open File" disabled={r.deleted} onClick={() => openFile(r.path, { pinned: true })} />
        {!staged && <ActionButton icon="discard" label={r.untracked ? "Delete File" : "Discard Changes"} onClick={() => void discard([r])} />}
        {staged ? (
          <ActionButton icon="remove" label="Unstage Changes" onClick={() => void unstage([r.path])} />
        ) : (
          <ActionButton icon="add" label="Stage Changes" onClick={() => void stageResources([r])} />
        )}
      </span>
      <span className={`tm-scm-letter is-${r.color}`} title={r.tooltip}>
        {r.letter}
      </span>
    </div>
  );
}

function relative(ts: number) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

function CommitsPane({ commits }: { commits: { hash: string; short: string; author: string; date: number; refs: string; subject: string }[] }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="tm-scm-section is-graph" data-section="graph">
      <div
        className="tm-scm-section-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setCollapsed(!collapsed)}
      >
        <Codicon name={collapsed ? "chevron-right" : "chevron-down"} />
        <span className="tm-scm-section-title">Commits</span>
        <span className="tm-scm-section-actions" onClick={(e) => e.stopPropagation()}>
          <ActionButton icon="repo-fetch" label="Fetch" onClick={() => executeCommand("git.fetch")} />
          <ActionButton icon="repo-pull" label="Pull" onClick={() => executeCommand("git.pull")} />
          <ActionButton icon="repo-push" label="Push" onClick={() => executeCommand("git.push")} />
        </span>
      </div>
      {!collapsed && (
        <div role="list" aria-label="Recent commits">
          {commits.length === 0 && <div className="tm-view-hint">No commits yet.</div>}
          {commits.map((c) => (
            <div key={c.hash} role="listitem" className="tm-list-row tm-scm-commit-row" title={`${c.short} ${c.subject}\n${c.author}, ${new Date(c.date * 1000).toLocaleString()}`}>
              <Codicon name="git-commit" className="tm-scm-commit-icon" />
              <span className="tm-scm-name">{c.subject}</span>
              {c.refs
                .split(", ")
                .filter((r) => r && r !== "HEAD")
                .slice(0, 2)
                .map((r) => (
                  <span key={r} className="tm-scm-ref">
                    {r.replace("HEAD -> ", "")}
                  </span>
                ))}
              <span className="tm-scm-folder">
                {c.author} · {relative(c.date)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Title-bar actions of the Source Control view (✓, ↻, ⋯), as in VS Code. */
export function ScmTitleActions() {
  const repo = useGit((s) => !!s.status);
  const allowed = useGitAllowed();
  const os = getPlatform().os;
  if (!allowed) return null;
  const item = (label: string, command: string, keybinding?: string): ContextMenuItem => ({ kind: "item", label, keybinding, run: () => executeCommand(command) });
  return (
    <>
      {repo && <ActionButton icon="check" label={`Commit (${os === "mac" ? "⌘Enter" : "Ctrl+Enter"})`} onClick={() => void commit("commit")} />}
      <ActionButton icon="refresh" label="Refresh" onClick={() => executeCommand("git.refresh")} />
      <ActionButton
        icon="ellipsis"
        label="More Actions..."
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const items: ContextMenuItem[] = repo
            ? [
                item("Pull", "git.pull"),
                item("Push", "git.push"),
                item("Clone", "git.clone"),
                item("Checkout to...", "git.checkout"),
                item("Fetch", "git.fetch"),
                { kind: "separator" },
                item("Commit", "git.commit"),
                item("Commit All", "git.commitAll"),
                item("Commit (Amend)", "git.commitAmend"),
                item("Commit & Push", "git.commitPush"),
                { kind: "separator" },
                item("Stage All Changes", "git.stageAll"),
                item("Unstage All Changes", "git.unstageAll"),
                item("Discard All Changes", "git.cleanAll"),
                { kind: "separator" },
                item("Sync", "git.sync"),
                item("Publish Branch...", "git.publish"),
                item("Create Branch...", "git.branch"),
                item("Create Branch From...", "git.branchFrom"),
                { kind: "separator" },
                item("Stash", "git.stash"),
                item("Pop Latest Stash", "git.stashPopLatest"),
                { kind: "separator" },
                item("Show Git Output", "git.showOutput"),
              ]
            : [item("Clone", "git.clone"), item("Initialize Repository", "git.init"), { kind: "separator" }, item("Show Git Output", "git.showOutput")];
          openContextMenu(r.left, r.bottom + 2, items);
        }}
      />
    </>
  );
}
