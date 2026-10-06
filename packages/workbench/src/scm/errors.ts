/**
 * Git's error text → a friendly message and the action that fixes it, like
 * VS Code's Git extension ("Can't push refs to remote. Try running Pull first…").
 */

export type GitErrorKind =
  | "cancelled"
  | "auth"
  | "rejected"
  | "conflict"
  | "noUpstream"
  | "noRemote"
  | "identity"
  | "dirtyCheckout"
  | "notFound"
  | "network"
  | "nothingToCommit"
  | "notInstalled"
  | "other";

/** What the error notification's button does. */
export type GitErrorAction = "signIn" | "pull" | "showConflicts" | "publish" | "setIdentity" | "stash" | "installGit" | "showOutput";

export interface GitError {
  kind: GitErrorKind;
  message: string;
  actions: { id: GitErrorAction; label: string }[];
}

const RULES: [RegExp, GitErrorKind][] = [
  [/^cancelled$/i, "cancelled"],
  [/git not found|could not start git/i, "notInstalled"],
  [/please tell me who you are|empty ident name|unable to auto-detect email/i, "identity"],
  [/would be overwritten by (checkout|merge)|your local changes to the following files/i, "dirtyCheckout"],
  [/\bCONFLICT\b|automatic merge failed|fix conflicts and then commit|you have unmerged paths|unmerged files|merge conflict/i, "conflict"],
  [/has no upstream branch|no upstream configured|there is no tracking information|no such ref was fetched/i, "noUpstream"],
  [/no remote repository is configured|no configured push destination|'origin' does not appear to be a git repository/i, "noRemote"],
  [/\[rejected\]|non-fast-forward|updates were rejected|fetch first/i, "rejected"],
  [
    /authentication failed|could not read (username|password)|terminal prompts disabled|invalid username or password|permission denied \(publickey\)|returned error: 40[13]|the requested url returned error: 403|support for password authentication was removed|write access to repository not granted/i,
    "auth",
  ],
  [/repository not found|does not appear to be a git repository|not found$/im, "notFound"],
  [/could not resolve host|failed to connect|connection timed out|connection refused|network is unreachable|unable to access|operation timed out|timed out/i, "network"],
  [/nothing to commit|no changes added to commit|nothing added to commit/i, "nothingToCommit"],
];

export function classifyGitError(raw: unknown): GitError {
  const text = String((raw as Error)?.message ?? raw ?? "").trim();
  const kind = RULES.find(([re]) => re.test(text))?.[1] ?? "other";
  const output = { id: "showOutput" as const, label: "Show Command Output" };
  switch (kind) {
    case "cancelled":
      return { kind, message: "Cancelled.", actions: [] };
    case "notInstalled":
      return { kind, message: "Git not found. Install it to use source control.", actions: [{ id: "installGit", label: "Download Git" }] };
    case "identity":
      return { kind, message: "Make sure you configure your 'user.name' and 'user.email' in git.", actions: [{ id: "setIdentity", label: "Configure Identity..." }, output] };
    case "dirtyCheckout":
      return { kind, message: "Your local changes would be overwritten by checkout. Please commit or stash your changes before switching branches.", actions: [{ id: "stash", label: "Stash Changes" }, output] };
    case "conflict":
      return { kind, message: "There are merge conflicts. Resolve them before committing.", actions: [{ id: "showConflicts", label: "Show Changes" }, output] };
    case "noUpstream":
      return { kind, message: "The current branch has no upstream branch. Would you like to publish this branch?", actions: [{ id: "publish", label: "Publish Branch" }] };
    case "noRemote":
      return { kind, message: "Your repository has no remotes configured to push to.", actions: [output] };
    case "rejected":
      return { kind, message: "Can't push refs to remote. Try running 'Pull' first to integrate your changes.", actions: [{ id: "pull", label: "Pull" }, output] };
    case "auth":
      return { kind, message: "Git: Authentication failed. Sign in to GitHub to push, pull and clone over HTTPS.", actions: [{ id: "signIn", label: "Sign in to GitHub" }, output] };
    case "notFound":
      return { kind, message: "Repository not found. Check the URL — and sign in to GitHub if it is private.", actions: [{ id: "signIn", label: "Sign in to GitHub" }, output] };
    case "network":
      return { kind, message: "Could not connect to the remote repository. Check your internet connection.", actions: [output] };
    case "nothingToCommit":
      return { kind, message: "There are no changes to commit.", actions: [] };
    default: {
      const line = text.split("\n").map((l) => l.replace(/^(fatal|error):\s*/i, "").trim()).find(Boolean) ?? "Git failed.";
      return { kind, message: `Git: ${line}`, actions: [output] };
    }
  }
}
