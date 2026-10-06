import { registerCommand } from "../commands/registry";
import { revealView, showPanel, useWorkbench } from "../state/store";
import {
  checkoutBranch,
  cloneRepository,
  commit,
  configureIdentity,
  createBranch,
  createBranchFrom,
  discard,
  gitAllowed,
  gitHost,
  hasRepo,
  initRepository,
  redetectGit,
  refreshStatus,
  runRemote,
  signInWithToken,
  signOut,
  stageResources,
  stash,
  syncOrPublish,
  unstage,
  useGit,
  wireGit,
} from "./gitService";
import { wireGitGutter } from "./gutter";
import { groupsOf } from "./model";

/**
 * VS Code's git commands (same ids and titles), all disabled outside
 * practice mode so neither the palette nor a keybinding reaches git in an exam.
 */

let registered = false;

export function registerGitCommands() {
  if (registered) return;
  registered = true;
  const repo = hasRepo;
  const folder = () => gitAllowed() && !!useWorkbench.getState().workspace;
  const idle = () => repo() && !useGit.getState().remoteOp;
  const groups = () => groupsOf(useGit.getState().status);

  registerCommand({ id: "workbench.view.scm", title: "Show Source Control", category: "View", keybinding: "ctrl+shift+g", enabled: gitAllowed, run: () => revealView("scm") });
  registerCommand({ id: "git.refresh", title: "Refresh", category: "Git", enabled: folder, run: () => refreshStatus() });
  registerCommand({ id: "git.init", title: "Initialize Repository", category: "Git", enabled: () => folder() && !useGit.getState().status, run: initRepository });
  registerCommand({ id: "git.clone", title: "Clone", category: "Git", enabled: gitAllowed, run: () => cloneRepository() });
  registerCommand({ id: "git.commit", title: "Commit", category: "Git", enabled: repo, run: () => commit("commit") });
  registerCommand({ id: "git.commitAll", title: "Commit All", category: "Git", enabled: repo, run: () => commit("all") });
  registerCommand({ id: "git.commitAmend", title: "Commit (Amend)", category: "Git", enabled: repo, run: () => commit("amend") });
  registerCommand({ id: "git.commitPush", title: "Commit & Push", category: "Git", enabled: idle, run: () => commit("commitPush") });
  registerCommand({ id: "git.commitSync", title: "Commit & Sync", category: "Git", enabled: idle, run: () => commit("commitSync") });
  registerCommand({ id: "git.stageAll", title: "Stage All Changes", category: "Git", enabled: repo, run: () => stageResources([...groups().changes, ...groups().merge]) });
  registerCommand({ id: "git.unstageAll", title: "Unstage All Changes", category: "Git", enabled: repo, run: () => unstage(groups().staged.map((r) => r.path)) });
  registerCommand({ id: "git.cleanAll", title: "Discard All Changes", category: "Git", enabled: repo, run: () => discard(groups().changes) });
  registerCommand({ id: "git.pull", title: "Pull", category: "Git", enabled: idle, run: () => runRemote("pull") });
  registerCommand({ id: "git.push", title: "Push", category: "Git", enabled: idle, run: () => runRemote("push") });
  registerCommand({ id: "git.fetch", title: "Fetch", category: "Git", enabled: idle, run: () => runRemote("fetch") });
  registerCommand({ id: "git.sync", title: "Sync", category: "Git", enabled: idle, run: syncOrPublish });
  registerCommand({ id: "git.publish", title: "Publish Branch...", category: "Git", enabled: idle, run: () => runRemote("publish") });
  registerCommand({ id: "git.checkout", title: "Checkout to...", category: "Git", enabled: repo, run: checkoutBranch });
  registerCommand({ id: "git.branch", title: "Create Branch...", category: "Git", enabled: repo, run: createBranch });
  registerCommand({ id: "git.branchFrom", title: "Create Branch From...", category: "Git", enabled: repo, run: createBranchFrom });
  registerCommand({ id: "git.stash", title: "Stash", category: "Git", enabled: repo, run: () => stash("push") });
  registerCommand({ id: "git.stashPopLatest", title: "Pop Latest Stash", category: "Git", enabled: repo, run: () => stash("pop") });
  registerCommand({ id: "git.setIdentity", title: "Set Commit Author (Name and Email)...", category: "Git", enabled: gitAllowed, run: configureIdentity });
  registerCommand({ id: "git.rescan", title: "Detect Git Installation", category: "Git", enabled: () => !!gitHost(), run: redetectGit });
  registerCommand({ id: "git.showOutput", title: "Show Git Output", category: "Git", enabled: gitAllowed, run: () => showPanel("output") });
  registerCommand({
    id: "github.signIn",
    title: "Sign in with a Personal Access Token",
    category: "GitHub",
    enabled: () => !!gitHost()?.github && !useGit.getState().user,
    run: () => signInWithToken(),
  });
  registerCommand({ id: "github.signOut", title: "Sign Out", category: "GitHub", enabled: () => !!gitHost()?.github && !!useGit.getState().user, run: signOut });
}

/** Commands, the repository service and the gutter, once per app. */
export function wireScm() {
  registerGitCommands();
  wireGit();
  wireGitGutter(gitHost);
}
