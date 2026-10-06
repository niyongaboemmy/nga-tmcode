//! Finds the compilers and interpreters on this computer.
//!
//! Apps started from the Dock or Start menu don't get the PATH a terminal
//! has, so besides PATH we look where installers put things. On macOS the
//! `/usr/bin` compiler shims open an "install developer tools" dialog when the
//! Command Line Tools are missing, so they are only used when the tools are
//! really there.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Serialize, Clone, Debug)]
pub struct Toolchain {
    /// "python", "node", "cc", "cxx", "javac", "java", "go" or "rustc".
    pub tool: String,
    pub path: String,
    /// Arguments that always come first (the Windows `py` launcher needs `-3`).
    pub prefix_args: Vec<String>,
    pub version: String,
}

#[derive(Default)]
pub struct Toolchains(Mutex<Option<HashMap<String, Toolchain>>>);

impl Toolchains {
    pub fn get(&self, tool: &str) -> Option<Toolchain> {
        let mut guard = self.0.lock().unwrap();
        if guard.is_none() {
            *guard = Some(detect_all());
        }
        guard.as_ref().unwrap().get(tool).cloned()
    }

    pub fn all(&self, refresh: bool) -> Vec<Toolchain> {
        let mut guard = self.0.lock().unwrap();
        if refresh || guard.is_none() {
            *guard = Some(detect_all());
        }
        let mut list: Vec<_> = guard.as_ref().unwrap().values().cloned().collect();
        list.sort_by(|a, b| a.tool.cmp(&b.tool));
        list
    }
}

pub const TOOLS: &[&str] = &["python", "node", "cc", "cxx", "javac", "java", "go", "rustc"];

fn names(tool: &str) -> &'static [&'static str] {
    match tool {
        #[cfg(windows)]
        "python" => &["py", "python"],
        #[cfg(not(windows))]
        "python" => &["python3", "python"],
        "node" => &["node"],
        #[cfg(target_os = "macos")]
        "cc" => &["clang", "gcc", "cc"],
        #[cfg(not(target_os = "macos"))]
        "cc" => &["gcc", "clang", "cc"],
        #[cfg(target_os = "macos")]
        "cxx" => &["clang++", "g++", "c++"],
        #[cfg(not(target_os = "macos"))]
        "cxx" => &["g++", "clang++", "c++"],
        "javac" => &["javac"],
        "java" => &["java"],
        "go" => &["go"],
        "rustc" => &["rustc"],
        _ => &[],
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Newest-looking subdirectory matching `prefix` (e.g. the latest nvm Node).
fn newest_child(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().map(|n| n.to_string_lossy().starts_with(prefix)).unwrap_or(false))
        .collect();
    found.sort_by_key(|p| version_key(&p.file_name().unwrap().to_string_lossy()));
    found.pop()
}

fn version_key(s: &str) -> Vec<u64> {
    s.split(|c: char| !c.is_ascii_digit()).filter_map(|p| p.parse().ok()).collect()
}

#[cfg(target_os = "macos")]
fn command_line_tools_installed() -> bool {
    Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Extra places to look besides PATH, most specific first.
fn extra_dirs(tool: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let h = home();
    // rustup and the Go installer put their tools in the same places on every OS.
    if tool == "rustc" {
        if let Some(h) = &h {
            dirs.push(h.join(".cargo").join("bin"));
        }
    }
    if tool == "go" {
        if cfg!(windows) {
            dirs.push(PathBuf::from(r"C:\Program Files\Go\bin"));
        } else {
            dirs.push(PathBuf::from("/usr/local/go/bin"));
            dirs.push(PathBuf::from("/opt/homebrew/opt/go/bin"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        if let Some(h) = &h {
            if tool == "node" {
                if let Some(v) = newest_child(&h.join(".nvm/versions/node"), "v") {
                    dirs.push(v.join("bin"));
                }
                dirs.push(h.join(".volta/bin"));
            }
            if tool == "python" {
                dirs.push(h.join(".pyenv/shims"));
            }
        }
        if tool == "python" {
            dirs.push(PathBuf::from("/Library/Frameworks/Python.framework/Versions/Current/bin"));
        }
        if tool == "java" || tool == "javac" {
            // The /usr/bin java stubs prompt to install Java; ask java_home for a real JDK.
            if let Ok(out) = Command::new("/usr/libexec/java_home").stderr(Stdio::null()).output() {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if out.status.success() && !p.is_empty() {
                    dirs.insert(0, PathBuf::from(p).join("bin"));
                }
            }
            if let Some(v) = newest_child(Path::new("/opt/homebrew/opt"), "openjdk") {
                dirs.push(v.join("bin"));
            }
        }
        if ["python", "cc", "cxx"].contains(&tool) && command_line_tools_installed() {
            dirs.push(PathBuf::from("/usr/bin"));
        }
    }
    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        match tool {
            "python" => {
                if let Some(l) = &local {
                    if let Some(v) = newest_child(&l.join(r"Programs\Python"), "Python3") {
                        dirs.push(v);
                    }
                }
                dirs.push(PathBuf::from(r"C:\Windows"));
            }
            "node" => dirs.push(pf.join("nodejs")),
            "cc" | "cxx" => {
                for d in [r"C:\msys64\ucrt64\bin", r"C:\msys64\mingw64\bin", r"C:\MinGW\bin", r"C:\mingw64\bin", r"C:\w64devkit\bin"] {
                    dirs.push(PathBuf::from(d));
                }
                dirs.push(pf.join(r"LLVM\bin"));
            }
            "java" | "javac" => {
                for vendor in ["Eclipse Adoptium", "Java", "Microsoft", "Zulu"] {
                    if let Some(v) = newest_child(&pf.join(vendor), "jdk") {
                        dirs.push(v.join("bin"));
                    }
                }
            }
            _ => {}
        }
        let _ = &h;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        let _ = (&h, tool);
    }
    dirs
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

fn executable(dir: &Path, name: &str) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![dir.join(format!("{name}.exe")), dir.join(format!("{name}.cmd"))]
    } else {
        vec![dir.join(name)]
    };
    candidates.into_iter().find(|p| p.is_file())
}

/// Runs `path --version` (or `-version` for Java) with a short timeout and
/// returns the first meaningful line; None means "not really usable".
fn probe_version(tool: &str, path: &Path, prefix: &[String]) -> Option<String> {
    let flag = match tool {
        "java" | "javac" => "-version",
        "go" => "version",
        _ => "--version",
    };
    let mut child = Command::new(path)
        .args(prefix)
        .arg(flag)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > Duration::from_secs(6) => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    text.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.to_string())
}

/// Executables that could be `tool`, in preference order (not yet probed).
fn possible(tool: &str) -> Vec<(PathBuf, Vec<String>)> {
    let mut dirs = path_dirs();
    let extra = extra_dirs(tool);
    dirs.extend(extra.iter().cloned());
    let mut out = Vec::new();
    for name in names(tool) {
        for dir in &dirs {
            let Some(path) = executable(dir, name) else { continue };
            // Windows Store "python" aliases open the Store instead of running.
            if path.to_string_lossy().contains("WindowsApps") {
                continue;
            }
            #[cfg(target_os = "macos")]
            if path.starts_with("/usr/bin") && !extra.iter().any(|d| d == Path::new("/usr/bin")) {
                continue;
            }
            let prefix: Vec<String> = if *name == "py" { vec!["-3".into()] } else { vec![] };
            out.push((path, prefix));
        }
    }
    out
}

fn detect(tool: &str) -> Option<Toolchain> {
    possible(tool).into_iter().find_map(|(path, prefix)| {
        let version = probe_version(tool, &path, &prefix)?;
        Some(Toolchain { tool: tool.to_string(), path: path.to_string_lossy().into_owned(), prefix_args: prefix, version })
    })
}

/// Every working copy of `tool` (for "Select Interpreter"), duplicates (symlinks) removed.
pub fn candidates(tool: &str) -> Vec<Toolchain> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (path, prefix) in possible(tool) {
        let real = dunce::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !seen.insert((real, prefix.clone())) {
            continue;
        }
        if let Some(version) = probe_version(tool, &path, &prefix) {
            out.push(Toolchain { tool: tool.to_string(), path: path.to_string_lossy().into_owned(), prefix_args: prefix, version });
        }
    }
    out
}

fn detect_all() -> HashMap<String, Toolchain> {
    // Probing spawns processes; do the tools in parallel.
    let handles: Vec<_> = TOOLS
        .iter()
        .map(|t| std::thread::spawn(move || detect(t)))
        .collect();
    let found: HashMap<_, _> = handles
        .into_iter()
        .filter_map(|h| h.join().ok().flatten())
        .map(|t| (t.tool.clone(), t))
        .collect();
    log::info!(
        "toolchains: {}",
        found.values().map(|t| format!("{}={} ({})", t.tool, t.path, t.version)).collect::<Vec<_>>().join("; ")
    );
    found
}

impl Toolchains {
    /// Uses `tc` for its tool from now on (until the next refresh).
    pub fn select(&self, tc: Toolchain) {
        let mut guard = self.0.lock().unwrap();
        guard.get_or_insert_with(detect_all).insert(tc.tool.clone(), tc);
    }
}

#[tauri::command]
pub async fn toolchains_candidates(tool: String) -> Result<Vec<Toolchain>, String> {
    if !TOOLS.contains(&tool.as_str()) {
        return Err(format!("Unknown tool '{tool}'."));
    }
    tauri::async_runtime::spawn_blocking(move || candidates(&tool)).await.map_err(|e| e.to_string())
}

/// "Select Interpreter": only a copy `candidates` found can be chosen (never an arbitrary program).
#[tauri::command]
pub async fn toolchains_select(app: tauri::AppHandle, tool: String, path: String) -> Result<Toolchain, String> {
    use tauri::Manager;
    if !TOOLS.contains(&tool.as_str()) {
        return Err(format!("Unknown tool '{tool}'."));
    }
    let tc = tauri::async_runtime::spawn_blocking(move || candidates(&tool).into_iter().find(|t| t.path == path))
        .await
        .map_err(|e| e.to_string())?
        .ok_or("That program is not a usable toolchain on this computer.")?;
    log::info!("toolchains: selected {}={} ({})", tc.tool, tc.path, tc.version);
    app.state::<Toolchains>().select(tc.clone());
    Ok(tc)
}

#[tauri::command]
pub fn toolchains_detect(state: tauri::State<'_, Toolchains>, refresh: bool) -> Vec<Toolchain> {
    state.all(refresh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_keys_sort_numerically() {
        let mut v = vec!["v9.1.0", "v18.20.1", "v22.3.0"];
        v.sort_by_key(|s| version_key(s));
        assert_eq!(v, vec!["v9.1.0", "v18.20.1", "v22.3.0"]);
    }

    #[test]
    fn candidates_include_the_detected_tool_once() {
        for tool in TOOLS {
            let Some(found) = detect(tool) else { continue };
            let all = candidates(tool);
            assert!(all.iter().any(|c| c.path == found.path), "{tool}: {all:?}");
            let mut reals: Vec<_> = all.iter().map(|c| dunce::canonicalize(&c.path).unwrap()).collect();
            let n = reals.len();
            reals.dedup();
            assert_eq!(reals.len(), n, "{tool}: duplicates in {all:?}");
        }
    }

    #[test]
    fn detection_finds_real_tools_with_versions() {
        // Whatever this machine has must come back with a version line.
        for t in detect_all().values() {
            assert!(!t.version.is_empty(), "{t:?}");
            assert!(Path::new(&t.path).is_file(), "{t:?}");
        }
    }
}
