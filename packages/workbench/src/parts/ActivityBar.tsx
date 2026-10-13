import { executeCommand, formatKeybinding, getCommand, keybindingFor } from "../commands/registry";
import { msg } from "../messages/catalog";
import { getPlatform, openContextMenu, showView, useWorkbench, type ViewId } from "../state/store";
import { Codicon } from "../widgets/icons";
import { useExam } from "../exam/state";
import { useUpdate } from "../update/updateService";
// ── git ──
import { useGit, useGitAllowed } from "../scm/gitService";
import { changeCount } from "../scm/model";
import { debugAllowed } from "../debug/debugService";
import { useProjects, signIn, refreshProjects } from "../projects/service";
import { useAssignments } from "../projects/assignments";
import { isToDo, studentTasks, isAssessmentWorkspace, signOutOnPurpose, wireStudentHome } from "../projects/studentHome";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { splitBar, type BarItem } from "./activityBarFit";
import { gradingQueue, useGrading } from "../grading/service";
import { isTeacherRole, useIsTeacher, useRole, useRoleChecking } from "../state/role";
import type { AccountStatus } from "../platform/types";
// ── extension view containers (exthost/views) ──
import { useViews, type ViewContainer } from "../exthost/views/model";
import { useWebviews } from "../exthost/views/webviews";
import { ExtIcon } from "../exthost/views/ExtIcon";

/** The student layout's views (guided plan J): where the work is, the files, search, and Run. */
const SIMPLE_IDS: ViewId[] = ["assignments", "explorer", "search", "debug"];

// The exam task: a checklist (Assignments has the mortar board).
const TASK_VIEW = { id: "task" as ViewId, icon: "checklist", label: "Task", command: "workbench.view.task" };
const VIEWS: { id: ViewId; icon: string; label: string; command: string }[] = [
  { id: "explorer", icon: "files", label: "Explorer", command: "workbench.view.explorer" },
  { id: "search", icon: "search", label: "Search", command: "workbench.view.search" },
  { id: "scm", icon: "source-control", label: "Source Control", command: "workbench.view.scm" },
  // ── Run and Debug ──
  { id: "debug", icon: "debug-alt", label: "Run and Debug", command: "workbench.view.debug" },
  // ── end Run and Debug ──
  { id: "testing", icon: "beaker", label: "Testing", command: "workbench.view.testing" },
];
// ── extensions (feat/extensions): hidden during exams ──
// ── Task Mentor projects: practice mode with an NGA account host ──
const PROJECTS_VIEW = { id: "projects" as ViewId, icon: "folder-library", label: "Task Mentor Projects", command: "workbench.view.projects" };
const ASSIGNMENTS_VIEW = { id: "assignments" as ViewId, icon: "mortar-board", label: "Assignments", command: "workbench.view.assignments" };
const GRADING_VIEW = { id: "grading" as ViewId, icon: "tasklist", label: "Grading", command: "workbench.view.grading" };
const EXTENSIONS_VIEW = { id: "extensions" as ViewId, icon: "extensions", label: "Extensions", command: "workbench.view.extensions" };

export function ActivityBar() {
  const activeView = useWorkbench((s) => s.activeView);
  const sidebarVisible = useWorkbench((s) => s.sidebarVisible);
  const dirtyCount = useWorkbench((s) => Object.keys(s.dirty).length);
  const failing = useWorkbench((s) => s.tests.items.filter((t) => t.status === "failed" || t.status === "error").length);
  const os = getPlatform().os;
  const inExam = useExam((s) => !!s.quiz);
  const updateReady = useUpdate((s) => s.status === "available");
  const practice = useWorkbench((s) => s.policy.mode === "practice");
  const gitAllowed = useGitAllowed();
  const scmChanges = useGit((s) => changeCount(s.status));
  // Run and Debug is hidden in exams unless the policy allows the debugger.
  useWorkbench((s) => s.policy);
  useExam((s) => s.phase);
  const hasAccount = !!getPlatform().account;
  const account = useProjects((s) => s.account);
  const projectSync = useProjects((s) => s.sync);
  // Teachers: the Grading view, with what waits to be graded.
  const grader = useGrading((s) => s.grader);
  const toGrade = useGrading((s) => gradingQueue(s.activities, s.rosters).toGrade);
  // Assignments to start or finish (not submitted, not completed).
  // One number (guided plan I): to-do tasks, quiz practicals included, by the same rule as Home and Assignments.
  const mine = useProjects((s) => s.mine);
  const current = useProjects((s) => s.current);
  const todo = useAssignments((s) => studentTasks(s.student, s.quizPracticals, mine, current).filter(isToDo).length);
  // Teachers keep Projects, Assignments, Grading; students get Assignments first. The role is
  // remembered per account, so a teacher's layout is there on the first frame (W2); while nobody
  // knows yet, only the shared Assignments view shows (never the student "All My Projects").
  const teacher = useIsTeacher();
  const checking = useRoleChecking();
  useEffect(() => wireStudentHome(), []);
  // L10 (0.17): where the work is comes first: Grading, Assignments for teachers; Assignments for students.
  const isTeacher = teacher || grader;
  const lead = isTeacher ? [GRADING_VIEW, ASSIGNMENTS_VIEW] : [ASSIGNMENTS_VIEW];
  // Students: their own projects live in Assignments › Other projects (one home), not a second view.
  const tail = isTeacher ? [PROJECTS_VIEW] : [];
  const base = inExam ? [TASK_VIEW, ...VIEWS] : practice ? [...(hasAccount ? lead : []), ...VIEWS, ...(hasAccount ? tail : []), EXTENSIONS_VIEW] : VIEWS;
  // L7 (0.17): a student's assignment workspace saves to Task Mentor; git is noise there unless asked for.
  const scmInAssignments = useWorkbench((s) => s.settings["scm.showInAssignments"] === true);
  const assignmentWs = useProjects((s) => !!s.binding && isAssessmentWorkspace(s.current, !!s.binding)) && !teacher;
  // A review folder is the student's submitted work: its git changes are noise for the teacher (T10).
  const reviewing = useGrading((s) => !!s.review);
  const allViews = base.filter((v) => (v.id !== "scm" || (gitAllowed && (!assignmentWs || scmInAssignments) && !reviewing)) && (v.id !== "debug" || debugAllowed()));
  // The student layout (guided plan J, U10): plain words, and Assignments, Files, Search, Run first.
  const simplePref = useWorkbench((s) => s.settings["workbench.simpleLayout"] !== false);
  const simple = simplePref && practice && !inExam && hasAccount && !!account?.signed_in && !isTeacher && !checking;
  const ordered = simple ? [...allViews.filter((v) => SIMPLE_IDS.includes(v.id)).sort((a, b) => SIMPLE_IDS.indexOf(a.id) - SIMPLE_IDS.indexOf(b.id)), ...allViews.filter((v) => !SIMPLE_IDS.includes(v.id))] : allViews;
  // Extensions never run in exams, so their containers only exist in practice mode.
  const extContainers = useViews((s) => s.containers).filter((c) => c.location === "activitybar" && practice && !inExam);

  // Every view shows while the bar has room (U10 revisited: a handful of icons is never hidden).
  // Only when the window is too short does the rest go under "More" — each entry once, and
  // never the view that is open.
  const items: BarItem[] = [...ordered.map((v) => ({ key: v.id as string, view: v })), ...extContainers.map((c) => ({ key: c.key, container: c }))];
  const nav = useRef<HTMLElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    const measure = () => {
      const itemH = el.querySelector<HTMLElement>(".tm-activitybar-top .tm-activity")?.offsetHeight || 48;
      const free = el.clientHeight - (bottom.current?.offsetHeight ?? 0);
      setCapacity(free > 0 ? Math.max(1, Math.floor(free / itemH)) : Number.POSITIVE_INFINITY);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { shown, overflow } = splitBar(items, capacity, sidebarVisible ? activeView : null);

  const label = (v: (typeof VIEWS)[number]) => {
    const cmd = getCommand(v.command);
    const kb = cmd ? formatKeybinding(keybindingFor(cmd, os), os) : "";
    // Plain words in the student layout: "Files", "Run".
    const name = simple ? (v.id === "explorer" ? "Files" : v.id === "debug" ? "Run" : v.label) : v.label;
    return kb ? `${name} (${kb})` : name;
  };

  return (
    <nav ref={nav} className="tm-activitybar" aria-label="Active View Switcher">
      <div className="tm-activitybar-top" role="tablist" aria-orientation="vertical">
        {shown.map((item) => {
          if (item.container) return <ExtContainerButton key={item.key} container={item.container} active={sidebarVisible && activeView === item.key} />;
          const v = item.view!;
          const active = sidebarVisible && activeView === v.id;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`tm-activity ${active ? "is-active" : ""}`}
              data-view={v.id}
              title={label(v)}
              aria-label={label(v)}
              onClick={() => showView(v.id)}
            >
              <Codicon name={v.icon} />
              {v.id === "explorer" && dirtyCount > 0 && <span className="tm-activity-badge">{dirtyCount}</span>}
              {v.id === "scm" && scmChanges > 0 && <span className="tm-activity-badge">{scmChanges > 9999 ? "10k+" : scmChanges}</span>}
              {v.id === "testing" && failing > 0 && <span className="tm-activity-badge is-error">{failing}</span>}
              {v.id === "grading" && toGrade > 0 && (
                <span className="tm-activity-badge" aria-label={`${toGrade} submissions to grade`}>
                  {toGrade > 99 ? "99+" : toGrade}
                </span>
              )}
              {v.id === "assignments" && todo > 0 && (
                <span className="tm-activity-badge" aria-label={`${todo} assignments to do`}>
                  {todo}
                </span>
              )}
              {/* Students see sync on the brief and the side-bar line; the "↑" here was noise (L7). Conflicts still show. */}
              {v.id === "projects" && (projectSync === "conflict" || ((teacher || grader) && (projectSync === "local-changes" || projectSync === "both"))) && (
                <span className={`tm-activity-badge ${projectSync === "conflict" ? "is-error" : ""}`} aria-label="Unsaved project changes">
                  {projectSync === "conflict" ? "!" : "↑"}
                </span>
              )}
            </button>
          );
        })}
        {overflow.length > 0 && (
          <button
            type="button"
            className="tm-activity"
            title="More Views"
            aria-label="More Views"
            aria-haspopup="menu"
            data-testid="activity-more"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openContextMenu(
                r.right + 4,
                r.top,
                overflow.map((item) => ({ kind: "item" as const, label: item.view ? label(item.view) : item.container!.title, run: () => showView(item.key as ViewId) })),
              );
            }}
          >
            <Codicon name="ellipsis" />
          </button>
        )}
      </div>
      {practice && !inExam && hasAccount && account?.signed_in && !checking && <CoachMark teacher={isTeacher} />}
      <div ref={bottom} className="tm-activitybar-bottom">
        {hasAccount && practice && !inExam && <AccountButton account={account} />}
        <button
          type="button"
          className="tm-activity"
          title="Manage"
          aria-label="Manage"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openContextMenu(r.right + 4, r.bottom - 8, [
              { kind: "item", label: "Command Palette...", keybinding: formatKeybinding("mod+shift+p", os), run: () => executeCommand("workbench.action.showCommands") },
              { kind: "separator" },
              { kind: "item", label: "Settings", keybinding: formatKeybinding("mod+,", os), run: () => executeCommand("workbench.action.openSettings") },
              { kind: "item", label: "Keyboard Shortcuts", keybinding: formatKeybinding("mod+k mod+s", os), run: () => executeCommand("workbench.action.keybindingsReference") },
              ...(practice && !inExam ? [{ kind: "item" as const, label: "Extensions", keybinding: formatKeybinding("mod+shift+x", os), run: () => executeCommand("workbench.view.extensions") }] : []),
              { kind: "separator" },
              { kind: "item", label: "Themes", keybinding: formatKeybinding("mod+k mod+t", os), run: () => executeCommand("workbench.action.selectTheme") },
              { kind: "separator" },
              updateReady
                ? { kind: "item", label: `Install Update and Restart (${useUpdate.getState().info?.version})`, run: () => executeCommand("update.restartToUpdate") }
                : { kind: "item", label: "Check for Updates...", disabled: !getCommand("update.checkForUpdates")?.enabled?.(), run: () => executeCommand("update.checkForUpdates") },
            ]);
          }}
        >
          <Codicon name="settings-gear" />
          {updateReady && <span className="tm-activity-badge" aria-label="Update available">1</span>}
        </button>
      </div>
    </nav>
  );
}

/** An extension's view container: its icon (monochrome, like VS Code's), with the sum of its views' badges. */
function ExtContainerButton({ container, active }: { container: ViewContainer; active: boolean }) {
  const badge = useViews((s) => s.views.filter((v) => v.container === container.key).reduce((n, v) => n + (s.meta[v.id]?.badge?.value ?? 0), 0));
  const webBadge = useWebviews((s) => Object.values(s.entries).filter((e) => e.kind === "view" && useViews.getState().views.some((v) => v.id === e.viewType && v.container === container.key)).reduce((n, e) => n + (e.meta.badge?.value ?? 0), 0));
  const total = badge + webBadge;
  return (
    <button type="button" role="tab" aria-selected={active} className={`tm-activity ${active ? "is-active" : ""}`} title={container.title} aria-label={container.title} data-testid={`activity-${container.key}`} onClick={() => showView(container.key)}>
      <ExtIcon icon={container.icon} mask size={24} className="tm-activity-ext-icon" />
      {total > 0 && <span className="tm-activity-badge">{total}</span>}
    </button>
  );
}

/** VS Code's Accounts menu: the NGA account (Central MIS + Task Mentor). */
function AccountButton({ account }: { account: AccountStatus | null }) {
  const user = account?.signed_in ? account.user : null;
  const busy = account?.phase === "waiting" || account?.phase === "completing";
  const initials = (user?.name ?? user?.email ?? "")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  const title = user ? `${user.name ?? user.email} (NGA)` : busy ? "Signing in… (continue in your browser)" : msg("signin.account");
  return (
    <button
      type="button"
      className="tm-activity tm-account-button"
      title={title}
      aria-label={title}
      aria-haspopup="menu"
      data-testid="account-button"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openContextMenu(
          r.right + 4,
          r.bottom - 8,
          user
            ? [
                { kind: "item", label: `${user.name ?? user.email}${user.role ? ` · ${user.role}` : ""}`, disabled: true, run: () => {} },
                { kind: "separator" },
                ...(isTeacherRole(useRole.getState().role) || useGrading.getState().grader ? [{ kind: "item" as const, label: "Grading", run: () => executeCommand("workbench.view.grading") }] : []),
                { kind: "item", label: "Assignments", run: () => executeCommand("workbench.view.assignments") },
                { kind: "item", label: isTeacherRole(useRole.getState().role) ? "Task Mentor Projects" : "All My Projects", run: () => executeCommand("workbench.view.projects") },
                { kind: "item", label: "Refresh Projects", run: () => void refreshProjects() },
                { kind: "separator" },
                { kind: "item", label: "Sign Out", run: () => void signOutOnPurpose() },
              ]
            : [
                busy
                  ? { kind: "item", label: "Cancel Sign-in", run: () => void getPlatform().account?.cancel() }
                  : { kind: "item", label: msg("signin.button"), run: () => void signIn() },
              ],
        );
      }}
    >
      {user ? <span className="tm-account-avatar">{initials || <Codicon name="account" />}</span> : <Codicon name={busy ? "loading" : "account"} className={busy ? "codicon-modifier-spin" : ""} />}
      {!user && account?.error && <span className="tm-activity-badge is-error" aria-label="Signed out">!</span>}
    </button>
  );
}

/**
 * A one-time pointer at the first icon for newcomers (L10): "Your assignments live here" or
 * "Grading lives here". Dismissed once, never shown again on this computer.
 */
function CoachMark({ teacher }: { teacher: boolean }) {
  const key = `tmcode:coach-${teacher ? "grading" : "assignments"}`;
  const [show, setShow] = useState(() => {
    try {
      return localStorage.getItem(key) !== "1";
    } catch {
      return false;
    }
  });
  // Seen once the person does anything (a click or a key): it never covers what they reach for.
  useEffect(() => {
    if (!show) return;
    const done = () => {
      setShow(false);
      try {
        localStorage.setItem(key, "1");
      } catch {
        /* private mode */
      }
    };
    window.addEventListener("mousedown", done, true);
    window.addEventListener("keydown", done, true);
    return () => {
      window.removeEventListener("mousedown", done, true);
      window.removeEventListener("keydown", done, true);
    };
  }, [show, key]);
  // Beside its icon, over the editor (U10): never over the side bar's filter or summary.
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!show) return;
    const measure = () => {
      const icon = document.querySelector<HTMLElement>(`.tm-activitybar [aria-label^="${teacher ? "Grading" : "Assignments"}"]`);
      const side = document.querySelector<HTMLElement>(".tm-sidebar");
      const bar = document.querySelector<HTMLElement>(".tm-activitybar");
      const left = Math.max(side && side.offsetWidth > 0 ? side.getBoundingClientRect().right : 0, bar?.getBoundingClientRect().right ?? 0) + 8;
      setPlace({ top: icon ? icon.getBoundingClientRect().top + 2 : 40, left });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [show, teacher]);
  if (!show) return null;
  return (
    <div className="tm-coach" role="status" data-testid="coach-mark" style={place ? { top: place.top, left: place.left } : undefined}>
      <b>{teacher ? "Grading lives here" : "Your assignments live here"}</b>
      <span>{teacher ? "What your students handed in, ready to grade." : "Start, continue and hand in your work from this icon."}</span>
    </div>
  );
}
