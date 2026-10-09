//! PHP Debug (xdebug/vscode-php-debug, MIT): the DAP adapter VS Code uses for
//! PHP. TMCode downloads its .vsix once from Open VSX (pinned by SHA-256),
//! keeps the `extension/` folder and runs `node extension/out/phpDebug.js`.
//! PHP itself needs the Xdebug extension (pecl install xdebug).

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::debug::InstallEvent;

pub const VERSION: &str = "1.40.2";
const SHA256: &str = "17631993fe800083a2fc89a6782c8bf58a79603ad201ddff60d9b59ba2345d5f";

pub fn url() -> String {
    format!("https://open-vsx.org/api/xdebug/php-debug/{VERSION}/file/xdebug.php-debug-{VERSION}.vsix")
}

pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::debug::app_data(app)?.join("debug-adapters").join("php-debug").join(VERSION))
}

pub fn script(dir: &Path) -> PathBuf {
    dir.join("extension").join("out").join("phpDebug.js")
}

pub fn installed(app: &AppHandle) -> Option<PathBuf> {
    dir(app).ok().map(|d| script(&d)).filter(|s| s.is_file())
}

pub async fn install(app: &AppHandle, on_event: &Channel<InstallEvent>) -> Result<(), String> {
    use sha2::Digest;
    use tauri_plugin_http::reqwest;
    let dest = dir(app)?;
    if script(&dest).is_file() {
        return Ok(());
    }
    let url = url();
    log::info!("debug: downloading {url}");
    let mut res = reqwest::Client::new().get(&url).send().await.map_err(|e| format!("Could not download the PHP debugger: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Could not download the PHP debugger (HTTP {}).", res.status()));
    }
    let total = res.content_length();
    let mut bytes = Vec::with_capacity(total.unwrap_or(1_800_000) as usize);
    let mut last = Instant::now();
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("Download interrupted: {e}"))? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("The PHP debugger download is unexpectedly large.".into());
        }
        if last.elapsed() > Duration::from_millis(80) {
            last = Instant::now();
            let _ = on_event.send(InstallEvent::Progress { downloaded: bytes.len() as u64, total });
        }
    }
    let _ = on_event.send(InstallEvent::Progress { downloaded: bytes.len() as u64, total });
    let digest = hex::encode(sha2::Sha256::digest(&bytes));
    if digest != SHA256 {
        log::warn!("debug: php-debug checksum mismatch: {digest}");
        return Err("The downloaded PHP debugger failed its integrity check and was discarded.".into());
    }
    let dest2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || unpack(&bytes, &dest2)).await.map_err(|e| e.to_string())??;
    log::info!("debug: php-debug {VERSION} installed at {}", dest.display());
    Ok(())
}

/// Keeps the vsix's `extension/` folder (adapter + its bundled node_modules).
pub fn unpack(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let parent = dest.parent().ok_or("bad destination")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".partial-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "The PHP debugger download is not a .vsix file.".to_string())?;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name() else {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("The debugger archive contains unsafe paths.".into());
        };
        if !rel.starts_with("extension") || f.is_dir() {
            continue;
        }
        let out = tmp.join(&rel);
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut data = Vec::new();
        f.read_to_end(&mut data).map_err(|e| e.to_string())?;
        std::fs::write(&out, data).map_err(|e| e.to_string())?;
    }
    if !script(&tmp).is_file() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("The PHP debugger archive does not contain out/phpDebug.js.".into());
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_extension_folder() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for n in ["extension.vsixmanifest", "extension/package.json", "extension/out/phpDebug.js", "extension/node_modules/x/index.js"] {
            w.start_file(n, SimpleFileOptions::default()).unwrap();
            w.write_all(b"x").unwrap();
        }
        let bytes = w.finish().unwrap().into_inner();
        let base = std::env::temp_dir().join(format!("tm-phpdbg-{}", std::process::id()));
        let dest = base.join(VERSION);
        unpack(&bytes, &dest).unwrap();
        assert!(script(&dest).is_file());
        assert!(dest.join("extension/node_modules/x/index.js").is_file());
        assert!(!dest.join("extension.vsixmanifest").exists());
        let _ = std::fs::remove_dir_all(&base);
        assert!(url().ends_with("/xdebug/php-debug/1.40.2/file/xdebug.php-debug-1.40.2.vsix"));
    }
}
