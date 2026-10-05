//! Integrated terminal (Practice mode only; exam policy removes the view and
//! the server never sees a shell). One login shell per terminal, started in
//! the workspace folder, streamed to xterm.js over a Tauri Channel.

use crate::workspace::Workspace;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
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

fn default_shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        cmd
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-l");
        cmd
    }
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
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    let pty = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = default_shell();
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
    log::info!("terminal {id} started");
    Ok(id)
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
    use super::take_utf8;

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
