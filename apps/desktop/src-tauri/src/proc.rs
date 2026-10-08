//! One-shot commands with their output captured, for the Testing view's
//! framework runs (pytest, mvn test, go test -json …): the command runs in
//! the user's login shell (so PATH matches their terminal), inside the open
//! folder, and streams stdout/stderr back. Refused in exam folders.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::runner::{Tree, INHERITED_NOISE};
use crate::workspace::Workspace;

#[derive(Default)]
pub struct Procs {
    next: AtomicU32,
    trees: Mutex<HashMap<u32, Tree>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ProcEvent {
    Stdout { data: String },
    Stderr { data: String },
    Exit { code: Option<i32> },
}

/// `cwd` relative to the workspace root, never outside it.
pub(crate) fn resolve_cwd(root: &Path, cwd: Option<&str>) -> Result<PathBuf, String> {
    let rel = Path::new(cwd.unwrap_or(""));
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)) {
        return Err("The command must run inside the open folder.".into());
    }
    Ok(root.join(rel))
}

/// The login shell running `command` (`$SHELL -lc` on macOS/Linux, `cmd /C` on Windows).
pub(crate) fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.args(["/D", "/S", "/C", command]);
        c
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
        let mut c = Command::new(shell);
        c.args(["-lc", command]);
        c
    }
}

#[tauri::command]
pub fn proc_run(app: AppHandle, ws: State<'_, Workspace>, procs: State<'_, Procs>, command: String, cwd: Option<String>, on_event: Channel<ProcEvent>) -> Result<u32, String> {
    if crate::debug::in_exam(&app, &ws) {
        return Err("Running commands is turned off during exams.".into());
    }
    let root = ws.root().map_err(|e| e.to_string())?;
    let dir = resolve_cwd(&root, cwd.as_deref())?;
    let mut c = shell_command(&command);
    c.current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("CI", "1")
        .env("FORCE_COLOR", "0")
        .env("NO_COLOR", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1");
    for var in INHERITED_NOISE {
        c.env_remove(var);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = c.spawn().map_err(|e| format!("Could not start the command: {e}"))?;
    let id = procs.next.fetch_add(1, Ordering::Relaxed) + 1;
    procs.trees.lock().unwrap().insert(id, Tree::of(child.id()));
    log::info!("proc {id}: {command} (in {})", dir.display());

    let pump = |mut r: Box<dyn Read + Send>, ch: Channel<ProcEvent>, err: bool| {
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending = Vec::new();
            loop {
                match r.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let data = crate::pty::take_utf8(&mut pending);
                        if !data.is_empty() {
                            let _ = ch.send(if err { ProcEvent::Stderr { data } } else { ProcEvent::Stdout { data } });
                        }
                    }
                }
            }
        })
    };
    let out = pump(Box::new(child.stdout.take().ok_or("no stdout")?), on_event.clone(), false);
    let err = pump(Box::new(child.stderr.take().ok_or("no stderr")?), on_event.clone(), true);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        let _ = out.join();
        let _ = err.join();
        use tauri::Manager;
        app2.state::<Procs>().trees.lock().unwrap().remove(&id);
        let _ = on_event.send(ProcEvent::Exit { code: status.ok().and_then(|s| s.code()) });
    });
    Ok(id)
}

#[tauri::command]
pub fn proc_kill(procs: State<'_, Procs>, id: u32) {
    if let Some(tree) = procs.trees.lock().unwrap().remove(&id) {
        tree.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_stays_inside_the_folder() {
        let root = Path::new("/ws");
        assert_eq!(resolve_cwd(root, None).unwrap(), PathBuf::from("/ws"));
        assert_eq!(resolve_cwd(root, Some("server")).unwrap(), PathBuf::from("/ws/server"));
        assert!(resolve_cwd(root, Some("../etc")).is_err());
        assert!(resolve_cwd(root, Some("/etc")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn runs_in_the_login_shell() {
        let out = shell_command("echo $((6 * 7))").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "42");
    }
}
