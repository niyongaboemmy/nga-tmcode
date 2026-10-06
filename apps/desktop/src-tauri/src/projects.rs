//! Task Mentor projects (docs/PROJECTS_PLAN.md §4): the folder side of sync.
//!
//! `proj_scan` lists the project's files with their sha256 the way git sees
//! the folder (`.gitignore`, plus `.tmignore` and TMCode's own build-output
//! rules), so only source goes to Task Mentor. Blobs travel gzipped and
//! base64-encoded through `tm_api`; `proj_read_blob` / `proj_write_blob` do
//! the compression here so large files never pass through JavaScript twice.

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use tauri::State;

use crate::workspace::{resolve, Workspace};

/// Never synced, whatever .gitignore says.
pub const ALWAYS_IGNORED: &[&str] = &[
    ".git", "node_modules", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", ".next", ".gradle", ".idea", ".DS_Store", ".tmcode",
];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ScannedFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Serialize, Debug)]
pub struct Scan {
    pub files: Vec<ScannedFile>,
    /// Limits that stopped the scan early (the UI explains them).
    pub truncated: Option<String>,
    pub total_bytes: u64,
}

fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut f = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        hasher.update(&buf[..n]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

/// Walks `root` honouring .gitignore/.tmignore and ALWAYS_IGNORED.
pub fn scan(root: &Path, max_files: usize, max_file_bytes: u64, max_total_bytes: u64) -> Scan {
    let mut files = Vec::new();
    let mut truncated = None;
    let mut total = 0u64;
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .add_custom_ignore_filename(".tmignore")
        .filter_entry(|e| !ALWAYS_IGNORED.contains(&e.file_name().to_string_lossy().as_ref()))
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel.len() > 260 {
            continue;
        }
        let Ok((sha256, size)) = hash_file(entry.path()) else { continue };
        if size > max_file_bytes {
            truncated.get_or_insert(format!("{rel} is larger than {} MB and was left out", max_file_bytes / 1_048_576));
            continue;
        }
        if files.len() >= max_files {
            truncated = Some(format!("More than {max_files} files: the rest were left out"));
            break;
        }
        if total + size > max_total_bytes {
            truncated = Some(format!("The project is larger than {} MB: the rest was left out", max_total_bytes / 1_048_576));
            break;
        }
        total += size;
        files.push(ScannedFile { path: rel, sha256, size });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Scan { files, truncated, total_bytes: total }
}

#[tauri::command]
pub async fn proj_scan(ws: State<'_, Workspace>, max_files: Option<usize>, max_file_mb: Option<u64>, max_total_mb: Option<u64>) -> Result<Scan, String> {
    let root = ws.root()?;
    let (mf, mfb, mtb) = (max_files.unwrap_or(5000), max_file_mb.unwrap_or(10) * 1_048_576, max_total_mb.unwrap_or(100) * 1_048_576);
    tauri::async_runtime::spawn_blocking(move || scan(&root, mf, mfb, mtb)).await.map_err(|e| e.to_string())
}

pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(bytes).expect("in-memory write");
    enc.finish().expect("in-memory write")
}

pub fn gunzip(bytes: &[u8], limit: u64) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    GzDecoder::new(bytes).take(limit + 1).read_to_end(&mut out).map_err(|_| "The file from Task Mentor is damaged.")?;
    if out.len() as u64 > limit {
        return Err("The file from Task Mentor is too large.".into());
    }
    Ok(out)
}

/// A file's content, gzipped + base64, with its sha256 (checked again on upload).
#[tauri::command]
pub fn proj_read_blob(ws: State<'_, Workspace>, path: String) -> Result<(String, String), String> {
    use base64::Engine;
    let file = resolve(&ws.root()?, &path)?;
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    let sha = format!("{:x}", Sha256::digest(&bytes));
    Ok((sha, base64::engine::general_purpose::STANDARD.encode(gzip(&bytes))))
}

/// Writes a downloaded blob (gzipped + base64) after checking its sha256.
#[tauri::command]
pub fn proj_write_blob(ws: State<'_, Workspace>, path: String, sha256: String, gz_base64: String) -> Result<(), String> {
    use base64::Engine;
    let gz = base64::engine::general_purpose::STANDARD.decode(gz_base64).map_err(|_| "Bad data")?;
    let bytes = gunzip(&gz, 64 * 1_048_576)?;
    if format!("{:x}", Sha256::digest(&bytes)) != sha256 {
        return Err(format!("{path}: the downloaded content does not match its checksum."));
    }
    let file = resolve(&ws.root()?, &path)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("tmcode-tmp");
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

/// Folder for a new local copy: `<base>/<slug>`, or `<slug>-2`… when taken.
#[tauri::command]
pub fn proj_new_folder(base: Option<String>, slug: String) -> Result<String, String> {
    let clean: String = slug.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let clean = clean.trim_matches('-');
    if clean.is_empty() {
        return Err("Invalid project name".into());
    }
    let base = match base {
        Some(b) if !b.is_empty() => std::path::PathBuf::from(b),
        _ => dirs_home().join("TMCode Projects"),
    };
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    for n in 1..100 {
        let name = if n == 1 { clean.to_string() } else { format!("{clean}-{n}") };
        let dir = base.join(&name);
        if !dir.exists() {
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            return Ok(dunce::canonicalize(&dir).unwrap_or(dir).to_string_lossy().into_owned());
        }
    }
    Err("Could not find a free folder name".into())
}

/// The next "Open in TMCode" clone of a GitHub project goes to `~/TMCode Projects`.
#[tauri::command]
pub fn proj_use_projects_folder(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let base = dirs_home().join("TMCode Projects");
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let base = dunce::canonicalize(&base).unwrap_or(base);
    app.state::<crate::git::Git>().set_clone_parent(base.clone());
    Ok(base.to_string_lossy().into_owned())
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_honours_gitignore_tmignore_and_build_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("main.cpp"), "int main(){}").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "export {}").unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("node_modules/x/i.js"), "x").unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(root.join("build/app"), "bin").unwrap();
        fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        fs::write(root.join("debug.log"), "noise").unwrap();
        fs::write(root.join(".tmignore"), "secret.txt\n").unwrap();
        fs::write(root.join("secret.txt"), "pw").unwrap();
        fs::write(root.join(".env.example"), "A=1").unwrap();
        let s = scan(root, 100, 1_000_000, 10_000_000);
        let paths: Vec<_> = s.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec![".env.example", ".gitignore", ".tmignore", "main.cpp", "src/a.ts"]);
        let main = s.files.iter().find(|f| f.path == "main.cpp").unwrap();
        assert_eq!(main.sha256, format!("{:x}", Sha256::digest(b"int main(){}")));
        assert_eq!(main.size, 12);
        assert!(s.truncated.is_none());
    }

    #[test]
    fn scan_limits() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            fs::write(dir.path().join(format!("f{i}.txt")), "12345").unwrap();
        }
        fs::write(dir.path().join("big.bin"), vec![0u8; 2000]).unwrap();
        let s = scan(dir.path(), 3, 1000, 1_000_000);
        assert_eq!(s.files.len(), 3);
        assert!(s.truncated.is_some());
        let s = scan(dir.path(), 100, 1000, 1_000_000);
        assert!(!s.files.iter().any(|f| f.path == "big.bin"));
        assert!(s.truncated.unwrap().contains("big.bin"));
    }

    #[test]
    fn gzip_round_trip_and_limit() {
        let data = b"hello hello hello".repeat(100);
        assert_eq!(gunzip(&gzip(&data), 10_000).unwrap(), data);
        assert!(gunzip(&gzip(&data), 10).is_err());
        assert!(gunzip(b"not gzip", 100).is_err());
    }
}
