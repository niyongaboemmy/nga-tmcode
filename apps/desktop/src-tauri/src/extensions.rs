//! VS Code extensions from Open VSX (declarative contributions only; no
//! extension code ever runs). The workbench searches the registry through
//! `ext_fetch`, and `ext_install` downloads a .vsix, unpacks its `extension/`
//! folder into `<app data>/extensions/<publisher.name>/` and returns its
//! package.json. Every network request is limited to https://open-vsx.org/,
//! and every file read stays inside the extension's folder.

use base64::Engine;
use serde::Serialize;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_http::reqwest;

pub const GALLERY: &str = "https://open-vsx.org/";
/// Largest .vsix we download, and the most it may unpack to (zip bombs). AI extensions ship their
/// agent as a native program: Claude Code's macOS build is 109 MB (248 MB unpacked), Gemini Code
/// Assist's 189 MB.
const MAX_DOWNLOAD: usize = 512 * 1024 * 1024;
const MAX_UNPACKED: u64 = 1024 * 1024 * 1024;

/// Open VSX's name for this computer ("darwin-arm64", "win32-x64", "linux-x64", "alpine-arm64"…).
pub fn target_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        _ if cfg!(target_env = "musl") => "alpine",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "arm" => "armhf",
        other => other,
    };
    format!("{os}-{arch}")
}

/// The .vsix to download: this computer's own build when the extension ships one per platform (an
/// AI extension's agent is a native program), else the universal one, else what the gallery gave.
pub fn pick_download(url: &str, downloads: Option<&std::collections::HashMap<String, String>>, target: &str) -> String {
    downloads
        .and_then(|d| d.get(target).or_else(|| d.get("universal")))
        .cloned()
        .unwrap_or_else(|| url.to_string())
}
/// Largest single file the workbench may read (themes, grammars, icons, README).
const MAX_READ: u64 = 20 * 1024 * 1024;

#[derive(Serialize, Debug)]
pub struct StoredExtension {
    id: String,
    version: String,
    manifest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    nls: Option<String>,
}

/// "publisher.name", lower-case: letters, digits, '-', '_' and single dots.
pub fn valid_id(id: &str) -> bool {
    id.len() <= 200
        && id.contains('.')
        && !id.starts_with('.')
        && !id.ends_with('.')
        && !id.contains("..")
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
}

pub fn allowed_url(url: &str) -> bool {
    url.starts_with(GALLERY) && !url.chars().any(|c| c.is_whitespace() || c == '\\') && !url[GALLERY.len()..].starts_with('/')
}

/// A path inside an extension ("themes/a.json"), or None if it could leave it.
pub fn safe_relative(rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.contains('\\') || rel.contains('\0') {
        return None;
    }
    let mut out = PathBuf::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("extensions");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Unpacks the `extension/` folder of a .vsix into `dest` (which must not exist yet).
pub fn unpack(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Not a .vsix (zip) file".to_string())?;
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("Corrupt .vsix: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let Some(rel) = name.strip_prefix("extension/").and_then(safe_relative) else { continue };
        total += entry.size();
        if total > MAX_UNPACKED {
            return Err("The .vsix is too large".into());
        }
        let path = dest.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&path).map_err(|e| e.to_string())?;
        // Never trust the declared size: copy at most that much (+1 to notice a lie).
        let declared = entry.size();
        let copied = std::io::copy(&mut (&mut entry).take(declared + 1), &mut out).map_err(|e| format!("Corrupt .vsix ({name}): {e}"))?;
        if copied > declared {
            return Err("Corrupt .vsix (sizes do not match)".into());
        }
        out.flush().map_err(|e| e.to_string())?;
        // Native programs (Claude Code's `claude`, Gemini's `cloudcode_cli`) must stay executable.
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            if mode & 0o111 != 0 {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            }
        }
    }
    if !dest.join("package.json").is_file() {
        return Err("The .vsix has no extension/package.json".into());
    }
    Ok(())
}

/// Reads an unpacked extension folder; `id` comes from its package.json.
pub fn read_stored(dir: &Path) -> Result<StoredExtension, String> {
    let manifest = fs::read_to_string(dir.join("package.json")).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(manifest.trim_start_matches('\u{feff}')).map_err(|e| format!("package.json: {e}"))?;
    let publisher = v.get("publisher").and_then(|x| x.as_str()).unwrap_or_default();
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or_default();
    let id = format!("{publisher}.{name}").to_lowercase();
    if !valid_id(&id) {
        return Err(format!("Invalid extension id '{id}'"));
    }
    Ok(StoredExtension {
        id,
        version: v.get("version").and_then(|x| x.as_str()).unwrap_or("0.0.0").to_string(),
        nls: fs::read_to_string(dir.join("package.nls.json")).ok(),
        manifest,
    })
}

pub fn list_in(root: &Path) -> Vec<StoredExtension> {
    let Ok(entries) = fs::read_dir(root) else { return vec![] };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        // Leftovers of an interrupted install (".tmp-…", ".old-…") are skipped.
        if !valid_id(&name) || !e.path().is_dir() {
            continue;
        }
        match read_stored(&e.path()) {
            Ok(s) if s.id == name => out.push(s),
            Ok(s) => log::warn!("extension folder {name} holds {}", s.id),
            Err(err) => log::warn!("extension {name}: {err}"),
        }
    }
    out
}

/// Unpacks into a temporary folder, checks the id, then swaps it in place of any older version.
/// A local .vsix ("Install from VSIX…"): its id comes from its own package.json.
pub fn install_vsix_bytes(root: &Path, bytes: &[u8]) -> Result<StoredExtension, String> {
    let mut nonce = [0u8; 6];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let tag: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let probe = root.join(format!(".probe-{tag}"));
    let id = unpack(bytes, &probe).and_then(|_| read_stored(&probe)).map(|s| s.id);
    let _ = fs::remove_dir_all(&probe);
    let id = id.map_err(|e| format!("This is not a valid VS Code extension package: {e}"))?;
    install_into(root, &id, bytes)
}

pub fn install_into(root: &Path, id: &str, bytes: &[u8]) -> Result<StoredExtension, String> {
    if !valid_id(id) {
        return Err("Invalid extension id".into());
    }
    let mut nonce = [0u8; 6];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let tag: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let tmp = root.join(format!(".tmp-{tag}"));
    let result = unpack(bytes, &tmp).and_then(|_| read_stored(&tmp));
    let stored = match result {
        Ok(s) if s.id == id => s,
        Ok(s) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(format!("The downloaded extension is {}, not {id}", s.id));
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(e);
        }
    };
    let dest = root.join(id);
    if dest.exists() {
        let old = root.join(format!(".old-{tag}"));
        fs::rename(&dest, &old).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(&old);
    }
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(stored)
}

/// A file of an installed extension, refusing anything outside its folder (also through symlinks).
pub fn read_file_in(root: &Path, id: &str, rel: &str) -> Result<Vec<u8>, String> {
    if !valid_id(id) {
        return Err("Invalid extension id".into());
    }
    let rel = safe_relative(rel).ok_or("Invalid path")?;
    let base = dunce::canonicalize(root.join(id)).map_err(|_| format!("{id} is not installed"))?;
    let path = dunce::canonicalize(base.join(rel)).map_err(|_| "No such file".to_string())?;
    if !path.starts_with(&base) || !path.is_file() {
        return Err("No such file".into());
    }
    let mut buf = Vec::new();
    fs::File::open(&path).and_then(|f| f.take(MAX_READ + 1).read_to_end(&mut buf)).map_err(|e| e.to_string())?;
    if buf.len() as u64 > MAX_READ {
        return Err("File too large".into());
    }
    Ok(buf)
}

fn encode(bytes: Vec<u8>, encoding: &str) -> Result<String, String> {
    match encoding {
        "base64" => Ok(base64::engine::general_purpose::STANDARD.encode(bytes)),
        _ => String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text".into()),
    }
}

async fn download(url: &str) -> Result<Vec<u8>, String> {
    download_with(url, |_, _| {}).await
}

/// Downloads with progress (received, total). A slow connection may take as long as it needs: only
/// a stalled one (nothing for 60 s) fails, never a large download.
async fn download_with(url: &str, progress: impl Fn(u64, Option<u64>)) -> Result<Vec<u8>, String> {
    if !allowed_url(url) {
        return Err(format!("Only Open VSX can be reached ({url})"));
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("TMCode/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client.get(url).send().await.map_err(|e| format!("Could not reach Open VSX: {}", e.without_url()))?;
    if !res.status().is_success() {
        return Err(format!("Open VSX answered {}", res.status()));
    }
    let total = res.content_length();
    if total.is_some_and(|t| t as usize > MAX_DOWNLOAD) {
        return Err(format!("The extension is too large to install ({} MB)", total.unwrap_or(0) / 1_048_576));
    }
    let mut out = Vec::with_capacity(total.unwrap_or(0).min(MAX_DOWNLOAD as u64) as usize);
    let mut last = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("The download stopped: {}", e.without_url()))? {
        if out.len() + chunk.len() > MAX_DOWNLOAD {
            return Err("The extension is too large to install".into());
        }
        out.extend_from_slice(&chunk);
        let got = out.len() as u64;
        if got - last >= 512 * 1024 || Some(got) == total {
            last = got;
            progress(got, total);
        }
    }
    Ok(out)
}

/// An extension's per-platform .vsix files from Open VSX (`downloads` of /api/{namespace}/{name}).
async fn platform_downloads(id: &str) -> Option<std::collections::HashMap<String, String>> {
    let (ns, name) = id.split_once('.')?;
    let bytes = download(&format!("{GALLERY}api/{ns}/{name}")).await.ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let map: std::collections::HashMap<String, String> = serde_json::from_value(v.get("downloads")?.clone()).ok()?;
    (!map.is_empty()).then_some(map)
}

#[derive(Serialize, Clone)]
pub struct InstallProgress {
    received: u64,
    total: Option<u64>,
    /// "download", then "unpack".
    phase: &'static str,
}

#[tauri::command]
pub async fn ext_fetch(url: String, encoding: String) -> Result<String, String> {
    encode(download(&url).await?, &encoding)
}

#[tauri::command]
pub fn ext_list(app: AppHandle) -> Result<Vec<StoredExtension>, String> {
    Ok(list_in(&root(&app)?))
}

/// "Install from VSIX…": the user picks the file in a native dialog (the webview never names a path).
#[tauri::command]
pub async fn ext_install_vsix(app: AppHandle) -> Result<Option<StoredExtension>, String> {
    use tauri_plugin_dialog::DialogExt;
    let dev = if cfg!(debug_assertions) { std::env::var("TMCODE_DEV_VSIX").ok() } else { None };
    let picked = match dev {
        Some(p) => Some(PathBuf::from(p)),
        None => app
            .dialog()
            .file()
            .set_title("Install from VSIX")
            .add_filter("VS Code Extension", &["vsix"])
            .blocking_pick_file()
            .map(|f| f.into_path().map_err(|e| e.to_string()))
            .transpose()?,
    };
    let Some(path) = picked else { return Ok(None) };
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 300 * 1024 * 1024 {
        return Err("The extension package is larger than 300 MB.".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let root = root(&app)?;
    let stored = tauri::async_runtime::spawn_blocking(move || install_vsix_bytes(&root, &bytes)).await.map_err(|e| e.to_string())??;
    log::info!("installed extension {} {} from a .vsix", stored.id, stored.version);
    Ok(Some(stored))
}

#[tauri::command]
pub async fn ext_install(
    app: AppHandle,
    id: String,
    url: String,
    downloads: Option<std::collections::HashMap<String, String>>,
    on_progress: tauri::ipc::Channel<InstallProgress>,
) -> Result<StoredExtension, String> {
    let id = id.to_lowercase();
    if !valid_id(&id) {
        return Err("Invalid extension id".into());
    }
    // Search results don't list the per-platform builds: ask Open VSX for this extension's own.
    let downloads = match downloads {
        Some(d) if !d.is_empty() => Some(d),
        _ => platform_downloads(&id).await,
    };
    let url = pick_download(&url, downloads.as_ref(), &target_platform());
    log::info!("installing extension {id} from {url}");
    let bytes = download_with(&url, |received, total| {
        let _ = on_progress.send(InstallProgress { received, total, phase: "download" });
    })
    .await?;
    let _ = on_progress.send(InstallProgress { received: bytes.len() as u64, total: Some(bytes.len() as u64), phase: "unpack" });
    let root = root(&app)?;
    let stored = tauri::async_runtime::spawn_blocking(move || install_into(&root, &id, &bytes)).await.map_err(|e| e.to_string())??;
    log::info!("installed extension {} {}", stored.id, stored.version);
    Ok(stored)
}

#[tauri::command]
pub fn ext_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    let id = id.to_lowercase();
    if !valid_id(&id) {
        return Err("Invalid extension id".into());
    }
    let dir = root(&app)?.join(&id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    log::info!("uninstalled extension {id}");
    Ok(())
}

#[tauri::command]
pub fn ext_read_file(app: AppHandle, id: String, path: String, encoding: String) -> Result<String, String> {
    encode(read_file_in(&root(&app)?, &id.to_lowercase(), &path)?, &encoding)
}

#[cfg(test)]
mod platform_tests {
    use super::*;

    #[test]
    fn picks_this_computers_build() {
        let mut d = std::collections::HashMap::new();
        for t in ["linux-x64", "darwin-arm64", "alpine-arm64", "win32-x64"] {
            d.insert(t.to_string(), format!("https://open-vsx.org/{t}.vsix"));
        }
        // Open VSX's default file for Claude Code was the alpine-arm64 build.
        let default = "https://open-vsx.org/alpine-arm64.vsix";
        assert_eq!(pick_download(default, Some(&d), "darwin-arm64"), "https://open-vsx.org/darwin-arm64.vsix");
        assert_eq!(pick_download(default, Some(&d), "win32-x64"), "https://open-vsx.org/win32-x64.vsix");
        d.insert("universal".into(), "https://open-vsx.org/u.vsix".into());
        assert_eq!(pick_download(default, Some(&d), "linux-armhf"), "https://open-vsx.org/u.vsix");
        assert_eq!(pick_download(default, None, "darwin-arm64"), default);
    }

    #[test]
    fn this_platform_has_an_open_vsx_name() {
        let t = target_platform();
        assert!(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64", "alpine-x64", "alpine-arm64"].contains(&t.as_str()), "{t}");
    }

    /// The real thing, against Open VSX (≈110 MB): `cargo test --lib real_claude_code -- --ignored`.
    #[test]
    #[ignore]
    fn real_claude_code_installs_and_its_agent_runs() {
        let meta: serde_json::Value = tauri::async_runtime::block_on(async { serde_json::from_slice(&download("https://open-vsx.org/api/Anthropic/claude-code").await.unwrap()).unwrap() });
        // As from a search hit: no per-platform list; the installer looks it up.
        let downloads = tauri::async_runtime::block_on(platform_downloads("anthropic.claude-code"));
        assert!(downloads.as_ref().is_some_and(|d| d.contains_key(&target_platform())));
        let url = pick_download(meta["files"]["download"].as_str().unwrap(), downloads.as_ref(), &target_platform());
        assert!(url.contains(&target_platform()), "{url}");
        let bytes = tauri::async_runtime::block_on(download_with(&url, |_, _| {})).unwrap();
        let root = std::env::temp_dir().join(format!("tmcode-real-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let stored = install_into(&root, "anthropic.claude-code", &bytes).unwrap();
        eprintln!("installed {} {} from {url} ({} MB)", stored.id, stored.version, bytes.len() / 1_048_576);
        let dir = root.join("anthropic.claude-code").join("resources");
        let exe = ["native-binary/claude", "native-binary/claude.exe"].iter().map(|p| dir.join(p)).find(|p| p.exists()).expect("bundled claude");
        let out = std::process::Command::new(&exe).arg("--version").output().expect("claude runs");
        eprintln!("claude --version: {}", String::from_utf8_lossy(&out.stdout).trim());
        assert!(out.status.success());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn native_programs_stay_executable() {
        use std::os::unix::fs::PermissionsExt;
        let mut buf = Vec::new();
        {
            let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let exe = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
            let plain = zip::write::SimpleFileOptions::default().unix_permissions(0o644);
            z.start_file("extension/package.json", plain).unwrap();
            z.write_all(br#"{"publisher":"a","name":"b","version":"1.0.0"}"#).unwrap();
            z.start_file("extension/resources/native-binary/claude", exe).unwrap();
            z.write_all(b"#!/bin/sh\necho hi\n").unwrap();
            z.start_file("extension/readme.md", plain).unwrap();
            z.write_all(b"hi").unwrap();
            z.finish().unwrap();
        }
        let dir = std::env::temp_dir().join(format!("tmcode-unpack-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        unpack(&buf, &dir).unwrap();
        let mode = |p: &str| fs::metadata(dir.join(p)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode("resources/native-binary/claude") & 0o111, 0o111);
        assert_eq!(mode("readme.md") & 0o111, 0);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn vsix(files: &[(&str, &str)]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in files {
            w.start_file(*name, opts).unwrap();
            w.write_all(content.as_bytes()).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    const PKG: &str = r#"{ "name": "Owl-Theme", "publisher": "OwlCo", "version": "1.2.0", "contributes": { "themes": [] } }"#;

    #[test]
    fn a_local_vsix_installs_under_its_own_id() {
        let dir = tempfile::tempdir().unwrap();
        let stored = install_vsix_bytes(dir.path(), &vsix(&[("extension/package.json", PKG)])).unwrap();
        assert_eq!(stored.id, "owlco.owl-theme");
        assert!(dir.path().join("owlco.owl-theme/package.json").exists());
        assert!(install_vsix_bytes(dir.path(), b"not a zip").is_err());
        assert!(fs::read_dir(dir.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".probe-")), "probe folder cleaned up");
    }

    #[test]
    fn ids_and_urls_are_checked() {
        assert!(valid_id("owlco.owl-theme"));
        assert!(valid_id("ms-python.python"));
        assert!(!valid_id("OwlCo.theme"));
        assert!(!valid_id("../etc"));
        assert!(!valid_id("a..b"));
        assert!(!valid_id("noperiod"));
        assert!(!valid_id("a/b.c"));
        assert!(allowed_url("https://open-vsx.org/api/-/search?query=x"));
        assert!(!allowed_url("https://open-vsx.org.evil.com/api"));
        assert!(!allowed_url("http://open-vsx.org/api"));
        assert!(!allowed_url("https://example.com/https://open-vsx.org/"));
        assert!(!allowed_url("https://open-vsx.org//evil.com/x"));
    }

    #[test]
    fn relative_paths_never_leave_the_extension() {
        assert_eq!(safe_relative("./themes/a.json"), Some(PathBuf::from("themes/a.json")));
        assert_eq!(safe_relative("../x"), None);
        assert_eq!(safe_relative("a/../../x"), None);
        assert_eq!(safe_relative("/etc/passwd"), None);
        assert_eq!(safe_relative("a\\..\\b"), None);
        assert_eq!(safe_relative(""), None);
    }

    #[test]
    fn installs_lists_reads_and_replaces() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let bytes = vsix(&[
            ("[Content_Types].xml", "<Types/>"),
            ("extension.vsixmanifest", "<x/>"),
            ("extension/package.json", PKG),
            ("extension/package.nls.json", r#"{"x":"y"}"#),
            ("extension/themes/owl.json", r#"{"colors":{}}"#),
            ("extension/../escape.txt", "no"),
        ]);
        let s = install_into(root, "owlco.owl-theme", &bytes).unwrap();
        assert_eq!(s.id, "owlco.owl-theme");
        assert_eq!(s.version, "1.2.0");
        assert_eq!(s.nls.as_deref(), Some(r#"{"x":"y"}"#));
        assert!(!root.join("escape.txt").exists());
        assert!(!root.join("owlco.owl-theme/extension.vsixmanifest").exists());
        assert_eq!(read_file_in(root, "owlco.owl-theme", "themes/owl.json").unwrap(), br#"{"colors":{}}"#);
        assert!(read_file_in(root, "owlco.owl-theme", "../owlco.owl-theme/package.json").is_err());
        assert!(read_file_in(root, "owlco.owl-theme", "missing.json").is_err());

        // A newer version replaces the old folder; temporary folders are not listed.
        let v2 = PKG.replace("1.2.0", "1.3.0");
        install_into(root, "owlco.owl-theme", &vsix(&[("extension/package.json", &v2)])).unwrap();
        fs::create_dir_all(root.join(".tmp-abc")).unwrap();
        let list = list_in(root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version, "1.3.0");
        assert!(read_file_in(root, "owlco.owl-theme", "themes/owl.json").is_err());
    }

    #[test]
    fn refuses_wrong_or_broken_packages() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let bytes = vsix(&[("extension/package.json", PKG)]);
        assert!(install_into(root, "other.extension", &bytes).unwrap_err().contains("not other.extension"));
        assert!(install_into(root, "owlco.owl-theme", b"not a zip").is_err());
        assert!(install_into(root, "owlco.owl-theme", &vsix(&[("extension/readme.md", "x")])).unwrap_err().contains("package.json"));
        // Nothing half-installed is left behind.
        assert!(fs::read_dir(root).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn reads_do_not_follow_symlinks_out() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        install_into(root, "owlco.owl-theme", &vsix(&[("extension/package.json", PKG)])).unwrap();
        fs::write(root.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(root.join("secret.txt"), root.join("owlco.owl-theme/link.txt")).unwrap();
        assert!(read_file_in(root, "owlco.owl-theme", "link.txt").is_err());
    }
}
