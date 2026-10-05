//! The workspace file system: every path the workbench sends is relative to
//! the opened folder, and nothing outside that folder can be read or written
//! (no absolute paths, no `..`, no symlink escapes).

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// Files above this size are not opened as text (the editor would crawl).
const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Default)]
pub struct Workspace(Mutex<Option<PathBuf>>);

impl Workspace {
    pub fn root(&self) -> Result<PathBuf, String> {
        self.0
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "No folder is open.".to_string())
    }
}

#[derive(Serialize)]
pub struct Opened {
    name: String,
    root: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct DirEntry {
    name: String,
    path: String,
    kind: &'static str,
}

/// Resolves a workspace-relative path ("" is the root) to an absolute one,
/// refusing anything that could leave the workspace.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    let mut out = root.to_path_buf();
    for c in rel_path.components() {
        match c {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(format!("'{rel}' is not a path inside the workspace.")),
        }
    }
    // Symlinks: whatever exists must canonicalise to somewhere under the root;
    // for new paths, check the nearest existing ancestor.
    let mut probe = out.as_path();
    loop {
        if probe.exists() {
            let real = dunce::canonicalize(probe).map_err(|e| e.to_string())?;
            if !real.starts_with(root) {
                return Err(format!("'{rel}' points outside the workspace."));
            }
            break;
        }
        match probe.parent() {
            Some(p) => probe = p,
            None => break,
        }
    }
    Ok(out)
}

fn rel_of(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .components()
        .filter_map(|c| match c {
            Component::Normal(p) => Some(p.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn open_root(ws: &Workspace, path: PathBuf) -> Result<Opened, String> {
    let root = dunce::canonicalize(&path)
        .map_err(|e| format!("Cannot open '{}': {e}", path.display()))?;
    if !root.is_dir() {
        return Err(format!("'{}' is not a folder.", root.display()));
    }
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());
    *ws.0.lock().unwrap() = Some(root.clone());
    log::info!("workspace opened: {}", root.display());
    Ok(Opened {
        name,
        root: root.display().to_string(),
    })
}

#[tauri::command]
pub async fn ws_open(app: AppHandle, ws: State<'_, Workspace>) -> Result<Option<Opened>, String> {
    let picked = app.dialog().file().set_title("Open Folder").blocking_pick_folder();
    let Some(folder) = picked else { return Ok(None) };
    let path = folder.into_path().map_err(|e| e.to_string())?;
    open_root(&ws, path).map(Some)
}

#[tauri::command]
pub fn ws_reopen(ws: State<'_, Workspace>, root: String) -> Result<Opened, String> {
    open_root(&ws, PathBuf::from(root))
}

#[tauri::command]
pub fn ws_read_dir(ws: State<'_, Workspace>, path: String) -> Result<Vec<DirEntry>, String> {
    let root = ws.root()?;
    read_dir(&root, &path)
}

pub fn read_dir(root: &Path, path: &str) -> Result<Vec<DirEntry>, String> {
    let dir = resolve(root, path)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".DS_Store" {
            continue;
        }
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        // Follow symlinks only when they stay inside the workspace.
        let is_dir = if ft.is_symlink() {
            match dunce::canonicalize(entry.path()) {
                Ok(real) if real.starts_with(root) => real.is_dir(),
                _ => continue,
            }
        } else {
            ft.is_dir()
        };
        out.push(DirEntry {
            path: rel_of(root, &entry.path()),
            name,
            kind: if is_dir { "dir" } else { "file" },
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn ws_read_file(ws: State<'_, Workspace>, path: String) -> Result<String, String> {
    let root = ws.root()?;
    read_file(&root, &path)
}

pub fn read_file(root: &Path, path: &str) -> Result<String, String> {
    let file = resolve(root, path)?;
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!("'{path}' is too large to open in the editor ({} MB).", meta.len() / 1_048_576));
    }
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err(format!("'{path}' is a binary file and cannot be opened as text."));
    }
    // Strip a UTF-8 BOM; replace invalid sequences rather than refusing the file.
    let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).into_owned();
    Ok(text)
}

#[tauri::command]
pub fn ws_write_file(ws: State<'_, Workspace>, path: String, content: String) -> Result<(), String> {
    let root = ws.root()?;
    write_file(&root, &path, &content)
}

/// Atomic save: write a sibling temp file, then rename over the original, so a
/// crash mid-save never leaves a half-written answer.
pub fn write_file(root: &Path, path: &str, content: &str) -> Result<(), String> {
    let file = resolve(root, path)?;
    let parent = file.parent().ok_or("Invalid path")?;
    let tmp = parent.join(format!(
        ".{}.tmcode-tmp",
        file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &file).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

fn must_be_free(target: &Path, rel: &str) -> Result<(), String> {
    if target.exists() {
        return Err(format!("A file or folder '{rel}' already exists."));
    }
    Ok(())
}

#[tauri::command]
pub fn ws_create_file(ws: State<'_, Workspace>, path: String) -> Result<(), String> {
    let root = ws.root()?;
    let file = resolve(&root, &path)?;
    must_be_free(&file, &path)?;
    fs::File::create(&file).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ws_create_dir(ws: State<'_, Workspace>, path: String) -> Result<(), String> {
    let root = ws.root()?;
    let dir = resolve(&root, &path)?;
    must_be_free(&dir, &path)?;
    fs::create_dir(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ws_rename(ws: State<'_, Workspace>, from: String, to: String) -> Result<(), String> {
    let root = ws.root()?;
    let src = resolve(&root, &from)?;
    let dst = resolve(&root, &to)?;
    if src == root {
        return Err("The workspace folder itself cannot be renamed.".into());
    }
    // Case-only renames ("main.PY" → "main.py") are allowed on case-insensitive disks.
    if dst.exists() && from.to_lowercase() != to.to_lowercase() {
        return Err(format!("A file or folder '{to}' already exists."));
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ws_remove(ws: State<'_, Workspace>, path: String) -> Result<(), String> {
    let root = ws.root()?;
    let target = resolve(&root, &path)?;
    if target == root {
        return Err("The workspace folder itself cannot be deleted.".into());
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&target).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("main.py"), "print(1)\n").unwrap();
        (dir, root)
    }

    #[test]
    fn refuses_paths_that_leave_the_workspace() {
        let (_d, root) = root();
        assert!(resolve(&root, "../etc/passwd").is_err());
        assert!(resolve(&root, "src/../../x").is_err());
        assert!(resolve(&root, "/etc/passwd").is_err());
        assert!(resolve(&root, "src/new.py").is_ok());
        assert_eq!(resolve(&root, "").unwrap(), root);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_escape() {
        let (_d, root) = root();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
        assert!(resolve(&root, "escape/secret.txt").is_err());
        // ...and the explorer doesn't list them.
        let names: Vec<_> = read_dir(&root, "").unwrap().into_iter().map(|e| e.name).collect();
        assert!(!names.contains(&"escape".to_string()));
    }

    #[test]
    fn lists_with_relative_slash_paths() {
        let (_d, root) = root();
        fs::write(root.join("src/a.ts"), "").unwrap();
        let mut entries = read_dir(&root, "src").unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(entries, vec![DirEntry { name: "a.ts".into(), path: "src/a.ts".into(), kind: "file" }]);
    }

    #[test]
    fn saves_atomically_and_reads_back() {
        let (_d, root) = root();
        write_file(&root, "main.py", "print(2)\n").unwrap();
        assert_eq!(read_file(&root, "main.py").unwrap(), "print(2)\n");
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmcode-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn refuses_binary_files_and_strips_bom() {
        let (_d, root) = root();
        fs::write(root.join("a.bin"), [0u8, 1, 2, 3]).unwrap();
        assert!(read_file(&root, "a.bin").unwrap_err().contains("binary"));
        fs::write(root.join("bom.txt"), b"\xEF\xBB\xBFhi").unwrap();
        assert_eq!(read_file(&root, "bom.txt").unwrap(), "hi");
    }
}
