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

/// Something in the folder that is not handed in, and why (the submit dialog lists them).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SkippedFile {
    pub path: String,
    /// "folder" (build output, dependencies), "ignored" (.gitignore/.tmignore), "too-large",
    /// "file-limit", "size-limit", "long-path", "link", "unreadable".
    pub reason: &'static str,
    /// A whole folder was left out (nothing under it is listed).
    pub dir: bool,
    pub size: Option<u64>,
}

#[derive(Serialize, Debug)]
pub struct Scan {
    pub files: Vec<ScannedFile>,
    /// Limits that stopped the scan early (the UI explains them).
    pub truncated: Option<String>,
    pub total_bytes: u64,
    /// What was left out (at most MAX_SKIPPED listed): a left-out file is never taken for a deleted one.
    pub skipped: Vec<SkippedFile>,
    /// All left-out entries, listed or not.
    pub skipped_count: usize,
}

/// The "not included" list stops here (the count goes on).
pub const MAX_SKIPPED: usize = 1000;
/// TMCode's own and the OS's files: never the student's work, never listed as left out.
const NOT_WORK: &[&str] = &[".git", ".tmcode", ".DS_Store"];

fn rel_of(root: &Path, p: &Path) -> Option<String> {
    p.strip_prefix(root).ok().map(|r| r.to_string_lossy().replace('\\', "/"))
}

#[derive(Default)]
struct Skips {
    list: Vec<SkippedFile>,
    count: usize,
}

impl Skips {
    fn push(&mut self, path: String, reason: &'static str, dir: bool, size: Option<u64>) {
        self.count += 1;
        if self.list.len() < MAX_SKIPPED {
            self.list.push(SkippedFile { path, reason, dir, size });
        }
    }
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

/// Walks `root` honouring .gitignore/.tmignore and ALWAYS_IGNORED, and lists what it left out
/// (the planner keeps a left-out file's saved copy instead of recording it as deleted).
pub fn scan(root: &Path, max_files: usize, max_file_bytes: u64, max_total_bytes: u64) -> Scan {
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};
    let mut files = Vec::new();
    let mut truncated: Option<String> = None;
    let mut total = 0u64;
    let skips = Arc::new(Mutex::new(Skips::default()));
    // Every file and folder the first walk saw: the second walk finds what .gitignore hid.
    let mut seen: HashSet<String> = HashSet::new();
    let mut size_full = false;
    {
        let skips_f = skips.clone();
        let root_f = root.to_path_buf();
        let walker = ignore::WalkBuilder::new(root)
            .hidden(false)
            .git_ignore(true)
            .git_global(false)
            .git_exclude(true)
            .require_git(false)
            .add_custom_ignore_filename(".tmignore")
            .sort_by_file_name(|a, b| a.cmp(b))
            .filter_entry(move |e| {
                let name = e.file_name().to_string_lossy();
                if !ALWAYS_IGNORED.contains(&name.as_ref()) {
                    return true;
                }
                if !NOT_WORK.contains(&name.as_ref()) {
                    if let Some(rel) = rel_of(&root_f, e.path()) {
                        skips_f.lock().unwrap().push(rel, "folder", e.file_type().is_some_and(|t| t.is_dir()), None);
                    }
                }
                false
            })
            .build();
        for entry in walker.flatten() {
            let Some(rel) = rel_of(root, entry.path()) else { continue };
            if rel.is_empty() {
                continue;
            }
            let ft = entry.file_type();
            seen.insert(rel.clone());
            if ft.is_some_and(|t| t.is_dir()) {
                continue;
            }
            let skip = |reason: &'static str, size: Option<u64>| skips.lock().unwrap().push(rel.clone(), reason, false, size);
            if !ft.is_some_and(|t| t.is_file()) {
                skip("link", None);
                continue;
            }
            if rel.len() > 260 {
                skip("long-path", None);
                continue;
            }
            let Ok(len) = entry.metadata().map(|m| m.len()) else {
                skip("unreadable", None);
                continue;
            };
            if len > max_file_bytes {
                truncated.get_or_insert(format!("{rel} is larger than {} MB and was left out", max_file_bytes / 1_048_576));
                skip("too-large", Some(len));
                continue;
            }
            if files.len() >= max_files {
                truncated = Some(format!("More than {max_files} files: the rest were left out"));
                skip("file-limit", Some(len));
                continue;
            }
            if size_full || total + len > max_total_bytes {
                size_full = true;
                truncated = Some(format!("The project is larger than {} MB: the rest was left out", max_total_bytes / 1_048_576));
                skip("size-limit", Some(len));
                continue;
            }
            let Ok((sha256, size)) = hash_file(entry.path()) else {
                skip("unreadable", Some(len));
                continue;
            };
            // Grew past the limit between the size check and the read.
            if size > max_file_bytes {
                skip("too-large", Some(size));
                continue;
            }
            total += size;
            files.push(ScannedFile { path: rel, sha256, size });
        }
    }
    // Second walk, without ignore rules: whatever the first one never saw was hidden by .gitignore/.tmignore.
    {
        let seen = Arc::new(seen);
        let seen_f = seen.clone();
        let skips_f = skips.clone();
        let root_f = root.to_path_buf();
        let walker = ignore::WalkBuilder::new(root)
            .standard_filters(false)
            .sort_by_file_name(|a, b| a.cmp(b))
            .filter_entry(move |e| {
                if e.depth() == 0 {
                    return true;
                }
                // Listed by the first walk already (or not work at all).
                if ALWAYS_IGNORED.contains(&e.file_name().to_string_lossy().as_ref()) {
                    return false;
                }
                let Some(rel) = rel_of(&root_f, e.path()) else { return false };
                if e.file_type().is_some_and(|t| t.is_dir()) && !seen_f.contains(&rel) {
                    skips_f.lock().unwrap().push(rel, "ignored", true, None);
                    return false;
                }
                true
            })
            .build();
        for entry in walker.flatten() {
            if entry.depth() == 0 || entry.file_type().is_some_and(|t| t.is_dir()) {
                continue;
            }
            let Some(rel) = rel_of(root, entry.path()) else { continue };
            if !seen.contains(&rel) {
                let size = entry.metadata().ok().map(|m| m.len());
                skips.lock().unwrap().push(rel, "ignored", false, size);
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let Skips { mut list, count } = std::mem::take(&mut *skips.lock().unwrap());
    list.sort_by(|a, b| a.path.cmp(&b.path));
    Scan { files, truncated, total_bytes: total, skipped: list, skipped_count: count }
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

    fn skipped(s: &Scan) -> Vec<(String, &'static str, bool)> {
        s.skipped.iter().map(|f| (f.path.clone(), f.reason, f.dir)).collect()
    }

    #[test]
    fn scan_lists_what_it_leaves_out() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("main.js"), "x").unwrap();
        fs::create_dir_all(root.join("node_modules/a/b")).unwrap();
        fs::write(root.join("node_modules/a/b/i.js"), "x").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "ref").unwrap();
        fs::create_dir_all(root.join(".tmcode")).unwrap();
        fs::write(root.join(".tmcode/project.json"), "{}").unwrap();
        fs::create_dir_all(root.join("coverage")).unwrap();
        fs::write(root.join("coverage/lcov.info"), "x").unwrap();
        fs::write(root.join(".gitignore"), "*.log\ncoverage/\n").unwrap();
        fs::write(root.join("debug.log"), "noise").unwrap();
        fs::write(root.join("video.mp4"), vec![0u8; 2000]).unwrap();
        let s = scan(root, 100, 1000, 1_000_000);
        let paths: Vec<_> = s.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec![".gitignore", "main.js"]);
        assert_eq!(
            skipped(&s),
            vec![
                ("coverage".into(), "ignored", true),
                ("debug.log".into(), "ignored", false),
                ("node_modules".into(), "folder", true),
                ("video.mp4".into(), "too-large", false),
            ]
        );
        assert_eq!(s.skipped_count, 4);
        assert_eq!(s.skipped.iter().find(|f| f.path == "video.mp4").unwrap().size, Some(2000));
    }

    #[test]
    fn a_file_that_grows_past_the_limit_is_listed_as_left_out_not_gone() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("data.csv"), "a,b\n").unwrap();
        let before = scan(dir.path(), 100, 1000, 1_000_000);
        assert_eq!(before.files.len(), 1);
        fs::write(dir.path().join("data.csv"), vec![b'x'; 5000]).unwrap();
        let after = scan(dir.path(), 100, 1000, 1_000_000);
        assert!(after.files.is_empty());
        assert_eq!(skipped(&after), vec![("data.csv".into(), "too-large", false)]);
    }

    #[test]
    fn files_past_the_caps_are_listed_too() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            fs::write(dir.path().join(format!("f{i}.txt")), "12345").unwrap();
        }
        let s = scan(dir.path(), 3, 1000, 1_000_000);
        assert_eq!(s.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["f0.txt", "f1.txt", "f2.txt"]);
        assert_eq!(skipped(&s), vec![("f3.txt".into(), "file-limit", false), ("f4.txt".into(), "file-limit", false)]);
        let s = scan(dir.path(), 100, 1000, 12);
        assert_eq!(s.files.len(), 2);
        assert_eq!(s.skipped.iter().filter(|f| f.reason == "size-limit").count(), 3);
    }

    #[test]
    fn gzip_round_trip_and_limit() {
        let data = b"hello hello hello".repeat(100);
        assert_eq!(gunzip(&gzip(&data), 10_000).unwrap(), data);
        assert!(gunzip(&gzip(&data), 10).is_err());
        assert!(gunzip(b"not gzip", 100).is_err());
    }
}
