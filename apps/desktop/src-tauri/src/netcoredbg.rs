//! netcoredbg (Samsung, MIT): the open-source .NET debugger that speaks DAP
//! (`--interpreter=vscode`). Downloaded once per version into the app data
//! folder, pinned by SHA-256 like js-debug. There is no build for Intel Macs.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::debug::InstallEvent;

pub const VERSION: &str = "3.2.0-1092";

/// (asset file name, sha256) for this computer, from the release's published digests.
pub fn asset() -> Option<(&'static str, &'static str)> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some(("netcoredbg-osx-arm64.zip", "f4fa33b3ff874910cc184b4bb3b9c56d0abdf5c6521cee0b144d7c6e4a6e59ea"))
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some(("netcoredbg-linux-amd64.tar.gz", "080eb3b2d2152465f599d3b33d1ee6e747794e11cc0a3773ec689f5e5f2c5afa"))
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some(("netcoredbg-linux-arm64.tar.gz", "065ff49badec8a695dbea2de6ab6a330c774a191e426a217ab8cc05250627ccb"))
    } else if cfg!(all(windows, target_arch = "x86_64")) {
        Some(("netcoredbg-win64.zip", "3c410a45fa502415203a94fcb88654af65bf8e3dac158a5527a722e7a6b9274a"))
    } else {
        None
    }
}

pub fn url(asset: &str) -> String {
    format!("https://github.com/Samsung/netcoredbg/releases/download/{VERSION}/{asset}")
}

pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::debug::app_data(app)?.join("debug-adapters").join("netcoredbg").join(VERSION))
}

/// The executable inside an unpacked release (`netcoredbg/netcoredbg[.exe]`).
pub fn binary(dir: &Path) -> PathBuf {
    dir.join("netcoredbg").join(if cfg!(windows) { "netcoredbg.exe" } else { "netcoredbg" })
}

pub fn installed(app: &AppHandle) -> Option<PathBuf> {
    dir(app).ok().map(|d| binary(&d)).filter(|b| b.is_file())
}

pub fn missing_message() -> String {
    match asset() {
        Some(_) => "Debugging C# needs netcoredbg, the open-source .NET debugger (about 3.4 MB), downloaded once.".into(),
        None => "netcoredbg, the .NET debugger, has no build for this computer (Intel Macs are not supported). Use Run (Ctrl+F5) instead.".into(),
    }
}

pub async fn install(app: &AppHandle, on_event: &Channel<InstallEvent>) -> Result<(), String> {
    use sha2::Digest;
    use tauri_plugin_http::reqwest;
    let (name, sha) = asset().ok_or_else(missing_message)?;
    let dest = dir(app)?;
    if binary(&dest).is_file() {
        return Ok(());
    }
    let url = url(name);
    log::info!("debug: downloading {url}");
    let mut res = reqwest::Client::new().get(&url).send().await.map_err(|e| format!("Could not download the .NET debugger: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Could not download the .NET debugger (HTTP {}).", res.status()));
    }
    let total = res.content_length();
    let mut bytes = Vec::with_capacity(total.unwrap_or(3_500_000) as usize);
    let mut last = Instant::now();
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("Download interrupted: {e}"))? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("The .NET debugger download is unexpectedly large.".into());
        }
        if last.elapsed() > Duration::from_millis(80) {
            last = Instant::now();
            let _ = on_event.send(InstallEvent::Progress { downloaded: bytes.len() as u64, total });
        }
    }
    let _ = on_event.send(InstallEvent::Progress { downloaded: bytes.len() as u64, total });
    let digest = hex::encode(sha2::Sha256::digest(&bytes));
    if digest != sha {
        log::warn!("debug: netcoredbg checksum mismatch: {digest}");
        return Err("The downloaded .NET debugger failed its integrity check and was discarded.".into());
    }
    let zip = name.ends_with(".zip");
    let dest2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || unpack(&bytes, zip, &dest2)).await.map_err(|e| e.to_string())??;
    log::info!("debug: netcoredbg {VERSION} installed at {}", dest.display());
    Ok(())
}

/// Unpacks into a temporary sibling, checks the executable is there, then moves it in place.
pub fn unpack(bytes: &[u8], zip: bool, dest: &Path) -> Result<(), String> {
    let parent = dest.parent().ok_or("bad destination")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".partial-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = if zip { unpack_zip(bytes, &tmp) } else { unpack_tar_gz(bytes, &tmp) };
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let exe = binary(&tmp);
    if !exe.is_file() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("The .NET debugger archive does not contain netcoredbg.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

fn unpack_zip(bytes: &[u8], into: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name refuses absolute paths and `..`; macOS archives carry __MACOSX metadata.
        let Some(rel) = f.enclosed_name() else { return Err("The debugger archive contains unsafe paths.".into()) };
        if rel.starts_with("__MACOSX") {
            continue;
        }
        let out = into.join(&rel);
        if f.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut data = Vec::new();
        f.read_to_end(&mut data).map_err(|e| e.to_string())?;
        std::fs::write(&out, data).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if let Some(mode) = f.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode & 0o777));
        }
    }
    Ok(())
}

fn unpack_tar_gz(bytes: &[u8], into: &Path) -> Result<(), String> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        if !entry.unpack_in(into).map_err(|e| e.to_string())? {
            return Err("The debugger archive contains unsafe paths.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_an_asset_for_this_computer() {
        if let Some((name, sha)) = asset() {
            assert!(url(name).starts_with("https://github.com/Samsung/netcoredbg/releases/download/3.2.0-1092/netcoredbg-"));
            assert_eq!(sha.len(), 64);
        }
    }

    #[test]
    fn unpacks_a_zip_and_refuses_one_without_the_debugger() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let make = |names: &[&str]| {
            let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
            for n in names {
                w.start_file(*n, SimpleFileOptions::default().unix_permissions(0o644)).unwrap();
                w.write_all(b"x").unwrap();
            }
            w.finish().unwrap().into_inner()
        };
        let base = std::env::temp_dir().join(format!("tm-ncdbg-{}", std::process::id()));
        let dest = base.join("3.2.0");
        let exe = if cfg!(windows) { "netcoredbg/netcoredbg.exe" } else { "netcoredbg/netcoredbg" };
        unpack(&make(&[exe, "netcoredbg/ManagedPart.dll", "__MACOSX/netcoredbg/._netcoredbg"]), true, &dest).unwrap();
        assert!(binary(&dest).is_file());
        assert!(!dest.join("__MACOSX").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(binary(&dest)).unwrap().permissions().mode() & 0o111, 0o111);
        }
        assert!(unpack(&make(&["other/readme.txt"]), true, &base.join("bad")).unwrap_err().contains("does not contain"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// TM_NCDBG_ARCHIVE=<downloaded release> cargo test real_release -- --ignored
    #[test]
    #[ignore]
    fn real_release_unpacks_and_starts() {
        use sha2::Digest;
        let path = std::env::var("TM_NCDBG_ARCHIVE").expect("TM_NCDBG_ARCHIVE");
        let bytes = std::fs::read(&path).unwrap();
        let (name, sha) = asset().unwrap();
        assert!(path.ends_with(name));
        assert_eq!(hex::encode(sha2::Sha256::digest(&bytes)), sha);
        let dest = std::env::temp_dir().join(format!("tm-ncdbg-real-{}", std::process::id())).join(VERSION);
        unpack(&bytes, name.ends_with(".zip"), &dest).unwrap();
        let out = std::process::Command::new(binary(&dest)).arg("--version").output().unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("NET Core debugger"), "{}", String::from_utf8_lossy(&out.stdout));
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }
}
