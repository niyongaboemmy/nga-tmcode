//! Integrated terminal (Practice mode only; exam policy removes the view and
//! the server never sees a shell). One login shell per terminal, started in
//! the workspace folder, streamed to xterm.js over a Tauri Channel.

use crate::workspace::Workspace;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

impl Terminals {
    pub fn kill_all(&self) {
        for (_, mut s) in self.sessions.lock().unwrap().drain() {
            let _ = s.child.kill();
        }
    }
}

/// A shell found on this computer, like VS Code's terminal profiles.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Profile {
    /// "zsh", "bash", "fish", "powershell", "pwsh", "cmd", "gitbash", "wsl", or the $SHELL's file name.
    pub id: String,
    /// Shown on the terminal tab and in the profile menu.
    pub name: String,
    pub path: String,
    #[serde(skip)]
    pub args: Vec<String>,
    /// The system's shell ($SHELL; PowerShell on Windows).
    pub is_default: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Os {
    Unix,
    Windows,
}

fn profile(id: &str, name: &str, path: &Path, args: &[&str]) -> Profile {
    Profile {
        id: id.into(),
        name: name.into(),
        path: path.to_string_lossy().into_owned(),
        args: args.iter().map(|a| a.to_string()).collect(),
        is_default: false,
    }
}

/// The first of `candidates`, or of `exe` on PATH, that exists.
fn find(candidates: &[PathBuf], exe: &str, path_var: Option<&str>, sep: char, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.iter().find(|p| exists(p)).cloned().or_else(|| {
        path_var?.split(sep).filter(|d| !d.is_empty()).map(|d| Path::new(d).join(exe)).find(|p| exists(p))
    })
}

/// Shells installed on this computer. Pure (environment and file checks are
/// passed in) so both OS lists are tested on any machine.
pub fn detect_profiles(os: Os, env: &dyn Fn(&str) -> Option<String>, exists: &dyn Fn(&Path) -> bool) -> Vec<Profile> {
    let path_var = env("PATH");
    let mut out = Vec::new();
    match os {
        Os::Unix => {
            let sep = ':';
            let unix = |names: &[&str]| -> Vec<PathBuf> {
                names.iter().flat_map(|n| ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map(|d| Path::new(d).join(n))).collect()
            };
            for (id, args) in [("zsh", ["-l"]), ("bash", ["-l"]), ("fish", ["-l"])] {
                if let Some(p) = find(&unix(&[id]), id, path_var.as_deref(), sep, exists) {
                    out.push(profile(id, id, &p, &args));
                }
            }
            // $SHELL decides the default; a shell not in the list above (nu, tcsh…) is added.
            let shell = env("SHELL").filter(|s| !s.is_empty()).map(PathBuf::from);
            let default_id = match shell {
                Some(s) if exists(&s) => {
                    let id = s.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    if let Some(known) = out.iter_mut().find(|p| p.id == id) {
                        // Prefer the exact $SHELL binary (Homebrew bash over /bin/bash).
                        known.path = s.to_string_lossy().into_owned();
                    } else if !id.is_empty() {
                        out.push(profile(&id, &id, &s, &["-l"]));
                    }
                    Some(id)
                }
                _ => None,
            };
            let default_id = default_id.or_else(|| out.iter().find(|p| p.id == "zsh" || p.id == "bash").map(|p| p.id.clone()));
            for p in out.iter_mut() {
                p.is_default = Some(&p.id) == default_id.as_ref();
            }
        }
        Os::Windows => {
            let sep = ';';
            let root = env("SystemRoot").or_else(|| env("windir")).unwrap_or_else(|| "C:\\Windows".into());
            let sys32 = Path::new(&root).join("System32");
            let program_files: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"].iter().filter_map(|k| env(k)).map(PathBuf::from).collect();
            let local = env("LOCALAPPDATA").map(PathBuf::from);

            let powershell = sys32.join("WindowsPowerShell").join("v1.0").join("powershell.exe");
            if exists(&powershell) {
                out.push(profile("powershell", "PowerShell", &powershell, &["-NoLogo"]));
            }
            let mut pwsh_candidates: Vec<PathBuf> = program_files.iter().map(|p| p.join("PowerShell").join("7").join("pwsh.exe")).collect();
            if let Some(l) = &local {
                pwsh_candidates.push(l.join("Microsoft").join("WindowsApps").join("pwsh.exe"));
            }
            if let Some(p) = find(&pwsh_candidates, "pwsh.exe", path_var.as_deref(), sep, exists) {
                out.push(profile("pwsh", "PowerShell 7", &p, &["-NoLogo"]));
            }
            let cmd = env("ComSpec").map(PathBuf::from).filter(|p| exists(p)).unwrap_or_else(|| sys32.join("cmd.exe"));
            if exists(&cmd) {
                out.push(profile("cmd", "Command Prompt", &cmd, &[]));
            }
            let mut git_candidates: Vec<PathBuf> = program_files.iter().map(|p| p.join("Git").join("bin").join("bash.exe")).collect();
            if let Some(l) = &local {
                git_candidates.push(l.join("Programs").join("Git").join("bin").join("bash.exe"));
            }
            if let Some(p) = git_candidates.iter().find(|p| exists(p)) {
                out.push(profile("gitbash", "Git Bash", p, &["--login", "-i"]));
            }
            let wsl = sys32.join("wsl.exe");
            if exists(&wsl) {
                out.push(profile("wsl", "WSL", &wsl, &[]));
            }
            let default = if out.iter().any(|p| p.id == "powershell") { "powershell" } else { out.first().map(|p| p.id.as_str()).unwrap_or("") }.to_string();
            for p in out.iter_mut() {
                p.is_default = p.id == default;
            }
        }
    }
    out
}

fn this_os() -> Os {
    if cfg!(windows) {
        Os::Windows
    } else {
        Os::Unix
    }
}

fn system_profiles() -> Vec<Profile> {
    detect_profiles(this_os(), &|k| std::env::var(k).ok(), &|p| p.is_file())
}

/// The shell to start: the profile asked for when it is installed (never an
/// arbitrary path from the webview), else the system's default.
fn shell_command(requested: Option<&str>) -> (CommandBuilder, String) {
    let profiles = system_profiles();
    let chosen = requested
        .and_then(|id| profiles.iter().find(|p| p.id == id))
        .or_else(|| profiles.iter().find(|p| p.is_default))
        .or_else(|| profiles.first());
    match chosen {
        Some(p) => {
            let mut cmd = CommandBuilder::new(&p.path);
            for a in &p.args {
                cmd.arg(a);
            }
            (cmd, p.name.clone())
        }
        None => {
            #[cfg(windows)]
            {
                let mut cmd = CommandBuilder::new("powershell.exe");
                cmd.arg("-NoLogo");
                (cmd, "PowerShell".into())
            }
            #[cfg(not(windows))]
            {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
                let name = Path::new(&shell).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "sh".into());
                let mut cmd = CommandBuilder::new(shell);
                cmd.arg("-l");
                (cmd, name)
            }
        }
    }
}

#[tauri::command]
pub fn pty_profiles() -> Vec<Profile> {
    system_profiles()
}

/// Splits `buf` at the last complete UTF-8 character, keeping the rest for the
/// next read, so multi-byte characters split across reads are never mangled.
pub(crate) fn take_utf8(pending: &mut Vec<u8>) -> String {
    let valid_up_to = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => pending.len(), // genuinely invalid bytes: let lossy conversion handle them
    };
    let rest = pending.split_off(valid_up_to);
    let text = String::from_utf8_lossy(pending).into_owned();
    *pending = rest;
    text
}

#[tauri::command]
pub fn pty_spawn(
    ws: State<'_, Workspace>,
    terms: State<'_, Terminals>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    profile: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    let pty = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let (mut cmd, shell_name) = shell_command(profile.as_deref());
    if let Ok(root) = ws.root() {
        // Tasks run in a project subfolder (client/, server/…); it must stay inside the workspace.
        let dir = match cwd.as_deref().filter(|c| !c.is_empty()) {
            Some(rel) => crate::workspace::resolve(&root, rel)?,
            None => root,
        };
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "TMCode");
    // Colour output by default (ls, grep, git) — like VS Code's integrated terminal.
    cmd.env("CLICOLOR", "1");
    cmd.env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()));
    let child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let id = terms.next.fetch_add(1, Ordering::Relaxed) + 1;

    std::thread::Builder::new()
        .name(format!("pty-{id}"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let data = take_utf8(&mut pending);
                        if !data.is_empty() && on_event.send(PtyEvent::Data { data }).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = on_event.send(PtyEvent::Exit { code: None });
        })
        .map_err(|e| e.to_string())?;

    terms.sessions.lock().unwrap().insert(id, Session { master: pty.master, writer, child });
    log::info!("terminal {id} started ({shell_name})");
    Ok(id)
}

/// A program other than the shell runs in the terminal (its foreground process
/// group isn't the shell's). Unknown on Windows: false.
#[tauri::command]
pub fn pty_busy(terms: State<'_, Terminals>, id: u32) -> bool {
    let sessions = terms.sessions.lock().unwrap();
    let Some(s) = sessions.get(&id) else { return false };
    #[cfg(unix)]
    {
        match (s.master.process_group_leader(), s.child.process_id()) {
            (Some(leader), Some(pid)) => leader as i64 != pid as i64,
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = s;
        false
    }
}

#[tauri::command]
pub fn pty_write(terms: State<'_, Terminals>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = terms.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("Terminal is closed")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(terms: State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = terms.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("Terminal is closed")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(terms: State<'_, Terminals>, id: u32) -> Result<(), String> {
    if let Some(mut s) = terms.sessions.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{detect_profiles, take_utf8, Os};
    use std::collections::HashSet;
    use std::path::Path;

    fn fs(files: &[&str]) -> impl Fn(&Path) -> bool {
        let set: HashSet<String> = files.iter().map(|f| f.replace('\\', "/")).collect();
        move |p: &Path| set.contains(&p.to_string_lossy().replace('\\', "/"))
    }

    #[test]
    fn macos_lists_installed_shells_and_marks_shell_as_default() {
        let env = |k: &str| match k {
            "SHELL" => Some("/opt/homebrew/bin/bash".to_string()),
            "PATH" => Some("/usr/bin:/bin".to_string()),
            _ => None,
        };
        let exists = fs(&["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/bash", "/opt/homebrew/bin/fish"]);
        let p = detect_profiles(Os::Unix, &env, &exists);
        let ids: Vec<&str> = p.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["zsh", "bash", "fish"]);
        let bash = p.iter().find(|p| p.id == "bash").unwrap();
        assert!(bash.is_default);
        assert_eq!(bash.path, "/opt/homebrew/bin/bash");
        assert_eq!(p.iter().filter(|p| p.is_default).count(), 1);
    }

    #[test]
    fn unix_adds_an_unknown_login_shell_and_falls_back_without_shell() {
        let env = |k: &str| (k == "SHELL").then(|| "/usr/local/bin/nu".to_string());
        let p = detect_profiles(Os::Unix, &env, &fs(&["/bin/zsh", "/usr/local/bin/nu"]));
        assert_eq!(p.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["zsh", "nu"]);
        assert!(p[1].is_default);
        let none = |_: &str| None;
        let p = detect_profiles(Os::Unix, &none, &fs(&["/usr/bin/bash"]));
        assert_eq!(p.len(), 1);
        assert!(p[0].is_default, "bash is the default when $SHELL is unset");
    }

    #[test]
    fn windows_finds_powershell_pwsh_cmd_git_bash_and_wsl() {
        let env = |k: &str| match k {
            "SystemRoot" => Some("C:\\Windows".to_string()),
            "ProgramFiles" => Some("C:\\Program Files".to_string()),
            "ComSpec" => Some("C:\\Windows\\System32\\cmd.exe".to_string()),
            "PATH" => Some("C:\\Windows\\System32".to_string()),
            _ => None,
        };
        let exists = fs(&[
            "C:\\Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
            "C:\\Program Files/PowerShell/7/pwsh.exe",
            "C:\\Windows\\System32\\cmd.exe",
            "C:\\Program Files/Git/bin/bash.exe",
            "C:\\Windows/System32/wsl.exe",
        ]);
        let p = detect_profiles(Os::Windows, &env, &exists);
        let names: Vec<&str> = p.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["PowerShell", "PowerShell 7", "Command Prompt", "Git Bash", "WSL"]);
        assert!(p[0].is_default);
        assert_eq!(p.iter().find(|p| p.id == "gitbash").unwrap().args, ["--login", "-i"]);
    }

    #[test]
    fn windows_without_git_or_wsl_lists_only_what_exists() {
        let env = |k: &str| (k == "SystemRoot").then(|| "C:\\Windows".to_string());
        let p = detect_profiles(Os::Windows, &env, &fs(&["C:\\Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "C:\\Windows/System32/cmd.exe"]));
        assert_eq!(p.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["powershell", "cmd"]);
    }

    #[test]
    fn keeps_split_multibyte_characters_for_the_next_read() {
        let mut pending = "héllo".as_bytes().to_vec();
        pending.truncate(2); // "h" + first byte of "é"
        assert_eq!(take_utf8(&mut pending), "h");
        assert_eq!(pending.len(), 1);
        pending.extend_from_slice(&"é".as_bytes()[1..]);
        assert_eq!(take_utf8(&mut pending), "é");
        assert!(pending.is_empty());
    }
}
