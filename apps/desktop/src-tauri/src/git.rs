//! Git, the way VS Code's built-in Git extension does it: the system `git`
//! binary, run with explicit arguments (never through a shell) in the open
//! workspace, with machine-readable output parsed here.
//!
//! - Every run has `GIT_TERMINAL_PROMPT=0` (no hidden prompt can hang it),
//!   `LC_ALL=C` (parseable messages) and literal pathspecs, plus a timeout.
//! - Paths from the UI are workspace-relative and checked like the file system's.
//! - Network operations (clone, pull, push, fetch) stream git's `--progress`
//!   lines and can be cancelled. HTTPS remotes on github.com use the GitHub
//!   token from the OS keychain (see `github.rs`) through `GIT_ASKPASS` =
//!   this binary (`askpass.rs`); the token only ever lives in that one child's
//!   environment. Otherwise the user's own credential helpers apply.
//! - Every command line goes to the workbench's "Git" output channel, redacted.
//! - Exam folders never get git.

use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State};

const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// More changes than this and the list stops (VS Code warns at 5000 too).
const MAX_ENTRIES: usize = 5000;
const MAX_SHOW_BYTES: usize = 5 * 1024 * 1024;
const MAX_STDOUT: usize = 64 * 1024 * 1024;
const MAX_STDERR: usize = 64 * 1024;

// ───────────────────────────── locating git ─────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct GitInfo {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
}

/// Where git usually lives when a GUI app's PATH is minimal (macOS apps start with /usr/bin:/bin).
fn candidates() -> Vec<PathBuf> {
    let exe = if cfg!(windows) { "git.exe" } else { "git" };
    let mut out: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join(exe)).collect())
        .unwrap_or_default();
    let extra: &[&str] = if cfg!(windows) {
        &[r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files (x86)\Git\cmd\git.exe"]
    } else {
        &["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git", "/opt/local/bin/git"]
    };
    out.extend(extra.iter().map(PathBuf::from));
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            out.push(PathBuf::from(local).join(r"Programs\Git\cmd\git.exe"));
        }
    }
    out
}

/// macOS ships /usr/bin/git as a stub that pops an "install developer tools"
/// dialog when the Command Line Tools are missing; never run it then.
fn usable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    if cfg!(target_os = "macos") && path == Path::new("/usr/bin/git") {
        return Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    true
}

fn detect() -> GitInfo {
    for path in candidates() {
        if !usable(&path) {
            continue;
        }
        let mut cmd = Command::new(&path);
        cmd.arg("--version").stdin(Stdio::null());
        no_window(&mut cmd);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                return GitInfo { installed: true, version: parse_version(&text), path: Some(path.display().to_string()) };
            }
        }
    }
    GitInfo { installed: false, version: None, path: None }
}

/// "git version 2.50.1 (Apple Git-155)" → "2.50.1".
pub fn parse_version(text: &str) -> Option<String> {
    text.trim().strip_prefix("git version ").map(|v| v.split_whitespace().next().unwrap_or(v).to_string())
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

// ───────────────────────────── state ─────────────────────────────

#[derive(Default)]
pub struct Git {
    info: Mutex<Option<GitInfo>>,
    /// Running network operations by the workbench's task id, for Cancel.
    tasks: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    /// The folder last chosen in "Select as Repository Destination"; clones go only there.
    clone_parent: Mutex<Option<PathBuf>>,
}

impl Git {
    /// Task Mentor projects clone into TMCode's own folder (`~/TMCode Projects`), not a picked one.
    pub fn set_clone_parent(&self, parent: PathBuf) {
        *self.clone_parent.lock().unwrap() = Some(parent);
    }

    fn info(&self, refresh: bool) -> GitInfo {
        let mut guard = self.info.lock().unwrap();
        if refresh || guard.is_none() {
            *guard = Some(detect());
        }
        guard.clone().unwrap()
    }

    fn exe(&self) -> Result<PathBuf, String> {
        self.info(false)
            .path
            .map(PathBuf::from)
            .ok_or_else(|| "Git not found. Install it or configure it using the 'git.path' setting.".to_string())
    }
}

// ───────────────────────────── running git ─────────────────────────────

/// A credential for one HTTPS remote: answered by `askpass.rs` in a child of git.
pub struct Askpass {
    pub username: String,
    pub token: String,
}

pub struct Invocation<'a> {
    pub args: Vec<String>,
    pub cwd: &'a Path,
    pub stdin: Option<Vec<u8>>,
    pub timeout: Duration,
    pub askpass: Option<Askpass>,
    pub cancel: Option<Arc<AtomicBool>>,
    /// Receives every stderr line as it arrives (progress, split on \r and \n).
    pub on_stderr_line: Option<&'a (dyn Fn(&str) + Sync)>,
}

impl<'a> Invocation<'a> {
    pub fn new(cwd: &'a Path, args: &[&str]) -> Self {
        Invocation {
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd,
            stdin: None,
            timeout: LOCAL_TIMEOUT,
            askpass: None,
            cancel: None,
            on_stderr_line: None,
        }
    }
}

#[derive(Debug)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Arguments every invocation starts with: no external diff/pager/colour
/// surprises, and the `ext::` transport (runs arbitrary commands) is off.
pub fn base_args() -> Vec<String> {
    ["-c", "core.quotepath=false", "-c", "color.ui=false", "-c", "protocol.ext.allow=never"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Removes anything secret from a line before it is logged: URL user-info and GitHub tokens.
pub fn redact(line: &str, secret: Option<&str>) -> String {
    let mut s = line.to_string();
    if let Some(t) = secret.filter(|t| !t.is_empty()) {
        s = s.replace(t, "***");
    }
    // scheme://user:pass@host → scheme://***@host
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"').unwrap_or(tail.len());
        match tail[..end].rfind('@') {
            Some(at) => {
                out.push_str("***");
                out.push_str(&tail[at..end]);
            }
            None => out.push_str(&tail[..end]),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    // Token shapes GitHub issues (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_).
    let mut result = String::with_capacity(out.len());
    let bytes = out.as_bytes();
    let mut i = 0;
    while i < out.len() {
        let tail = &out[i..];
        let prefix = ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"].iter().find(|p| tail.starts_with(**p));
        let boundary = i == 0 || !(bytes[i - 1] as char).is_ascii_alphanumeric();
        if let (Some(p), true) = (prefix, boundary) {
            let len = tail[p.len()..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(tail.len() - p.len());
            if len >= 8 {
                result.push_str(p);
                result.push_str("***");
                i += p.len() + len;
                continue;
            }
        }
        let ch = tail.chars().next().unwrap();
        result.push(ch);
        i += ch.len_utf8();
    }
    result
}

/// Splits a chunk of stderr into lines on \r and \n, keeping a partial tail.
pub fn split_progress(buf: &mut String, chunk: &str) -> Vec<String> {
    buf.push_str(chunk);
    let mut lines = Vec::new();
    while let Some(i) = buf.find(['\r', '\n']) {
        let line: String = buf.drain(..=i).collect();
        let line = line.trim_end_matches(['\r', '\n']).to_string();
        if !line.trim().is_empty() {
            lines.push(line);
        }
    }
    lines
}

pub fn run(exe: &Path, inv: Invocation, log: &(dyn Fn(String) + Sync)) -> Result<Output, String> {
    let mut args = base_args();
    if inv.askpass.is_some() {
        // Only our askpass answers for this run: nothing is offered to (or stored by) other helpers.
        args.extend(["-c".into(), "credential.helper=".into()]);
    }
    args.extend(inv.args.iter().cloned());
    let secret = inv.askpass.as_ref().map(|a| a.token.clone());
    let display = format!("> git {}", inv.args.iter().map(|a| shown_arg(a)).collect::<Vec<_>>().join(" "));
    log(redact(&display, secret.as_deref()));
    let started = Instant::now();

    let mut cmd = Command::new(exe);
    cmd.args(&args)
        .current_dir(inv.cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS")
        .env_remove("TMCODE_ASKPASS")
        .env_remove("TMCODE_GIT_TOKEN")
        .env_remove("TMCODE_GIT_USER")
        .stdin(if inv.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(a) = &inv.askpass {
        let me = std::env::current_exe().map_err(|e| e.to_string())?;
        cmd.env("GIT_ASKPASS", me)
            .env("TMCODE_ASKPASS", "1")
            .env("TMCODE_GIT_USER", &a.username)
            .env("TMCODE_GIT_TOKEN", &a.token);
    }
    no_window(&mut cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start git: {e}"))?;
    if let (Some(data), Some(mut stdin)) = (inv.stdin, child.stdin.take()) {
        let _ = stdin.write_all(&data);
    }
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let on_line = inv.on_stderr_line;

    let (out_bytes, err_text) = std::thread::scope(|s| {
        let out_h = s.spawn(move || {
            let mut out = Vec::new();
            let mut chunk = [0u8; 64 * 1024];
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) if out.len() < MAX_STDOUT => out.extend_from_slice(&chunk[..n]),
                    Ok(_) => {}
                }
            }
            out
        });
        let err_h = s.spawn(move || {
            let mut kept = String::new();
            let mut pending = String::new();
            let mut chunk = [0u8; 8192];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&chunk[..n]).into_owned();
                        if let Some(cb) = on_line {
                            for line in split_progress(&mut pending, &text) {
                                cb(&line);
                            }
                        }
                        kept.push_str(&text);
                        if kept.len() > MAX_STDERR * 2 {
                            let cut = kept.len() - MAX_STDERR;
                            let cut = (cut..kept.len()).find(|i| kept.is_char_boundary(*i)).unwrap_or(cut);
                            kept.drain(..cut);
                        }
                    }
                }
            }
            if let Some(cb) = on_line {
                if !pending.trim().is_empty() {
                    cb(pending.trim_end());
                }
            }
            kept
        });

        // Wait with a deadline, honouring Cancel.
        let mut killed = None;
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break Some(st),
                Ok(None) => {}
                Err(_) => break None,
            }
            let cancelled = inv.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst));
            if cancelled || started.elapsed() > inv.timeout {
                killed = Some(if cancelled { "cancelled" } else { "timed out" });
                kill_tree(&mut child);
                break child.wait().ok();
            }
            std::thread::sleep(Duration::from_millis(15));
        };
        let out = out_h.join().unwrap_or_default();
        let err = err_h.join().unwrap_or_default();
        (out, (status.and_then(|s| s.code()), err, killed))
    });
    let (code, stderr_text, killed) = err_text;
    let ms = started.elapsed().as_millis();
    if let Some(reason) = killed {
        log(format!("git {reason} after {ms} ms"));
        return Err(if reason == "cancelled" { "Cancelled".into() } else { format!("Git {reason}.") });
    }
    // The final state of each progress line, for the log and error messages.
    let mut finals = String::new();
    for line in stderr_text.split('\n') {
        let last = line.rsplit('\r').find(|p| !p.trim().is_empty()).unwrap_or("");
        if !last.trim().is_empty() {
            finals.push_str(last.trim_end());
            finals.push('\n');
        }
    }
    let finals = redact(&finals, secret.as_deref());
    if code != Some(0) {
        for line in finals.lines() {
            log(line.to_string());
        }
    }
    log(format!("{ms} ms{}", if code == Some(0) { String::new() } else { format!(" (exit code {})", code.map(|c| c.to_string()).unwrap_or("?".into())) }));
    Ok(Output { code, stdout: out_bytes, stderr: finals })
}

/// Long commit messages and stdin markers are shortened in the log.
fn shown_arg(a: &str) -> String {
    if a.contains(char::is_whitespace) {
        let short: String = a.chars().take(60).collect();
        format!("\"{}{}\"", short.replace('"', "\\\""), if a.chars().count() > 60 { "…" } else { "" })
    } else {
        a.to_string()
    }
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    let _ = child.kill();
}

/// A run that must succeed; the error is git's own message (classified by the workbench).
fn ok(out: Output) -> Result<Output, String> {
    if out.code == Some(0) {
        Ok(out)
    } else {
        let msg = out.stderr.trim();
        Err(if msg.is_empty() { format!("Git failed with exit code {}.", out.code.unwrap_or(-1)) } else { msg.to_string() })
    }
}

fn text(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

// ───────────────────────────── validation ─────────────────────────────

/// A workspace-relative path for a pathspec: no absolute paths, no `..`, no option look-alikes.
pub fn check_rel_path(p: &str) -> Result<(), String> {
    if p.is_empty() || p.contains('\0') || p.starts_with('-') {
        return Err(format!("'{p}' is not a valid path."));
    }
    for c in Path::new(p).components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("'{p}' is not a path inside the workspace.")),
        }
    }
    Ok(())
}

/// Branch / remote names as git accepts them, and never an option.
pub fn check_ref_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("@{")
        || name.contains("//")
        || name == "@"
        || name.chars().any(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(c));
    if bad {
        Err(format!("'{name}' is not a valid branch name."))
    } else {
        Ok(())
    }
}

/// Clone URLs: https/http/ssh/git URLs or scp-like `git@host:owner/repo`; never
/// an option, a local path or a remote-helper transport (`ext::`, `fd::`).
pub fn check_clone_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    let invalid = || Err(format!("'{url}' is not a valid repository URL."));
    if url.is_empty() || url.starts_with('-') || url.chars().any(|c| c.is_control() || c.is_whitespace()) || url.contains("::") {
        return invalid();
    }
    if let Some((scheme, rest)) = url.split_once("://") {
        if !["https", "http", "ssh", "git"].contains(&scheme.to_ascii_lowercase().as_str()) {
            return invalid();
        }
        let host = rest.split('/').next().unwrap_or("");
        let host = host.rsplit('@').next().unwrap_or("");
        if host.is_empty() || host.starts_with('-') || rest.split('/').nth(1).unwrap_or("").is_empty() {
            return invalid();
        }
        return Ok(());
    }
    // scp-like: [user@]host:path (a colon before any slash)
    match url.split_once(':') {
        Some((host, path)) if !host.is_empty() && !host.contains('/') && !host.starts_with('-') && !path.is_empty() && !path.starts_with('-') => {
            // "C:\…" style drive letters are local paths, not hosts.
            if host.len() == 1 {
                return invalid();
            }
            Ok(())
        }
        _ => invalid(),
    }
}

/// "https://github.com/octocat/Hello-World.git" → "Hello-World".
pub fn repo_name(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next().unwrap_or("repository");
    let name = last.strip_suffix(".git").unwrap_or(last);
    let clean: String = name.chars().filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\')).collect();
    if clean.is_empty() || clean == "." || clean == ".." {
        "repository".into()
    } else {
        clean
    }
}

/// The host of an HTTPS remote URL, for deciding whether the GitHub token applies.
pub fn https_host(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://")?;
    let authority = rest.split('/').next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    Some(host.to_ascii_lowercase())
}

// ───────────────────────────── status parsing ─────────────────────────────

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Entry {
    /// Repository-relative ("/"-separated); the workbench strips `prefix`.
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    /// Index (X) and worktree (Y) status letters; "." = unchanged.
    pub x: String,
    pub y: String,
    /// "changed" | "renamed" | "copied" | "unmerged" | "untracked" | "ignored"
    pub kind: &'static str,
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Parsed {
    /// None when HEAD is detached.
    pub branch: Option<String>,
    /// None on an unborn branch (no commits yet).
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

/// Parses `git status --porcelain=v2 -z --branch`.
pub fn parse_status(raw: &[u8]) -> Parsed {
    let text = String::from_utf8_lossy(raw);
    let mut fields = text.split('\0');
    let mut p = Parsed::default();
    while let Some(rec) = fields.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("# ") {
            let (key, val) = h.split_once(' ').unwrap_or((h, ""));
            match key {
                "branch.oid" => p.oid = (val != "(initial)").then(|| val.to_string()),
                "branch.head" => p.branch = (val != "(detached)").then(|| val.to_string()),
                "branch.upstream" => p.upstream = Some(val.to_string()),
                "branch.ab" => {
                    for part in val.split_whitespace() {
                        if let Some(a) = part.strip_prefix('+') {
                            p.ahead = a.parse().unwrap_or(0);
                        } else if let Some(b) = part.strip_prefix('-') {
                            p.behind = b.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if p.entries.len() >= MAX_ENTRIES {
            p.truncated = true;
            break;
        }
        let kind = rec.as_bytes()[0];
        match kind {
            b'1' => {
                // 1 XY sub mH mI mW hH hI path
                let parts: Vec<&str> = rec.splitn(9, ' ').collect();
                if parts.len() == 9 {
                    p.entries.push(entry(parts[1], parts[8], None, "changed"));
                }
            }
            b'2' => {
                // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
                let parts: Vec<&str> = rec.splitn(10, ' ').collect();
                let orig = fields.next().map(|s| s.to_string());
                if parts.len() == 10 {
                    let k = if parts[8].starts_with('C') { "copied" } else { "renamed" };
                    p.entries.push(entry(parts[1], parts[9], orig, k));
                }
            }
            b'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let parts: Vec<&str> = rec.splitn(11, ' ').collect();
                if parts.len() == 11 {
                    p.entries.push(entry(parts[1], parts[10], None, "unmerged"));
                }
            }
            b'?' => p.entries.push(Entry { path: rec[2..].to_string(), orig_path: None, x: "?".into(), y: "?".into(), kind: "untracked" }),
            b'!' => p.entries.push(Entry { path: rec[2..].to_string(), orig_path: None, x: "!".into(), y: "!".into(), kind: "ignored" }),
            _ => {}
        }
    }
    p
}

fn entry(xy: &str, path: &str, orig: Option<String>, kind: &'static str) -> Entry {
    let mut c = xy.chars();
    Entry {
        path: path.to_string(),
        orig_path: orig,
        x: c.next().unwrap_or('.').to_string(),
        y: c.next().unwrap_or('.').to_string(),
        kind,
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Branch {
    pub name: String,
    /// "local" | "remote"
    pub kind: &'static str,
    pub current: bool,
    pub commit: String,
    pub upstream: Option<String>,
    pub subject: String,
    pub date: i64,
}

pub const BRANCH_FORMAT: &str = "%(HEAD)%00%(refname)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(committerdate:unix)%00%(contents:subject)";

pub fn parse_branches(text: &str) -> Vec<Branch> {
    text.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            if f.len() < 7 {
                return None;
            }
            let remote = f[1].starts_with("refs/remotes/");
            if remote && f[1].ends_with("/HEAD") {
                return None;
            }
            Some(Branch {
                name: f[2].to_string(),
                kind: if remote { "remote" } else { "local" },
                current: f[0] == "*",
                commit: f[3].to_string(),
                upstream: (!f[4].is_empty()).then(|| f[4].to_string()),
                date: f[5].parse().unwrap_or(0),
                subject: f[6].to_string(),
            })
        })
        .collect()
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub email: String,
    pub date: i64,
    pub refs: String,
    pub subject: String,
}

pub const LOG_FORMAT: &str = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";

pub fn parse_log(text: &str) -> Vec<Commit> {
    text.split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            if f.len() < 7 {
                return None;
            }
            Some(Commit {
                hash: f[0].into(),
                short: f[1].into(),
                author: f[2].into(),
                email: f[3].into(),
                date: f[4].parse().unwrap_or(0),
                refs: f[5].into(),
                subject: f[6].into(),
            })
        })
        .collect()
}

// ───────────────────────────── commands ─────────────────────────────

fn emit_log(app: &AppHandle) -> impl Fn(String) + Sync + '_ {
    move |line: String| {
        log::info!("git: {line}");
        let _ = app.emit_to(EventTarget::webview(crate::WORKBENCH), "git-log", line);
    }
}

/// Git works in practice folders only; exam folders (app data/exams) never get it.
fn workspace_root(app: &AppHandle, ws: &Workspace) -> Result<PathBuf, String> {
    let root = ws.root()?;
    if let Ok(data) = app.path().app_data_dir() {
        let exams = dunce::canonicalize(data.join("exams")).unwrap_or(data.join("exams"));
        if root.starts_with(&exams) {
            return Err("Git is not available during exams.".into());
        }
    }
    Ok(root)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_info(app: AppHandle, refresh: bool) -> Result<GitInfo, String> {
    blocking(move || Ok(app.state::<Git>().info(refresh))).await
}

#[derive(Serialize)]
pub struct Status {
    #[serde(flatten)]
    parsed: Parsed,
    /// Absolute repository root, and the workspace's path inside it ("" or "sub/dir/").
    root: String,
    prefix: String,
    remotes: Vec<String>,
    /// A merge is in progress (MERGE_HEAD exists).
    merging: bool,
}

/// Repository status, or None when the workspace is not inside a repository.
#[tauri::command]
pub async fn git_status(app: AppHandle) -> Result<Option<Status>, String> {
    blocking(move || {
        let git = app.state::<Git>();
        let exe = git.exe()?;
        let root = workspace_root(&app, &app.state::<Workspace>())?;
        let log = emit_log(&app);
        let top = run(&exe, Invocation::new(&root, &["rev-parse", "--show-toplevel", "--show-prefix", "--git-path", "MERGE_HEAD"]), &log)?;
        if top.code != Some(0) {
            return Ok(None);
        }
        let t = text(&top);
        let mut lines = t.lines();
        let repo_root = lines.next().unwrap_or_default().to_string();
        let prefix = lines.next().unwrap_or_default().to_string();
        let merge_head = lines.next().unwrap_or_default();
        let merging = !merge_head.is_empty() && root.join(merge_head).exists();
        let out = ok(run(
            &exe,
            Invocation::new(&root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", "."]),
            &log,
        )?)?;
        let mut parsed = parse_status(&out.stdout);
        if !prefix.is_empty() {
            parsed.entries.retain(|e| e.path.starts_with(&prefix));
            for e in parsed.entries.iter_mut() {
                e.path = e.path[prefix.len()..].to_string();
                if let Some(o) = e.orig_path.as_mut() {
                    if let Some(s) = o.strip_prefix(&prefix) {
                        *o = s.to_string();
                    }
                }
            }
        }
        let remotes = run(&exe, Invocation::new(&root, &["remote"]), &|_| {})
            .map(|o| text(&o).lines().map(str::to_string).collect())
            .unwrap_or_default();
        Ok(Some(Status { parsed, root: repo_root, prefix, remotes, merging }))
    })
    .await
}

/// A file's content at HEAD ("HEAD") or in the index ("index"); None when it doesn't exist there.
#[tauri::command]
pub async fn git_show(app: AppHandle, path: String, rev: String) -> Result<Option<String>, String> {
    blocking(move || {
        check_rel_path(&path)?;
        let spec = match rev.as_str() {
            "HEAD" => format!("HEAD:./{path}"),
            "index" => format!(":./{path}"),
            // A commit from the Timeline: only a hash, never an arbitrary revision expression.
            r if is_commit_hash(r) => format!("{r}:./{path}"),
            _ => return Err("Unknown revision.".into()),
        };
        let git = app.state::<Git>();
        let exe = git.exe()?;
        let root = workspace_root(&app, &app.state::<Workspace>())?;
        // Quiet: the gutter asks often; only failures matter and those are "not there".
        let out = run(&exe, Invocation::new(&root, &["show", &spec]), &|_| {})?;
        if out.code != Some(0) {
            return Ok(None);
        }
        if out.stdout.len() > MAX_SHOW_BYTES || out.stdout.iter().take(8000).any(|b| *b == 0) {
            return Err("binary".into());
        }
        Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
    })
    .await
}

/// 7 to 40 lowercase hex digits: a commit hash (short or full).
pub fn is_commit_hash(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The file mode from `git ls-files -s` ("100755 <sha> 0\tpath"); a new file is a regular one.
pub fn stage_mode(ls_files: &str) -> String {
    ls_files
        .split_whitespace()
        .next()
        .filter(|m| *m == "100644" || *m == "100755" || *m == "120000")
        .unwrap_or("100644")
        .to_string()
}

/// The commits that changed one file, newest first (the Timeline).
#[tauri::command]
pub async fn git_file_log(app: AppHandle, path: String, limit: u32) -> Result<Vec<Commit>, String> {
    blocking(move || {
        check_rel_path(&path)?;
        if local(&app, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
            return Ok(Vec::new());
        }
        let n = format!("-n{}", limit.clamp(1, 200));
        let format = format!("--format={LOG_FORMAT}");
        let out = local(&app, &["log", &n, &format, "--follow", "--", &path])?;
        Ok(parse_log(&text(&out)))
    })
    .await
}

/// Stage Change for one hunk: `content` becomes the file's staged version
/// (hash-object + update-index), leaving the working tree alone.
#[tauri::command]
pub async fn git_stage_content(app: AppHandle, path: String, content: String) -> Result<(), String> {
    blocking(move || {
        check_rel_path(&path)?;
        let git = app.state::<Git>();
        let exe = git.exe()?;
        let root = workspace_root(&app, &app.state::<Workspace>())?;
        let log = emit_log(&app);
        let mut inv = Invocation::new(&root, &["hash-object", "-w", "--stdin", "--path", &path]);
        inv.stdin = Some(content.into_bytes());
        let sha = text(&ok(run(&exe, inv, &log)?)?).trim().to_string();
        if !is_commit_hash(&sha) {
            return Err("git did not store the change.".into());
        }
        let mode = stage_mode(&text(&ok(run(&exe, Invocation::new(&root, &["ls-files", "-s", "--", &path]), &log)?)?));
        // --cacheinfo paths are from the top of the repository: run there with the full path.
        let top = ok(run(&exe, Invocation::new(&root, &["rev-parse", "--show-toplevel", "--show-prefix"]), &log)?)?;
        let t = text(&top);
        let mut lines = t.lines();
        let top_dir = PathBuf::from(lines.next().unwrap_or_default());
        let prefix = lines.next().unwrap_or_default().to_string();
        let info = format!("{mode},{sha},{prefix}{path}");
        ok(run(&exe, Invocation::new(&top_dir, &["update-index", "--add", "--cacheinfo", &info]), &log)?)?;
        Ok(())
    })
    .await
}

fn with_paths<'a>(mut args: Vec<&'a str>, paths: &'a [String]) -> Result<Vec<&'a str>, String> {
    for p in paths {
        check_rel_path(p)?;
    }
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    Ok(args)
}

fn local(app: &AppHandle, args: &[&str]) -> Result<Output, String> {
    let git = app.state::<Git>();
    let exe = git.exe()?;
    let root = workspace_root(app, &app.state::<Workspace>())?;
    ok(run(&exe, Invocation::new(&root, args), &emit_log(app))?)
}

#[tauri::command]
pub async fn git_stage(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let args = with_paths(vec!["add", "-A"], &paths)?;
        local(&app, &args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        // `restore --staged` needs a HEAD; on an unborn branch, unstaging = removing from the index.
        let born = local(&app, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
        let args = if born {
            with_paths(vec!["restore", "--staged"], &paths)?
        } else {
            with_paths(vec!["rm", "--cached", "-r", "-q"], &paths)?
        };
        local(&app, &args).map(|_| ())
    })
    .await
}

/// Discards working-tree changes: tracked files go back to the index version,
/// untracked ones are deleted (the UI asks first).
#[tauri::command]
pub async fn git_discard(app: AppHandle, tracked: Vec<String>, untracked: Vec<String>) -> Result<(), String> {
    blocking(move || {
        if !tracked.is_empty() {
            local(&app, &with_paths(vec!["restore", "--worktree"], &tracked)?)?;
        }
        if !untracked.is_empty() {
            local(&app, &with_paths(vec!["clean", "-f", "-q"], &untracked)?)?;
        }
        Ok(())
    })
    .await
}

#[derive(Deserialize)]
pub struct CommitOptions {
    message: String,
    #[serde(default)]
    amend: bool,
    #[serde(default)]
    signoff: bool,
    /// Stage everything (including untracked files) first, like "Commit All".
    #[serde(default)]
    all: bool,
}

#[tauri::command]
pub async fn git_commit(app: AppHandle, options: CommitOptions) -> Result<(), String> {
    blocking(move || {
        if options.all {
            local(&app, &["add", "-A", "--", "."])?;
        }
        let git = app.state::<Git>();
        let exe = git.exe()?;
        let root = workspace_root(&app, &app.state::<Workspace>())?;
        let mut args = vec!["commit", "--quiet", "--cleanup=strip"];
        if options.amend {
            args.push("--amend");
        }
        if options.signoff {
            args.push("--signoff");
        }
        if options.amend && options.message.trim().is_empty() {
            args.push("--no-edit");
        } else {
            if options.message.trim().is_empty() {
                return Err("Please provide a commit message.".into());
            }
            args.extend(["-F", "-"]);
        }
        let mut inv = Invocation::new(&root, &args);
        if !(options.amend && options.message.trim().is_empty()) {
            inv.stdin = Some(options.message.into_bytes());
        }
        ok(run(&exe, inv, &emit_log(&app))?).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_branches(app: AppHandle) -> Result<Vec<Branch>, String> {
    blocking(move || {
        let format = format!("--format={BRANCH_FORMAT}");
        let out = local(&app, &["for-each-ref", "--sort=-committerdate", &format, "refs/heads", "refs/remotes"])?;
        Ok(parse_branches(&text(&out)))
    })
    .await
}

/// Checks out `name`, or creates it (from `from`, default HEAD) when `create`.
/// A remote branch ("origin/feature") gets a local tracking branch, as in VS Code.
#[tauri::command]
pub async fn git_checkout(app: AppHandle, name: String, create: bool, from: Option<String>, remote: bool) -> Result<(), String> {
    blocking(move || {
        check_ref_name(&name)?;
        if let Some(f) = &from {
            check_ref_name(f)?;
        }
        if create {
            let mut args = vec!["checkout", "-q", "-b", name.as_str()];
            if let Some(f) = &from {
                args.push(f);
            }
            local(&app, &args).map(|_| ())
        } else if remote {
            local(&app, &["checkout", "-q", "--track", &name]).map(|_| ())
        } else {
            local(&app, &["checkout", "-q", &name, "--"]).map(|_| ())
        }
    })
    .await
}

#[tauri::command]
pub async fn git_log(app: AppHandle, limit: u32) -> Result<Vec<Commit>, String> {
    blocking(move || {
        if local(&app, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
            return Ok(Vec::new()); // no commits yet
        }
        let n = format!("-n{}", limit.clamp(1, 500));
        let format = format!("--format={LOG_FORMAT}");
        let out = local(&app, &["log", &n, &format])?;
        Ok(parse_log(&text(&out)))
    })
    .await
}

#[tauri::command]
pub async fn git_init(app: AppHandle) -> Result<(), String> {
    blocking(move || local(&app, &["init", "-q"]).map(|_| ())).await
}

/// "push" (with optional message) or "pop".
#[tauri::command]
pub async fn git_stash(app: AppHandle, action: String, message: Option<String>) -> Result<(), String> {
    blocking(move || match action.as_str() {
        "push" => {
            let mut args = vec!["stash", "push", "--include-untracked"];
            if let Some(m) = message.as_deref().filter(|m| !m.trim().is_empty()) {
                args.extend(["-m", m]);
            }
            local(&app, &args).map(|_| ())
        }
        "pop" => local(&app, &["stash", "pop"]).map(|_| ()),
        _ => Err("Unknown stash action.".into()),
    })
    .await
}

/// Which of `paths` git ignores (explorer dimming).
#[tauri::command]
pub async fn git_check_ignore(app: AppHandle, paths: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || {
        let paths: Vec<String> = paths.into_iter().filter(|p| check_rel_path(p).is_ok()).take(5000).collect();
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let git = app.state::<Git>();
        let exe = git.exe()?;
        let root = workspace_root(&app, &app.state::<Workspace>())?;
        let mut inv = Invocation::new(&root, &["check-ignore", "-z", "--stdin"]);
        let mut input = Vec::new();
        for p in &paths {
            input.extend_from_slice(p.as_bytes());
            input.push(0);
        }
        inv.stdin = Some(input);
        let out = run(&exe, inv, &|_| {})?;
        // Exit 1 = nothing ignored; 128 = not a repository.
        if out.code != Some(0) {
            return Ok(Vec::new());
        }
        Ok(text(&out).split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
    })
    .await
}

/// Sets the global user.name / user.email ("Please tell me who you are").
#[tauri::command]
pub async fn git_set_identity(app: AppHandle, name: String, email: String) -> Result<(), String> {
    blocking(move || {
        if name.trim().is_empty() || !email.contains('@') || name.contains('\n') || email.contains('\n') {
            return Err("Enter a name and an email address.".into());
        }
        local(&app, &["config", "--global", "user.name", name.trim()])?;
        local(&app, &["config", "--global", "user.email", email.trim()]).map(|_| ())
    })
    .await
}

// ── network: pull / push / fetch / sync / clone (streamed, cancellable) ──

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum GitEvent {
    /// A step starts ("Pulling…", "Pushing…").
    Step { name: String },
    /// One line of git's --progress output.
    Progress { line: String },
}

#[derive(Deserialize, Default)]
pub struct RemoteOptions {
    remote: Option<String>,
    branch: Option<String>,
    /// First push of a branch: `push -u <remote> <branch>`.
    #[serde(default)]
    set_upstream: bool,
}

struct TaskGuard<'a>(&'a Git, u32);
impl Drop for TaskGuard<'_> {
    fn drop(&mut self) {
        self.0.tasks.lock().unwrap().remove(&self.1);
    }
}

fn register_task(git: &Git, task: u32) -> (Arc<AtomicBool>, TaskGuard<'_>) {
    let flag = Arc::new(AtomicBool::new(false));
    git.tasks.lock().unwrap().insert(task, flag.clone());
    (flag, TaskGuard(git, task))
}

/// The GitHub credential for `url` when it is an HTTPS github.com remote and the user signed in.
fn askpass_for(app: &AppHandle, url: &str) -> Option<Askpass> {
    if https_host(url).as_deref() != Some("github.com") {
        return None;
    }
    crate::github::stored_token(app).map(|token| Askpass { username: "x-access-token".into(), token })
}

fn remote_url(exe: &Path, root: &Path, remote: &str) -> Option<String> {
    let out = run(exe, Invocation::new(root, &["remote", "get-url", "--", remote]), &|_| {}).ok()?;
    (out.code == Some(0)).then(|| text(&out).trim().to_string())
}

/// The remote of the current branch's upstream, else "origin", else the only remote.
fn default_remote(exe: &Path, root: &Path) -> Option<String> {
    let up = run(exe, Invocation::new(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]), &|_| {}).ok();
    if let Some(up) = up.filter(|o| o.code == Some(0)) {
        if let Some((remote, _)) = text(&up).trim().split_once('/') {
            return Some(remote.to_string());
        }
    }
    let remotes = run(exe, Invocation::new(root, &["remote"]), &|_| {}).ok()?;
    let list: Vec<String> = text(&remotes).lines().map(str::to_string).collect();
    if list.iter().any(|r| r == "origin") {
        Some("origin".into())
    } else {
        list.into_iter().next()
    }
}

#[tauri::command]
pub async fn git_remote(app: AppHandle, op: String, options: Option<RemoteOptions>, task: u32, on_event: Channel<GitEvent>) -> Result<(), String> {
    blocking(move || {
        let options = options.unwrap_or_default();
        let git = app.state::<Git>();
        let exe = git.exe()?;
        let root = workspace_root(&app, &app.state::<Workspace>())?;
        let log = emit_log(&app);
        let (cancel, _guard) = register_task(&git, task);
        let remote = match options.remote.clone() {
            Some(r) => {
                check_ref_name(&r)?;
                r
            }
            None => default_remote(&exe, &root).ok_or("No remote repository is configured. Publish the branch or add a remote first.")?,
        };
        let url = remote_url(&exe, &root, &remote).unwrap_or_default();
        let progress = |line: &str| {
            let _ = on_event.send(GitEvent::Progress { line: redact(line, None) });
        };
        let step = |args: Vec<String>, name: &str| -> Result<(), String> {
            let _ = on_event.send(GitEvent::Step { name: name.into() });
            let mut inv = Invocation::new(&root, &[]);
            inv.args = args;
            inv.timeout = NETWORK_TIMEOUT;
            inv.cancel = Some(cancel.clone());
            inv.askpass = askpass_for(&app, &url);
            inv.on_stderr_line = Some(&progress);
            ok(run(&exe, inv, &log)?).map(|_| ())
        };
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let pull = || {
            // Merge unless the user configured pull.rebase (git ≥ 2.27 refuses to guess).
            let configured = run(&exe, Invocation::new(&root, &["config", "--get", "pull.rebase"]), &|_| {}).map(|o| o.code == Some(0)).unwrap_or(false);
            let mut args = s(&["pull", "--progress"]);
            if !configured {
                args.push("--no-rebase".into());
            }
            step(args, "Pulling")
        };
        let push = || {
            let mut args = s(&["push", "--progress"]);
            if options.set_upstream {
                let branch = options.branch.clone().ok_or("No branch to publish.")?;
                check_ref_name(&branch)?;
                args.extend(["-u".into(), remote.clone(), branch]);
            }
            step(args, "Pushing")
        };
        match op.as_str() {
            "fetch" => step(s(&["fetch", "--progress", "--prune", "--", &remote]), "Fetching"),
            "pull" => pull(),
            "push" => push(),
            "sync" => {
                pull()?;
                push()
            }
            _ => Err("Unknown operation.".into()),
        }
    })
    .await
}

#[tauri::command]
pub fn git_cancel(git: State<'_, Git>, task: u32) {
    if let Some(flag) = git.tasks.lock().unwrap().get(&task) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// "Select as Repository Destination": a folder picker; the clone may only go there.
#[tauri::command]
pub async fn git_pick_clone_parent(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // Debug builds: the self-test can't click a dialog.
    let dev = if cfg!(debug_assertions) { std::env::var("TMCODE_DEV_CLONE_PARENT").ok() } else { None };
    let picked = match dev {
        Some(p) => Some(PathBuf::from(p)),
        None => app
            .dialog()
            .file()
            .set_title("Select as Repository Destination")
            .blocking_pick_folder()
            .map(|f| f.into_path().map_err(|e| e.to_string()))
            .transpose()?,
    };
    let Some(parent) = picked else { return Ok(None) };
    let parent = dunce::canonicalize(&parent).map_err(|e| e.to_string())?;
    *app.state::<Git>().clone_parent.lock().unwrap() = Some(parent.clone());
    Ok(Some(parent.display().to_string()))
}

/// A folder name under `parent` that doesn't exist yet: "repo", "repo-1", …
pub fn free_dest(parent: &Path, name: &str) -> PathBuf {
    let first = parent.join(name);
    if !first.exists() {
        return first;
    }
    (1..1000).map(|i| parent.join(format!("{name}-{i}"))).find(|p| !p.exists()).unwrap_or(first)
}

/// Clones `url` into the picked parent folder and returns the new folder's absolute path.
#[tauri::command]
pub async fn git_clone(app: AppHandle, url: String, task: u32, on_event: Channel<GitEvent>) -> Result<String, String> {
    blocking(move || {
        let url = url.trim().to_string();
        check_clone_url(&url)?;
        let git = app.state::<Git>();
        let exe = git.exe()?;
        let parent = git.clone_parent.lock().unwrap().clone().ok_or("Choose a folder to clone into first.")?;
        let dest = free_dest(&parent, &repo_name(&url));
        let (cancel, _guard) = register_task(&git, task);
        let progress = |line: &str| {
            let _ = on_event.send(GitEvent::Progress { line: redact(line, None) });
        };
        let _ = on_event.send(GitEvent::Step { name: "Cloning".into() });
        let dest_s = dest.display().to_string();
        let mut inv = Invocation::new(&parent, &["clone", "--progress", "--", &url, &dest_s]);
        inv.timeout = NETWORK_TIMEOUT;
        inv.cancel = Some(cancel);
        inv.askpass = askpass_for(&app, &url);
        inv.on_stderr_line = Some(&progress);
        let result = run(&exe, inv, &emit_log(&app)).and_then(ok);
        if result.is_err() && dest.exists() {
            // Cancelled or failed half-way: the folder is ours (it didn't exist before).
            let _ = std::fs::remove_dir_all(&dest);
        }
        result.map(|_| dest_s)
    })
    .await
}

/// Help and token pages only: github.com, docs.github.com, git-scm.com.
pub fn allowed_help_url(url: &str) -> bool {
    https_host(url).is_some_and(|h| ["github.com", "docs.github.com", "git-scm.com"].contains(&h.as_str())) && !url.contains('@')
}

#[tauri::command]
pub fn git_open_url(url: String) -> Result<(), String> {
    if !allowed_help_url(&url) {
        return Err("This link can't be opened.".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_hashes_only_for_timeline_revisions() {
        assert!(is_commit_hash("abc1234"));
        assert!(is_commit_hash(&"f".repeat(40)));
        assert!(!is_commit_hash("HEAD~1"));
        assert!(!is_commit_hash("abc"));
        assert!(!is_commit_hash("--output=x"));
        assert!(!is_commit_hash("ABCDEF1"));
    }

    #[test]
    fn stage_mode_keeps_executables_and_defaults_to_regular_files() {
        assert_eq!(stage_mode("100755 0123456789abcdef0123456789abcdef01234567 0\trun.sh\n"), "100755");
        assert_eq!(stage_mode(""), "100644");
        assert_eq!(stage_mode("160000 abc 0\tsub"), "100644");
    }

    #[test]
    fn parses_branch_headers_and_entries() {
        let raw = b"# branch.oid 1234abcd\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/app.ts\0\
1 A. N... 000000 100644 100644 000 ccc new file.txt\0\
1 MD N... 100644 100644 000000 aaa bbb both.py\0\
2 R. N... 100644 100644 100644 aaa aaa R100 renamed.md\0old name.md\0\
u UU N... 100644 100644 100644 100644 a b c conflict.c\0\
? untracked dir/notes.txt\0! build/out.o\0";
        let p = parse_status(raw);
        assert_eq!(p.branch.as_deref(), Some("main"));
        assert_eq!(p.oid.as_deref(), Some("1234abcd"));
        assert_eq!(p.upstream.as_deref(), Some("origin/main"));
        assert_eq!((p.ahead, p.behind), (2, 1));
        assert_eq!(p.entries.len(), 7);
        assert_eq!(p.entries[0], Entry { path: "src/app.ts".into(), orig_path: None, x: ".".into(), y: "M".into(), kind: "changed" });
        assert_eq!(p.entries[1].path, "new file.txt");
        assert_eq!((p.entries[1].x.as_str(), p.entries[1].y.as_str()), ("A", "."));
        assert_eq!((p.entries[2].x.as_str(), p.entries[2].y.as_str()), ("M", "D"));
        assert_eq!(p.entries[3].kind, "renamed");
        assert_eq!(p.entries[3].path, "renamed.md");
        assert_eq!(p.entries[3].orig_path.as_deref(), Some("old name.md"));
        assert_eq!(p.entries[4].kind, "unmerged");
        assert_eq!((p.entries[4].x.as_str(), p.entries[4].y.as_str()), ("U", "U"));
        assert_eq!(p.entries[5].kind, "untracked");
        assert_eq!(p.entries[5].path, "untracked dir/notes.txt");
        assert_eq!(p.entries[6].kind, "ignored");
    }

    #[test]
    fn parses_detached_head_unborn_branch_and_no_upstream() {
        let p = parse_status(b"# branch.oid 9f9f9f\0# branch.head (detached)\0");
        assert_eq!(p.branch, None);
        assert_eq!(p.oid.as_deref(), Some("9f9f9f"));
        assert_eq!(p.upstream, None);
        assert_eq!((p.ahead, p.behind), (0, 0));

        let p = parse_status(b"# branch.oid (initial)\0# branch.head main\0? a.txt\0");
        assert_eq!(p.oid, None);
        assert_eq!(p.branch.as_deref(), Some("main"));
        assert_eq!(p.entries.len(), 1);
    }

    #[test]
    fn copies_are_told_apart_from_renames() {
        let p = parse_status(b"2 C. N... 100644 100644 100644 a a C75 copy.txt\0orig.txt\0");
        assert_eq!(p.entries[0].kind, "copied");
        assert_eq!(p.entries[0].orig_path.as_deref(), Some("orig.txt"));
    }

    #[test]
    fn paths_must_stay_in_the_workspace() {
        assert!(check_rel_path("src/main.py").is_ok());
        assert!(check_rel_path("a b/c.txt").is_ok());
        for bad in ["", "../x", "a/../../x", "/etc/passwd", "-rf", "--force", "a\0b"] {
            assert!(check_rel_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn branch_names_are_validated() {
        for good in ["main", "feature/login", "fix-1.2", "origin/feature"] {
            assert!(check_ref_name(good).is_ok(), "{good}");
        }
        for bad in ["", "-b", "--orphan", "a..b", "a b", "x.lock", "a~1", "a:b", "@", "a/", "/a", "x@{y}"] {
            assert!(check_ref_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn clone_urls_are_validated() {
        for good in [
            "https://github.com/octocat/Hello-World.git",
            "https://github.com/octocat/Hello-World",
            "http://example.com/x/y",
            "ssh://git@github.com/owner/repo.git",
            "git@github.com:owner/repo.git",
            "git://example.com/repo",
        ] {
            assert!(check_clone_url(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "--upload-pack=touch /tmp/x",
            "ext::sh -c touch% /tmp/pwned",
            "fd::17",
            "file:///etc",
            "/local/path",
            "C:\\repos\\x",
            "https://",
            "https://github.com",
            "https://-oProxyCommand=x/y",
            "https://github.com/a b",
        ] {
            assert!(check_clone_url(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn repo_names_and_hosts_come_from_urls() {
        assert_eq!(repo_name("https://github.com/octocat/Hello-World.git"), "Hello-World");
        assert_eq!(repo_name("git@github.com:owner/repo.git"), "repo");
        assert_eq!(repo_name("https://example.com/group/sub/project/"), "project");
        assert_eq!(repo_name("https://example.com/.."), "repository");
        assert_eq!(https_host("https://github.com/a/b").as_deref(), Some("github.com"));
        assert_eq!(https_host("https://user@GitHub.com:443/a/b").as_deref(), Some("github.com"));
        assert_eq!(https_host("git@github.com:a/b"), None);
        assert_eq!(https_host("http://github.com/a/b"), None);
    }

    #[test]
    fn redacts_credentials_and_tokens() {
        assert_eq!(redact("> git clone https://user:secret@github.com/a/b.git x", None), "> git clone https://***@github.com/a/b.git x");
        assert_eq!(redact("token ghp_abcdefghijklmnop123 leaked", None), "token ghp_*** leaked");
        assert_eq!(redact("github_pat_11ABCDEFG_xyz123456789", None), "github_pat_***");
        assert_eq!(redact("the value s3cr3t-value here", Some("s3cr3t-value")), "the value *** here");
        assert_eq!(redact("https://github.com/a/b no creds", None), "https://github.com/a/b no creds");
        assert_eq!(redact("ghp_ short", None), "ghp_ short");
        assert_eq!(redact("Ünïcode ok", None), "Ünïcode ok");
    }

    #[test]
    fn progress_is_split_on_carriage_returns() {
        let mut buf = String::new();
        let lines = split_progress(&mut buf, "Receiving objects:  10% (1/10)\rReceiving objects:  20% (2/10)\rRecei");
        assert_eq!(lines, vec!["Receiving objects:  10% (1/10)", "Receiving objects:  20% (2/10)"]);
        let lines = split_progress(&mut buf, "ving objects: 100% (10/10), done.\n");
        assert_eq!(lines, vec!["Receiving objects: 100% (10/10), done."]);
        assert!(buf.is_empty());
    }

    #[test]
    fn parses_branches_and_log() {
        let b = parse_branches("*\0refs/heads/main\0main\0abc123\0origin/main\01700000000\0Initial commit\n \0refs/heads/dev\0dev\0def456\0\01700000001\0Work\n \0refs/remotes/origin/HEAD\0origin\0abc123\0\00\0x\n \0refs/remotes/origin/main\0origin/main\0abc123\0\01700000000\0Initial commit\n");
        assert_eq!(b.len(), 3);
        assert!(b[0].current && b[0].kind == "local" && b[0].upstream.as_deref() == Some("origin/main"));
        assert!(!b[1].current && b[1].upstream.is_none());
        assert_eq!(b[2].kind, "remote");
        assert_eq!(b[2].name, "origin/main");

        let l = parse_log("aaaa\x1fa\x1fAda\x1fada@x.org\x1f1700000000\x1fHEAD -> main\x1fFirst\x1e\nbbbb\x1fb\x1fBo\x1fbo@x.org\x1f1700000001\x1f\x1fSecond\x1e\n");
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].refs, "HEAD -> main");
        assert_eq!(l[1].subject, "Second");
    }

    #[test]
    fn only_help_pages_open_in_the_browser() {
        assert!(allowed_help_url("https://github.com/settings/tokens/new?scopes=repo&description=TMCode"));
        assert!(allowed_help_url("https://git-scm.com/downloads"));
        assert!(!allowed_help_url("http://github.com/x"));
        assert!(!allowed_help_url("https://evil.example/x"));
        assert!(!allowed_help_url("https://github.com@evil.example/x"));
        assert!(!allowed_help_url("file:///etc/passwd"));
    }

    #[test]
    fn version_is_parsed() {
        assert_eq!(parse_version("git version 2.50.1 (Apple Git-155)\n").as_deref(), Some("2.50.1"));
        assert_eq!(parse_version("git version 2.45.2.windows.1").as_deref(), Some("2.45.2.windows.1"));
        assert_eq!(parse_version("nope"), None);
    }

    #[test]
    fn free_destination_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(free_dest(dir.path(), "repo"), dir.path().join("repo"));
        std::fs::create_dir(dir.path().join("repo")).unwrap();
        assert_eq!(free_dest(dir.path(), "repo"), dir.path().join("repo-1"));
    }

    /// End to end against the real git binary (skipped where git is missing).
    #[test]
    fn real_git_round_trip() {
        let info = detect();
        let Some(exe) = info.path.map(PathBuf::from) else { return };
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let quiet = |_: String| {};
        let git = |args: &[&str]| run(&exe, Invocation::new(&root, args), &quiet).unwrap();
        assert_eq!(git(&["init", "-q", "-b", "main"]).code, Some(0));
        git(&["config", "user.name", "T"]);
        git(&["config", "user.email", "t@example.com"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        let st = parse_status(&git(&["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]).stdout);
        assert_eq!(st.oid, None);
        assert_eq!(st.entries[0].kind, "untracked");
        git(&["add", "-A", "--", "a.txt"]);
        let mut inv = Invocation::new(&root, &["commit", "-q", "-F", "-"]);
        inv.stdin = Some(b"first: \"quoted\" $(not a shell)".to_vec());
        assert_eq!(run(&exe, inv, &quiet).unwrap().code, Some(0));
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        let st = parse_status(&git(&["status", "--porcelain=v2", "-z", "--branch"]).stdout);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert!(st.oid.is_some());
        assert_eq!((st.entries[0].x.as_str(), st.entries[0].y.as_str()), (".", "M"));
        let head = git(&["show", "HEAD:./a.txt"]);
        assert_eq!(String::from_utf8_lossy(&head.stdout), "one\n");
        let log = parse_log(&text(&git(&["log", "-n5", &format!("--format={LOG_FORMAT}")])));
        assert_eq!(log[0].subject, "first: \"quoted\" $(not a shell)");
        // Literal pathspecs: "[a].txt" (a legal name on every OS) matches only itself,
        // although as a glob it would also match "a.txt".
        std::fs::write(root.join("[a].txt"), "glob\n").unwrap();
        git(&["add", "-A", "--", "[a].txt"]);
        let st = parse_status(&git(&["status", "--porcelain=v2", "-z"]).stdout);
        let glob = st.entries.iter().find(|e| e.path == "[a].txt").unwrap();
        assert_eq!(glob.x, "A");
        let a = st.entries.iter().find(|e| e.path == "a.txt").unwrap();
        assert_eq!(a.x, ".", "a.txt must not be staged by the '[a].txt' pathspec");
    }

    #[test]
    fn real_repo_branch_upstream_and_ahead_behind() {
        let info = detect();
        let Some(exe) = info.path.map(PathBuf::from) else { return };
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let quiet = |_: String| {};
        let git = |cwd: &Path, args: &[&str]| {
            let out = run(&exe, Invocation::new(cwd, args), &quiet).unwrap();
            assert_eq!(out.code, Some(0), "git {args:?}: {}", out.stderr);
            out
        };
        let commit = |cwd: &Path, file: &str, msg: &str| {
            std::fs::write(cwd.join(file), msg).unwrap();
            git(cwd, &["add", "-A", "--", file]);
            git(cwd, &["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", msg]);
        };
        // A bare "remote", two clones of it: one pushes, the other falls behind and moves ahead.
        let remote = base.join("remote.git");
        git(&base, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
        let (a, b) = (base.join("a"), base.join("b"));
        git(&base, &["clone", "-q", remote.to_str().unwrap(), a.to_str().unwrap()]);
        git(&a, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        commit(&a, "one.txt", "one");
        git(&a, &["push", "-q", "-u", "origin", "main"]);
        git(&base, &["clone", "-q", remote.to_str().unwrap(), b.to_str().unwrap()]);
        commit(&a, "two.txt", "two");
        commit(&a, "three.txt", "three");
        git(&a, &["push", "-q"]);
        commit(&b, "local.txt", "local");
        git(&b, &["fetch", "-q"]);
        std::fs::write(b.join("untracked.txt"), "?").unwrap();
        let st = parse_status(&git(&b, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]).stdout);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (1, 2));
        assert_eq!(st.entries.len(), 1);
        assert_eq!((st.entries[0].path.as_str(), st.entries[0].kind), ("untracked.txt", "untracked"));
        // A new local branch has no upstream until it is published.
        git(&b, &["checkout", "-q", "-b", "feature/x"]);
        let st = parse_status(&git(&b, &["status", "--porcelain=v2", "-z", "--branch"]).stdout);
        assert_eq!(st.branch.as_deref(), Some("feature/x"));
        assert_eq!(st.upstream, None);
        assert_eq!((st.ahead, st.behind), (0, 0));
        // Detached HEAD.
        git(&b, &["checkout", "-q", "--detach", "HEAD~1"]);
        let st = parse_status(&git(&b, &["status", "--porcelain=v2", "-z", "--branch"]).stdout);
        assert_eq!(st.branch, None);
        assert!(st.oid.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn timeouts_and_cancel_stop_git() {
        let info = detect();
        let Some(exe) = info.path.map(PathBuf::from) else { return };
        let dir = tempfile::tempdir().unwrap();
        // A shell alias that hangs (tests only: the app never runs aliases or shells).
        let slow = ["-c", "alias.slow=!sleep 30", "slow"];
        let started = Instant::now();
        let mut inv = Invocation::new(dir.path(), &slow);
        inv.timeout = Duration::from_millis(300);
        assert_eq!(run(&exe, inv, &|_| {}).unwrap_err(), "Git timed out.");
        let flag = Arc::new(AtomicBool::new(false));
        let mut inv = Invocation::new(dir.path(), &slow);
        inv.cancel = Some(flag.clone());
        let f2 = flag.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            f2.store(true, Ordering::SeqCst);
        });
        assert_eq!(run(&exe, inv, &|_| {}).unwrap_err(), "Cancelled");
        assert!(started.elapsed() < Duration::from_secs(5), "the whole process group was killed");
    }
}
