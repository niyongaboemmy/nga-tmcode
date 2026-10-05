//! Exam support on the desktop (plan §10, §13): a stable device id, one folder
//! per exam attempt, and the crash-safe snapshot journal.
//!
//! The journal is one append-only JSON-lines file per session, fsynced on
//! every append (`<app data>/journal/<session>.jsonl`), plus a small file
//! holding the highest seq Task Mentor has confirmed. A crash or power cut
//! loses at most the snapshot being written.

use crate::workspace::Workspace;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

fn app_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(sub);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Session ids are UUIDs from Task Mentor; anything else could be a path trick.
pub fn valid_session_id(sid: &str) -> bool {
    sid.len() == 36 && sid.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[derive(Serialize)]
pub struct Device {
    id: String,
    os: &'static str,
    os_version: String,
    arch: &'static str,
    app_version: &'static str,
}

fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    {
        String::new()
    }
}

/// A random id per installation (not a hardware fingerprint), created once.
pub fn device_id(dir: &Path) -> Result<String, String> {
    let file = dir.join("device-id");
    if let Ok(id) = fs::read_to_string(&file) {
        let id = id.trim().to_string();
        if valid_session_id(&id) {
            return Ok(id);
        }
    }
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let id = format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]);
    fs::write(&file, &id).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn exam_device(app: AppHandle) -> Result<Device, String> {
    Ok(Device {
        id: device_id(&app_dir(&app, "")?)?,
        os: if cfg!(target_os = "macos") { "mac" } else if cfg!(windows) { "windows" } else { "linux" },
        os_version: os_version(),
        arch: std::env::consts::ARCH,
        app_version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Serialize)]
pub struct Opened {
    name: String,
    root: String,
}

/// Creates (once) and opens `<app data>/exams/<submission>` as the workspace.
#[tauri::command]
pub fn exam_workspace(app: AppHandle, ws: State<'_, Workspace>, submission_id: u64, title: String) -> Result<Opened, String> {
    let dir = app_dir(&app, "exams")?.join(submission_id.to_string());
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let root = dunce::canonicalize(&dir).map_err(|e| e.to_string())?;
    ws.set_root(root.clone());
    log::info!("exam workspace {}", root.display());
    Ok(Opened { name: title, root: root.display().to_string() })
}

// ───────────────────────── journal ─────────────────────────

pub fn journal_paths(dir: &Path, sid: &str) -> Result<(PathBuf, PathBuf), String> {
    if !valid_session_id(sid) {
        return Err("Invalid session id".into());
    }
    Ok((dir.join(format!("{sid}.jsonl")), dir.join(format!("{sid}.synced"))))
}

/// Entries as raw JSON values with `synced` filled in from the synced marker.
/// A torn last line (crash mid-write) is ignored.
pub fn load(dir: &Path, sid: &str) -> Result<Vec<serde_json::Value>, String> {
    let (log, synced) = journal_paths(dir, sid)?;
    let upto: u64 = fs::read_to_string(&synced).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    let Ok(text) = fs::read_to_string(&log) else { return Ok(vec![]) };
    let mut out = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(mut v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let seq = v.get("seq").and_then(|s| s.as_u64()).unwrap_or(0);
        if let Some(obj) = v.as_object_mut() {
            obj.insert("synced".into(), serde_json::Value::Bool(seq <= upto));
        }
        out.push(v);
    }
    Ok(out)
}

pub fn append(dir: &Path, sid: &str, entry: &serde_json::Value) -> Result<(), String> {
    let (log, _) = journal_paths(dir, sid)?;
    let mut line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut f = OpenOptions::new().create(true).append(true).open(&log).map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())
}

pub fn mark_synced(dir: &Path, sid: &str, seq: u64) -> Result<(), String> {
    let (_, synced) = journal_paths(dir, sid)?;
    let current: u64 = fs::read_to_string(&synced).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    if seq > current {
        crate::workspace::write_file(dir, &synced.file_name().unwrap().to_string_lossy(), &seq.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn journal_load(app: AppHandle, session_id: String) -> Result<Vec<serde_json::Value>, String> {
    load(&app_dir(&app, "journal")?, &session_id)
}

#[tauri::command]
pub fn journal_append(app: AppHandle, session_id: String, entry: serde_json::Value) -> Result<(), String> {
    append(&app_dir(&app, "journal")?, &session_id, &entry)
}

#[tauri::command]
pub fn journal_mark_synced(app: AppHandle, session_id: String, seq: u64) -> Result<(), String> {
    mark_synced(&app_dir(&app, "journal")?, &session_id, seq)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SID: &str = "6b1f0f3e-5c55-4b7a-9d55-2d6f1d0a9e01";

    #[test]
    fn appends_survive_torn_writes_and_track_sync() {
        let d = tempfile::tempdir().unwrap();
        let dir = dunce::canonicalize(d.path()).unwrap();
        append(&dir, SID, &json!({"seq": 1, "hmac": "a"})).unwrap();
        append(&dir, SID, &json!({"seq": 2, "hmac": "b"})).unwrap();
        // A crash mid-append leaves a partial line.
        let (log, _) = journal_paths(&dir, SID).unwrap();
        OpenOptions::new().append(true).open(&log).unwrap().write_all(b"{\"seq\": 3, \"hm").unwrap();
        mark_synced(&dir, SID, 1).unwrap();
        let entries = load(&dir, SID).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["synced"], json!(true));
        assert_eq!(entries[1]["synced"], json!(false));
        mark_synced(&dir, SID, 0).unwrap(); // never goes backwards
        assert_eq!(load(&dir, SID).unwrap()[0]["synced"], json!(true));
    }

    #[test]
    fn refuses_session_ids_that_are_not_uuids() {
        let d = tempfile::tempdir().unwrap();
        assert!(append(d.path(), "../../etc/x", &json!({})).is_err());
        assert!(valid_session_id(SID));
    }

    #[test]
    fn device_id_is_stable() {
        let d = tempfile::tempdir().unwrap();
        let a = device_id(d.path()).unwrap();
        assert!(valid_session_id(&a));
        assert_eq!(device_id(d.path()).unwrap(), a);
    }
}
