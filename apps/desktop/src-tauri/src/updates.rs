//! In-app updates from GitHub Releases (`latest.json`, minisign-signed).
//! The workbench decides *when* (automatic checks, the manual command, never
//! during an exam); this module only checks, downloads and installs.

use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Progress {
    Started { total: Option<u64> },
    Chunk { downloaded: u64, total: Option<u64> },
    Installing,
}

#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| format!("Could not check for updates: {e}"))?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    });
    if let Some(u) = &update {
        log::info!("update available: {} -> {}", u.current_version, u.version);
    }
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

/// Downloads, verifies (signature), installs and restarts.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>, on_progress: Channel<Progress>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("No update has been found yet. Check for updates first.")?;
    let mut downloaded: u64 = 0;
    let mut started = false;
    let progress = on_progress.clone();
    update
        .download_and_install(
            move |chunk, total| {
                if !started {
                    started = true;
                    let _ = progress.send(Progress::Started { total });
                }
                downloaded += chunk as u64;
                let _ = progress.send(Progress::Chunk { downloaded, total });
            },
            move || {
                let _ = on_progress.send(Progress::Installing);
            },
        )
        .await
        .map_err(|e| format!("The update could not be installed: {e}"))?;
    log::info!("update installed; restarting");
    app.restart();
}
