//! Third-party AI tools in terminals (AI usage control plan §6.4), best-effort, client side.
//!
//! The workbench decides (Task Mentor's `thirdPartyExtensions`, the exam) and sends the decision
//! with the catalogue of AI CLIs (`packages/protocol/src/aiTools.ts`, the one source) through
//! `ai_tools_policy`. While AI tools are off:
//! - new terminals, "Run in terminal" and Testing-view commands get a PATH shim folder whose
//!   `claude`, `codex`, `gemini`… stubs print the reason and exit 1, no AI provider keys, and
//!   provider base URLs pointing nowhere;
//! - a watcher (every 2 s) kills any process under TMCode's terminals and runs that is an AI tool
//!   or a package manager installing one (`npm i -g @anthropic-ai/claude-code`, `pip install
//!   aider-chat`…) and tells the workbench (`ai-tool` event), which logs the attempt.
//! While they are allowed the watcher only reports what ran (the activity log names it).
//!
//! Limits: a renamed binary, a student's own program calling an AI API directly, a container or
//! a remote shell get past this. On Windows only program names are seen (no command lines).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// `AiToolCatalog` in packages/protocol/src/aiTools.ts.
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(default)]
pub struct Catalog {
    pub bins: HashMap<String, String>,
    pub subcommands: HashMap<String, HashMap<String, String>>,
    pub npm: HashMap<String, String>,
    pub pip: HashMap<String, String>,
    pub modules: HashMap<String, String>,
    pub brew: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub tool: String,
    /// A package manager installing it (not the tool itself).
    pub install: bool,
}

/// "C:\\x\\Claude.CMD" → "claude"; "/usr/bin/python3.12" → "python3.12".
pub fn program_name(arg: &str) -> String {
    let base = arg.rsplit(['/', '\\']).next().unwrap_or(arg).to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".ps1"] {
        if let Some(s) = base.strip_suffix(ext) {
            return s.to_string();
        }
    }
    base
}

/// "@openai/codex@0.1" → "@openai/codex"; "aider-chat[all]==0.8" → "aider-chat".
pub fn package_name(spec: &str) -> String {
    let s = spec.trim().to_ascii_lowercase();
    let s = s.strip_prefix("npm:").unwrap_or(&s).to_string();
    if s.starts_with('@') {
        match s[1..].find('@') {
            Some(i) => s[..i + 1].to_string(),
            None => s,
        }
    } else {
        s.split(['@', '=', '<', '>', '!', '~', ';', '[', ' ']).next().unwrap_or("").to_string()
    }
}

fn is_interpreter(p: &str) -> bool {
    if matches!(p, "node" | "nodejs" | "bun" | "deno" | "py") {
        return true;
    }
    let rest = p.strip_prefix("pythonw").or_else(|| p.strip_prefix("python"));
    rest.is_some_and(|r| r.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

fn is_flag(a: &str) -> bool {
    a.starts_with('-')
}

#[derive(Clone, Copy, PartialEq)]
enum Map {
    Npm,
    Pip,
    Brew,
}

fn lookup_package(cat: &Catalog, spec: &str, maps: &[Map]) -> Option<String> {
    let name = package_name(spec);
    for m in maps {
        let hit = match m {
            Map::Npm => cat.npm.get(&name),
            Map::Pip => cat.pip.get(&name),
            Map::Brew => cat.brew.get(&name).or_else(|| cat.brew.get(name.rsplit('/').next().unwrap_or(&name))),
        };
        if let Some(h) = hit {
            return Some(h.clone());
        }
    }
    None
}

fn in_node_modules(cat: &Catalog, arg: &str) -> Option<String> {
    let a = arg.replace('\\', "/").to_ascii_lowercase();
    let i = a.rfind("node_modules/")?;
    let rest: Vec<&str> = a[i + "node_modules/".len()..].split('/').collect();
    let name = if rest[0].starts_with('@') { format!("{}/{}", rest[0], rest.get(1).copied().unwrap_or("")) } else { rest[0].to_string() };
    cat.npm.get(&name).cloned()
}

/// The first package argument from `from` on that is an AI tool (flags skipped). `all`: look at
/// every argument (installs), else only the first (runners: the rest are the tool's own args).
fn first_package(cat: &Catalog, args: &[String], from: usize, maps: &[Map], all: bool) -> Option<String> {
    let mut i = from;
    while i < args.len() {
        let a = &args[i];
        if is_flag(a) {
            if (a == "-p" || a == "--package") && i + 1 < args.len() {
                if let Some(h) = lookup_package(cat, &args[i + 1], maps) {
                    return Some(h);
                }
                i += 1;
            } else if let Some(p) = a.strip_prefix("--package=") {
                if let Some(h) = lookup_package(cat, p, maps) {
                    return Some(h);
                }
            }
            i += 1;
            continue;
        }
        let hit = lookup_package(cat, a, maps).or_else(|| if !all && maps.contains(&Map::Npm) { cat.bins.get(&program_name(&package_name(a))).cloned() } else { None });
        if hit.is_some() {
            return hit;
        }
        if !all {
            return None;
        }
        i += 1;
    }
    None
}

/// Whether one process's argv is an AI tool, or a package manager installing one. Mirrors
/// `matchAiTool` in packages/protocol/src/aiTools.ts (same rules, same test cases).
pub fn match_argv(cat: &Catalog, argv: &[String]) -> Option<Hit> {
    let first = argv.first()?;
    let exe = program_name(first);
    let args = &argv[1..];
    let lower = |i: usize| args.get(i).map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    let run = |t: Option<String>| t.map(|tool| Hit { tool, install: false });
    let install = |t: Option<String>| t.map(|tool| Hit { tool, install: true });

    if let Some(t) = cat.bins.get(&exe) {
        return run(Some(t.clone()));
    }
    if let Some(t) = cat.subcommands.get(&exe).and_then(|m| m.get(&lower(0))) {
        return run(Some(t.clone()));
    }
    for a in argv {
        if let Some(t) = in_node_modules(cat, a) {
            return run(Some(t));
        }
    }
    let (sub, sub2) = (lower(0), lower(1));

    if is_interpreter(&exe) {
        if let Some(m) = args.iter().position(|a| a == "-m") {
            if let Some(module) = args.get(m + 1).map(|s| s.to_ascii_lowercase()) {
                let next = lower(m + 2);
                if module == "pip" && next == "install" {
                    return install(first_package(cat, args, m + 3, &[Map::Pip], true));
                }
                if module == "pipx" && (next == "install" || next == "run") {
                    return install(first_package(cat, args, m + 3, &[Map::Pip], false));
                }
                return run(cat.modules.get(&module).cloned());
            }
        }
        // node /usr/local/bin/claude, python ~/.local/bin/aider
        if let Some(script) = args.iter().find(|a| !is_flag(a)) {
            if script.contains('/') || script.contains('\\') {
                return run(cat.bins.get(&program_name(script)).cloned());
            }
        }
        return None;
    }
    let install_verb = |s: &str, verbs: &[&str]| verbs.contains(&s);
    match exe.as_str() {
        "npx" | "pnpx" | "bunx" => run(first_package(cat, args, 0, &[Map::Npm], false)),
        "uvx" => run(first_package(cat, args, 0, &[Map::Pip], false).or_else(|| args.iter().find(|a| !is_flag(a)).and_then(|a| cat.bins.get(&program_name(&package_name(a))).cloned()))),
        "npm" => {
            if sub == "exec" || sub == "x" {
                run(first_package(cat, args, 1, &[Map::Npm], false))
            } else if install_verb(&sub, &["install", "i", "add", "in", "isntall", "update", "up"]) {
                install(first_package(cat, args, 1, &[Map::Npm], true))
            } else {
                None
            }
        }
        "pnpm" | "yarn" => {
            if sub == "dlx" {
                run(first_package(cat, args, 1, &[Map::Npm], false))
            } else if sub == "global" && sub2 == "add" {
                install(first_package(cat, args, 2, &[Map::Npm], true))
            } else if install_verb(&sub, &["add", "install", "i"]) {
                install(first_package(cat, args, 1, &[Map::Npm], true))
            } else {
                None
            }
        }
        "bun" => {
            if sub == "x" {
                run(first_package(cat, args, 1, &[Map::Npm], false))
            } else if install_verb(&sub, &["add", "install", "i"]) {
                install(first_package(cat, args, 1, &[Map::Npm], true))
            } else {
                None
            }
        }
        "pipx" => match sub.as_str() {
            "run" => run(first_package(cat, args, 1, &[Map::Pip], false)),
            "install" => install(first_package(cat, args, 1, &[Map::Pip], true)),
            _ => None,
        },
        "uv" => {
            if sub == "tool" && sub2 == "run" {
                run(first_package(cat, args, 2, &[Map::Pip], false))
            } else if (sub == "tool" || sub == "pip") && sub2 == "install" {
                install(first_package(cat, args, 2, &[Map::Pip], true))
            } else if sub == "add" {
                install(first_package(cat, args, 1, &[Map::Pip], true))
            } else {
                None
            }
        }
        "brew" if install_verb(&sub, &["install", "reinstall", "upgrade"]) => install(first_package(cat, args, 1, &[Map::Brew], true)),
        "gh" if (sub == "extension" || sub == "ext") && sub2 == "install" => {
            let copilot = args[2..].iter().any(|a| {
                let a = a.to_ascii_lowercase();
                a == "gh-copilot" || a.ends_with("/gh-copilot")
            });
            install(copilot.then(|| "GitHub Copilot CLI".to_string()))
        }
        _ => {
            let pip = exe.strip_prefix("pip").is_some_and(|r| r.chars().all(|c| c.is_ascii_digit() || c == '.'));
            if pip && sub == "install" {
                install(first_package(cat, args, 1, &[Map::Pip], true))
            } else {
                None
            }
        }
    }
}

// ───────────── environment of new terminals and runs ─────────────

/// AI provider keys a terminal must not inherit while AI tools are off. GH_TOKEN / GITHUB_TOKEN
/// stay: git and gh use them, and TMCode's own git auth (askpass) is set per git child anyway.
pub const AI_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_ORG_ID",
    "CODEX_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
    "TOGETHER_API_KEY",
    "COHERE_API_KEY",
    "DASHSCOPE_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "COPILOT_GITHUB_TOKEN",
    "GH_COPILOT_TOKEN",
    "AIDER_OPENAI_API_KEY",
    "AIDER_ANTHROPIC_API_KEY",
];

/// Provider endpoints pointed at a closed local port (discard), so a tool that finds a key
/// elsewhere still can't reach its provider.
const NOWHERE: &str = "http://127.0.0.1:9";
pub const AI_BASE_URLS: &[&str] = &["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL", "OPENROUTER_BASE_URL", "OLLAMA_HOST", "LLM_BASE_URL"];

/// What a new process's environment gets while AI tools are off: variables to remove, and to set
/// (PATH starts with the shim folder). `path` is the PATH it would otherwise have.
pub fn blocked_env(shims: Option<&Path>, path: Option<&str>) -> (Vec<&'static str>, Vec<(String, String)>) {
    let mut set: Vec<(String, String)> = AI_BASE_URLS.iter().map(|k| (k.to_string(), if *k == "OLLAMA_HOST" { "127.0.0.1:9".to_string() } else { NOWHERE.to_string() })).collect();
    set.push(("TMCODE_AI_TOOLS".into(), "off".into()));
    if let Some(dir) = shims {
        let sep = if cfg!(windows) { ';' } else { ':' };
        let dir = dir.to_string_lossy();
        let path = path.unwrap_or_default();
        set.push(("PATH".into(), if path.is_empty() { dir.into_owned() } else { format!("{dir}{sep}{path}") }));
    }
    (AI_KEYS.to_vec(), set)
}

/// Applies `blocked_env` to a terminal or run about to start (no-op while AI tools are allowed).
pub fn apply_pty(cmd: &mut portable_pty::CommandBuilder) {
    let Some((shims, _)) = blocked_now() else { return };
    let path = cmd.get_env("PATH").map(|p| p.to_string_lossy().into_owned()).or_else(|| std::env::var("PATH").ok());
    let (remove, set) = blocked_env(shims.as_deref(), path.as_deref());
    for k in remove {
        cmd.env_remove(k);
    }
    for (k, v) in set {
        cmd.env(k, v);
    }
}

pub fn apply_command(cmd: &mut std::process::Command) {
    let Some((shims, _)) = blocked_now() else { return };
    let path = cmd.get_envs().find(|(k, _)| *k == "PATH").and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned())).or_else(|| std::env::var("PATH").ok());
    let (remove, set) = blocked_env(shims.as_deref(), path.as_deref());
    for k in remove {
        cmd.env_remove(k);
    }
    for (k, v) in set {
        cmd.env(k, v);
    }
}

/// One-line, shell-safe words for the stubs.
fn stub_text(message: &str) -> String {
    let m: String = message.chars().filter(|c| !c.is_control()).collect();
    let m = if m.trim().is_empty() { "your school or teacher turned them off.".to_string() } else { m };
    format!("AI tools are turned off: {m}")
}

/// The stub for one program: a POSIX sh script, or a .cmd file on Windows.
pub fn stub_script(message: &str, windows: bool) -> String {
    let text = stub_text(message);
    if windows {
        let safe: String = text.chars().map(|c| if "&|<>^%\"".contains(c) { ' ' } else { c }).collect();
        format!("@echo off\r\necho {safe} 1>&2\r\nexit /b 1\r\n")
    } else {
        format!("#!/bin/sh\nprintf '%s\\n' '{}' >&2\nexit 1\n", text.replace('\'', "'\\''"))
    }
}

fn write_shims(dir: &Path, cat: &Catalog, message: &str) -> std::io::Result<()> {
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    std::fs::create_dir_all(dir)?;
    let windows = cfg!(windows);
    let body = stub_script(message, windows);
    for bin in cat.bins.keys() {
        if bin.is_empty() || bin.contains(['/', '\\', '.']) {
            continue;
        }
        let file = dir.join(if windows { format!("{bin}.cmd") } else { bin.clone() });
        std::fs::write(&file, &body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(())
}

// ───────────── state + watcher ─────────────

#[derive(Default)]
struct State {
    blocked: bool,
    message: String,
    catalog: Catalog,
    shims: Option<PathBuf>,
    /// Processes TMCode started for the student (terminal shells, runs, commands).
    roots: HashSet<u32>,
    /// Processes already reported (or killed).
    seen: HashSet<u32>,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(Mutex::default)
}

/// Some((shim folder, message)) while AI tools are off.
fn blocked_now() -> Option<(Option<PathBuf>, String)> {
    let s = state().lock().unwrap();
    s.blocked.then(|| (s.shims.clone(), s.message.clone()))
}

/// A process TMCode started for the student: the watcher looks at it and everything under it.
pub fn watch(pid: Option<u32>) {
    if let Some(pid) = pid.filter(|p| *p > 0) {
        state().lock().unwrap().roots.insert(pid);
    }
}

pub fn unwatch(pid: Option<u32>) {
    if let Some(pid) = pid {
        state().lock().unwrap().roots.remove(&pid);
    }
}

#[derive(Clone, Serialize)]
pub struct AiToolEvent {
    /// "blocked" (killed) or "seen" (allowed, reported).
    pub action: &'static str,
    pub tool: String,
    pub install: bool,
    /// The command line (truncated).
    pub command: String,
    pub message: String,
}

pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    pub argv: Vec<String>,
}

/// Every process under `roots` (the roots included).
pub fn descendants(procs: &[ProcInfo], roots: &HashSet<u32>) -> Vec<usize> {
    let mut inside: HashSet<u32> = roots.clone();
    let mut out = Vec::new();
    // Parents can come after children in the list: repeat until nothing new joins.
    loop {
        let before = inside.len();
        for p in procs {
            if !inside.contains(&p.pid) && inside.contains(&p.ppid) {
                inside.insert(p.pid);
            }
        }
        if inside.len() == before {
            break;
        }
    }
    for (i, p) in procs.iter().enumerate() {
        if inside.contains(&p.pid) {
            out.push(i);
        }
    }
    out
}

#[cfg(unix)]
fn list_processes() -> Vec<ProcInfo> {
    let Ok(out) = std::process::Command::new("ps").args(["-A", "-ww", "-o", "pid=,ppid=,args="]).output() else { return vec![] };
    parse_ps(&String::from_utf8_lossy(&out.stdout))
}

/// `ps -o pid=,ppid=,args=` lines.
pub fn parse_ps(text: &str) -> Vec<ProcInfo> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            Some(ProcInfo { pid, ppid, argv: it.map(str::to_string).collect() })
        })
        .collect()
}

#[cfg(windows)]
fn list_processes() -> Vec<ProcInfo> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e) != 0;
        while ok {
            let len = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
            let exe = String::from_utf16_lossy(&e.szExeFile[..len]);
            out.push(ProcInfo { pid: e.th32ProcessID, ppid: e.th32ParentProcessID, argv: vec![exe] });
            ok = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
    }
    out
}

fn kill(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}

/// One look at the processes under TMCode's terminals and runs.
fn scan(app: &AppHandle) {
    let (blocked, message, catalog, roots) = {
        let s = state().lock().unwrap();
        if s.roots.is_empty() {
            return;
        }
        (s.blocked, s.message.clone(), s.catalog.clone(), s.roots.clone())
    };
    if catalog.bins.is_empty() {
        return;
    }
    let procs = list_processes();
    let live: HashSet<u32> = procs.iter().map(|p| p.pid).collect();
    let mut events = Vec::new();
    {
        let mut s = state().lock().unwrap();
        s.roots.retain(|p| live.contains(p));
        s.seen.retain(|p| live.contains(p));
        for i in descendants(&procs, &roots) {
            let p = &procs[i];
            if roots.contains(&p.pid) || s.seen.contains(&p.pid) {
                continue;
            }
            let Some(hit) = match_argv(&catalog, &p.argv) else { continue };
            s.seen.insert(p.pid);
            if blocked {
                // The tool and everything it started.
                let mut tree = HashSet::new();
                tree.insert(p.pid);
                for j in descendants(&procs, &tree) {
                    kill(procs[j].pid);
                }
            }
            let mut command = p.argv.join(" ");
            if command.len() > 300 {
                let mut cut = 300;
                while !command.is_char_boundary(cut) {
                    cut -= 1;
                }
                command.truncate(cut);
            }
            events.push(AiToolEvent { action: if blocked { "blocked" } else { "seen" }, tool: hit.tool, install: hit.install, command, message: message.clone() });
        }
    }
    for e in events {
        log::info!("AI tool {} in a terminal: {} ({})", e.action, e.tool, e.command);
        let _ = app.emit("ai-tool", e);
    }
}

/// Starts the watcher (once, at startup).
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name("ai-tools".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        scan(&app);
    });
}

/// The workbench's decision: whether third-party AI tools are off, why, and the catalogue.
#[tauri::command]
pub fn ai_tools_policy(app: AppHandle, blocked: bool, message: String, catalog: Catalog) -> Result<(), String> {
    let shims = if blocked {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ai-shims");
        match write_shims(&dir, &catalog, &message) {
            Ok(()) => Some(dir),
            Err(e) => {
                log::warn!("AI tool shims not written: {e}");
                None
            }
        }
    } else {
        None
    };
    {
        let mut s = state().lock().unwrap();
        let was = s.blocked;
        s.blocked = blocked;
        s.message = message;
        s.catalog = catalog;
        s.shims = shims;
        // Turned off: tools already running are looked at again (and stopped).
        if blocked && !was {
            s.seen.clear();
        }
    }
    let app2 = app.clone();
    std::thread::spawn(move || scan(&app2));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat() -> Catalog {
        let m = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>();
        Catalog {
            bins: m(&[("claude", "Claude Code"), ("codex", "Codex CLI"), ("gemini", "Gemini CLI"), ("aider", "Aider"), ("opencode", "opencode"), ("cursor-agent", "Cursor Agent"), ("mods", "Mods")]),
            subcommands: [("gh".to_string(), m(&[("copilot", "GitHub Copilot CLI")]))].into_iter().collect(),
            npm: m(&[("@anthropic-ai/claude-code", "Claude Code"), ("@openai/codex", "Codex CLI"), ("@google/gemini-cli", "Gemini CLI"), ("@qwen-code/qwen-code", "Qwen Code"), ("opencode-ai", "opencode")]),
            pip: m(&[("aider-chat", "Aider"), ("aider-install", "Aider"), ("shell-gpt", "ShellGPT"), ("llm", "LLM")]),
            modules: m(&[("aider", "Aider")]),
            brew: m(&[("ollama", "Ollama"), ("crush", "Crush")]),
        }
    }

    fn tool(cmd: &str) -> Option<Hit> {
        match_argv(&cat(), &cmd.split(' ').map(str::to_string).collect::<Vec<_>>())
    }
    fn argv(parts: &[&str]) -> Option<Hit> {
        match_argv(&cat(), &parts.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }
    fn name(h: Option<Hit>) -> Option<String> {
        h.map(|h| h.tool)
    }

    #[test]
    fn names_programs_and_packages() {
        assert_eq!(program_name("C:\\Users\\a\\AppData\\Roaming\\npm\\Claude.CMD"), "claude");
        assert_eq!(program_name("/usr/bin/python3.12"), "python3.12");
        assert_eq!(package_name("@openai/codex@0.1.2"), "@openai/codex");
        assert_eq!(package_name("aider-chat[playwright]==0.86"), "aider-chat");
        assert_eq!(package_name("opencode-ai@latest"), "opencode-ai");
    }

    #[test]
    fn finds_the_tools_themselves() {
        assert_eq!(tool("claude -p hi"), Some(Hit { tool: "Claude Code".into(), install: false }));
        assert_eq!(name(tool("/opt/homebrew/bin/codex")).as_deref(), Some("Codex CLI"));
        assert_eq!(name(argv(&["C:\\Users\\a\\AppData\\Roaming\\npm\\gemini.cmd"])).as_deref(), Some("Gemini CLI"));
        assert_eq!(name(argv(&["C:\\tools\\aider.exe", "--model", "x"])).as_deref(), Some("Aider"));
        assert_eq!(name(tool("gh copilot suggest")).as_deref(), Some("GitHub Copilot CLI"));
        assert_eq!(name(tool("cursor-agent")).as_deref(), Some("Cursor Agent"));
    }

    #[test]
    fn finds_tools_through_interpreters_and_runners() {
        assert_eq!(name(tool("node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js")).as_deref(), Some("Claude Code"));
        assert_eq!(name(argv(&["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js"])).as_deref(), Some("Gemini CLI"));
        assert_eq!(name(tool("node /Users/a/.npm-global/bin/claude")).as_deref(), Some("Claude Code"));
        assert_eq!(name(tool("python3 -m aider --yes")).as_deref(), Some("Aider"));
        assert_eq!(name(tool("npx @anthropic-ai/claude-code")).as_deref(), Some("Claude Code"));
        assert_eq!(name(tool("npx -y @openai/codex@latest")).as_deref(), Some("Codex CLI"));
        assert_eq!(name(tool("npx opencode")).as_deref(), Some("opencode"));
        assert_eq!(name(tool("pnpm dlx @qwen-code/qwen-code")).as_deref(), Some("Qwen Code"));
        assert_eq!(name(tool("uvx --from aider-chat aider")).as_deref(), Some("Aider"));
        assert_eq!(name(tool("pipx run shell-gpt")).as_deref(), Some("ShellGPT"));
    }

    #[test]
    fn finds_installs() {
        assert_eq!(tool("npm install -g @anthropic-ai/claude-code"), Some(Hit { tool: "Claude Code".into(), install: true }));
        assert_eq!(name(tool("npm i -g express @openai/codex")).as_deref(), Some("Codex CLI"));
        assert_eq!(tool("pip install aider-chat"), Some(Hit { tool: "Aider".into(), install: true }));
        assert_eq!(name(tool("pip3 install --user shell-gpt==1.4")).as_deref(), Some("ShellGPT"));
        assert_eq!(name(tool("python -m pip install aider-install")).as_deref(), Some("Aider"));
        assert_eq!(name(tool("pipx install llm")).as_deref(), Some("LLM"));
        assert_eq!(name(tool("uv tool install aider-chat")).as_deref(), Some("Aider"));
        assert_eq!(name(tool("brew install ollama")).as_deref(), Some("Ollama"));
        assert_eq!(name(tool("brew install charmbracelet/tap/crush")).as_deref(), Some("Crush"));
        assert_eq!(name(tool("yarn global add @google/gemini-cli")).as_deref(), Some("Gemini CLI"));
        assert_eq!(name(tool("gh extension install github/gh-copilot")).as_deref(), Some("GitHub Copilot CLI"));
    }

    #[test]
    fn leaves_ordinary_work_alone() {
        for cmd in ["npm install", "npm install express react", "npm i mods", "node server.js", "python3 main.py", "python -m http.server", "pip install requests openai", "git commit -m claude", "gh pr list", "brew install git", "/bin/zsh -l"] {
            assert_eq!(tool(cmd), None, "{cmd}");
        }
        assert_eq!(match_argv(&cat(), &[]), None);
    }

    #[test]
    fn blocked_env_strips_keys_and_points_providers_nowhere() {
        let (remove, set) = blocked_env(Some(Path::new("/data/ai-shims")), Some("/usr/bin:/bin"));
        assert!(remove.contains(&"ANTHROPIC_API_KEY") && remove.contains(&"OPENAI_API_KEY") && remove.contains(&"COPILOT_GITHUB_TOKEN"));
        // git auth keeps working.
        assert!(!remove.contains(&"GH_TOKEN") && !remove.contains(&"GITHUB_TOKEN"));
        let get = |k: &str| set.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("ANTHROPIC_BASE_URL").as_deref(), Some("http://127.0.0.1:9"));
        assert_eq!(get("OLLAMA_HOST").as_deref(), Some("127.0.0.1:9"));
        let sep = if cfg!(windows) { ';' } else { ':' };
        assert_eq!(get("PATH"), Some(format!("/data/ai-shims{sep}/usr/bin:/bin")));
        let (_, set) = blocked_env(None, Some("/usr/bin"));
        assert!(set.iter().all(|(k, _)| k != "PATH"), "no shims: PATH untouched");
    }

    #[test]
    fn stubs_say_why_and_fail() {
        let sh = stub_script("Your teacher's 'off' setting", false);
        assert!(sh.starts_with("#!/bin/sh\n") && sh.contains("AI tools are turned off: Your teacher'\\''s '\\''off'\\'' setting") && sh.ends_with("exit 1\n"));
        let cmd = stub_script("A & B | C", true);
        assert!(cmd.contains("AI tools are turned off: A   B   C") && cmd.contains("exit /b 1"));
    }

    #[cfg(unix)]
    #[test]
    fn stub_runs_and_exits_1() {
        let dir = tempfile::tempdir().unwrap();
        write_shims(dir.path(), &cat(), "School policy.").unwrap();
        let out = std::process::Command::new(dir.path().join("claude")).output().unwrap();
        assert_eq!(out.status.code(), Some(1));
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "AI tools are turned off: School policy.");
    }

    #[test]
    fn finds_descendants_in_any_order() {
        let p = |pid, ppid, cmd: &str| ProcInfo { pid, ppid, argv: cmd.split(' ').map(str::to_string).collect() };
        let procs = vec![p(30, 20, "claude"), p(20, 10, "zsh"), p(10, 1, "zsh -l"), p(40, 1, "claude"), p(50, 30, "node x")];
        let roots: HashSet<u32> = [10].into_iter().collect();
        let mut pids: Vec<u32> = descendants(&procs, &roots).into_iter().map(|i| procs[i].pid).collect();
        pids.sort();
        assert_eq!(pids, [10, 20, 30, 50]);
        let parsed = parse_ps("  123     1 /bin/zsh -l\n 456   123 node /x/node_modules/@openai/codex/bin/codex.js --yolo\nbad line\n");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].ppid, 123);
        assert_eq!(name(match_argv(&cat(), &parsed[1].argv)).as_deref(), Some("Codex CLI"));
    }
}
