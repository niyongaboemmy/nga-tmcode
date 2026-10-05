/**
 * Clone URLs (mirrors git.rs `check_clone_url`): https / http / ssh / git URLs
 * and scp-like `git@host:owner/repo`; never an option, a local path or a
 * remote-helper transport. "github.com/owner/repo" is accepted as HTTPS.
 */
export function normalizeCloneUrl(input: string): string | null {
  let url = input.trim();
  if (/^(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?$/i.test(url)) url = `https://${url.replace(/^www\./i, "")}`;
  if (!url || url.startsWith("-") || /[\s\x00-\x1f]/.test(url) || url.includes("::")) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  if (scheme) {
    if (!["https", "http", "ssh", "git"].includes(scheme[1].toLowerCase())) return null;
    const [authority, ...path] = scheme[2].split("/");
    const host = authority.split("@").pop() ?? "";
    if (!host || host.startsWith("-") || !path.join("/")) return null;
    return url;
  }
  const scp = /^([^/:]+):(.+)$/.exec(url);
  if (scp && scp[1].length > 1 && !scp[1].startsWith("-") && !scp[2].startsWith("-")) return url;
  return null;
}

/** "https://github.com/octocat/Hello-World.git" → "Hello-World". */
export function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = last.replace(/\.git$/, "");
  return name && name !== "." && name !== ".." ? name : "repository";
}
