//! The workspace file system: every path the workbench sends is relative to
//! the opened folder, and nothing outside that folder can be read or written
//! (no absolute paths, no `..`, no symlink escapes).

use crate::encoding::{self, Encoding};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, State};
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

    /// Opens an already-canonical folder (exam folders the app created itself).
    pub fn set_root(&self, root: PathBuf) {
        *self.0.lock().unwrap() = Some(root);
    }
}

#[derive(Serialize)]
pub struct Opened {
    name: String,
    root: String,
    /// When a *file* was opened: its path inside the opened (parent) folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
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

/// Makes `root` the workspace and starts watching it for outside changes.
pub fn activate(app: &AppHandle, ws: &Workspace, root: PathBuf) {
    ws.set_root(root.clone());
    app.state::<crate::watcher::Watcher>().watch(app, root);
}

fn open_root(app: &AppHandle, ws: &Workspace, path: PathBuf) -> Result<Opened, String> {
    let root = dunce::canonicalize(&path)
        .map_err(|e| format!("Cannot open '{}': {e}", path.display()))?;
    if !root.is_dir() {
        return Err(format!("'{}' is not a folder.", root.display()));
    }
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());
    activate(app, ws, root.clone());
    log::info!("workspace opened: {}", root.display());
    Ok(Opened {
        name,
        root: root.display().to_string(),
        file: None,
    })
}

/// Opens a folder, or a file (its folder becomes the workspace) — command-line
/// arguments, "Open With", Open File.
pub fn open_path(app: &AppHandle, ws: &Workspace, path: PathBuf) -> Result<Opened, String> {
    let real = dunce::canonicalize(&path).map_err(|e| format!("Cannot open '{}': {e}", path.display()))?;
    if real.is_dir() {
        return open_root(app, ws, real);
    }
    let parent = real.parent().ok_or("This file has no folder.")?.to_path_buf();
    let mut opened = open_root(app, ws, parent.clone())?;
    opened.file = Some(rel_of(&parent, &real));
    Ok(opened)
}

#[tauri::command]
pub async fn ws_open(app: AppHandle, ws: State<'_, Workspace>) -> Result<Option<Opened>, String> {
    let picked = app.dialog().file().set_title("Open Folder").blocking_pick_folder();
    let Some(folder) = picked else { return Ok(None) };
    let path = folder.into_path().map_err(|e| e.to_string())?;
    open_root(&app, &ws, path).map(Some)
}

#[tauri::command]
pub async fn ws_open_file(app: AppHandle, ws: State<'_, Workspace>) -> Result<Option<Opened>, String> {
    let picked = app.dialog().file().set_title("Open File").blocking_pick_file();
    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(|e| e.to_string())?;
    open_path(&app, &ws, path).map(Some)
}

#[tauri::command]
pub fn ws_reopen(app: AppHandle, ws: State<'_, Workspace>, root: String) -> Result<Opened, String> {
    open_root(&app, &ws, PathBuf::from(root))
}

#[tauri::command]
pub fn ws_open_path(app: AppHandle, ws: State<'_, Workspace>, path: String) -> Result<Opened, String> {
    open_path(&app, &ws, PathBuf::from(path))
}

/// Shows a workspace file or folder in Finder / File Explorer.
#[tauri::command]
pub fn ws_reveal(ws: State<'_, Workspace>, path: String) -> Result<(), String> {
    let root = ws.root()?;
    let target = resolve(&root, &path)?;
    tauri_plugin_opener::reveal_item_in_dir(target).map_err(|e| e.to_string())
}

/// Images, audio and video for the media viewer and Markdown preview.
const MAX_MEDIA_BYTES: u64 = 64 * 1024 * 1024;

#[tauri::command]
pub fn ws_read_base64(ws: State<'_, Workspace>, path: String) -> Result<String, String> {
    use base64::Engine;
    let root = ws.root()?;
    let file = resolve(&root, &path)?;
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > MAX_MEDIA_BYTES {
        return Err(format!("'{path}' is too large to preview ({} MB).", meta.len() / 1_048_576));
    }
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Only web and mail links leave the app; never file:// or custom schemes.
pub fn is_external_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")) && !lower.contains(char::is_whitespace)
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !is_external_url(&url) {
        return Err("Only http(s) and mailto links can be opened.".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
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

// ── encodings (feat/files-search) ──
// A file is read with the encoding detected from its bytes (BOM, valid UTF-8,
// else Windows-1252 / ISO 8859-1) and saved back in the encoding it has on
// disk, BOM included, so non-UTF-8 files are never rewritten lossily.
// "Reopen / Save with Encoding" pin a file's encoding for the session.

fn encoding_overrides() -> &'static Mutex<HashMap<PathBuf, Encoding>> {
    static MAP: OnceLock<Mutex<HashMap<PathBuf, Encoding>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

fn encoding_override(file: &Path) -> Option<Encoding> {
    encoding_overrides().lock().unwrap().get(file).copied()
}

/// The encoding `file` is read and saved with: the pinned one, else the one its bytes show.
fn encoding_of_file(file: &Path) -> Encoding {
    if let Some(enc) = encoding_override(file) {
        return enc;
    }
    match fs::read(file) {
        Ok(bytes) => encoding::detect(&bytes),
        Err(_) => Encoding::Utf8,
    }
}

pub fn read_file(root: &Path, path: &str) -> Result<String, String> {
    let file = resolve(root, path)?;
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!("'{path}' is too large to open in the editor ({} MB).", meta.len() / 1_048_576));
    }
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    let enc = encoding_override(&file).unwrap_or_else(|| encoding::detect(&bytes));
    if encoding::looks_binary(&bytes, enc) {
        return Err(format!("'{path}' is a binary file and cannot be opened as text."));
    }
    Ok(encoding::decode(&bytes, enc))
}

#[tauri::command]
pub fn ws_file_encoding(ws: State<'_, Workspace>, path: String) -> Result<String, String> {
    let file = resolve(&ws.root()?, &path)?;
    Ok(encoding_of_file(&file).id().to_string())
}

/// Reopen with Encoding: reads the file again as `encoding`; saves keep it.
#[tauri::command]
pub fn ws_reopen_with_encoding(ws: State<'_, Workspace>, path: String, encoding: String) -> Result<String, String> {
    let root = ws.root()?;
    let file = resolve(&root, &path)?;
    encoding_overrides().lock().unwrap().insert(file, Encoding::from_id(&encoding)?);
    read_file(&root, &path)
}

/// Save with Encoding: the next saves of the file use `encoding`.
#[tauri::command]
pub fn ws_set_encoding(ws: State<'_, Workspace>, path: String, encoding: String) -> Result<(), String> {
    let file = resolve(&ws.root()?, &path)?;
    encoding_overrides().lock().unwrap().insert(file, Encoding::from_id(&encoding)?);
    Ok(())
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
    // Before the temp file exists: the encoding the file has now (UTF-8 for a new file).
    let bytes = encoding::encode(content, encoding_of_file(&file)).map_err(|e| format!("'{path}': {e}"))?;
    let tmp = parent.join(format!(
        ".{}.tmcode-tmp",
        file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
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

/// Copies a file or folder (recursively) inside the workspace: Explorer copy/paste and Duplicate.
pub fn copy_entry(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let src = resolve(root, from)?;
    let dst = resolve(root, to)?;
    if dst.exists() {
        return Err(format!("A file or folder '{to}' already exists."));
    }
    if dst.starts_with(&src) {
        return Err(format!("Cannot copy '{from}' into itself."));
    }
    copy_tree(&src, &dst).map_err(|e| e.to_string())
}

/// Copies a file or folder recursively; symbolic links are skipped, never followed.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_tree(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else if meta.file_type().is_symlink() {
        Ok(())
    } else {
        fs::copy(src, dst).map(|_| ())
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Imported {
    imported: Vec<String>,
    conflicts: Vec<String>,
}

/// Files dropped from Finder / File Explorer: copies absolute `sources` into the
/// workspace folder `dest`. Without `overwrite`, nothing is copied while a name
/// is taken; the taken names are returned so the workbench can ask first.
pub fn import_paths(root: &Path, sources: &[String], dest: &str, overwrite: bool) -> Result<Imported, String> {
    let dir = resolve(root, dest)?;
    if !dir.is_dir() {
        return Err(format!("'{dest}' is not a folder."));
    }
    let mut plan = Vec::new();
    let mut conflicts = Vec::new();
    for s in sources {
        let src = dunce::canonicalize(s).map_err(|e| format!("Cannot read '{s}': {e}"))?;
        let name = src.file_name().ok_or_else(|| format!("'{s}' has no name."))?.to_owned();
        let target = dir.join(&name);
        if target == src {
            continue; // dropped where it already is
        }
        if dir.starts_with(&src) {
            return Err(format!("Cannot copy '{}' into itself.", name.to_string_lossy()));
        }
        if fs::symlink_metadata(&target).is_ok() {
            if src.starts_with(&target) {
                return Err(format!("Cannot replace '{}' with something inside it.", name.to_string_lossy()));
            }
            conflicts.push(name.to_string_lossy().into_owned());
        }
        plan.push((src, target));
    }
    if !conflicts.is_empty() && !overwrite {
        return Ok(Imported { imported: Vec::new(), conflicts });
    }
    let mut imported = Vec::new();
    for (src, target) in plan {
        if let Ok(meta) = fs::symlink_metadata(&target) {
            if meta.is_dir() { fs::remove_dir_all(&target) } else { fs::remove_file(&target) }.map_err(|e| e.to_string())?;
        }
        copy_tree(&src, &target).map_err(|e| format!("Cannot copy '{}': {e}", src.display()))?;
        imported.push(rel_of(root, &target));
    }
    Ok(Imported { imported, conflicts })
}

#[tauri::command]
pub fn ws_import(ws: State<'_, Workspace>, sources: Vec<String>, dest: String, overwrite: bool) -> Result<Imported, String> {
    import_paths(&ws.root()?, &sources, &dest, overwrite)
}

#[tauri::command]
pub fn ws_copy(ws: State<'_, Workspace>, from: String, to: String) -> Result<(), String> {
    copy_entry(&ws.root()?, &from, &to)
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

/// Explorer Delete: to the OS Trash / Recycle Bin, so the student can restore it.
/// An error (no Trash on this drive, a network share) lets the workbench offer a
/// permanent delete instead.
#[tauri::command]
pub fn ws_trash(ws: State<'_, Workspace>, path: String) -> Result<(), String> {
    let root = ws.root()?;
    move_to_trash(&root, &path)
}

pub fn move_to_trash(root: &Path, path: &str) -> Result<(), String> {
    let target = resolve(root, path)?;
    if target == root {
        return Err("The workspace folder itself cannot be deleted.".into());
    }
    if fs::symlink_metadata(&target).is_err() {
        return Err(format!("'{path}' does not exist"));
    }
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    // macOS: NSFileManager, not the default Finder script, which asks for permission to control Finder.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(&target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_entry_copies_files_and_folders_inside_the_workspace() {
        let (_d, root) = root();
        fs::create_dir_all(root.join("src/sub")).unwrap();
        fs::write(root.join("src/a.txt"), "a").unwrap();
        fs::write(root.join("src/sub/b.bin"), [0u8, 159, 255]).unwrap();
        copy_entry(&root, "src", "src copy").unwrap();
        assert_eq!(fs::read(root.join("src copy/sub/b.bin")).unwrap(), vec![0u8, 159, 255]);
        copy_entry(&root, "src/a.txt", "a copy.txt").unwrap();
        assert_eq!(fs::read_to_string(root.join("a copy.txt")).unwrap(), "a");
        assert!(copy_entry(&root, "src", "src/sub/inner").is_err(), "into itself");
        assert!(copy_entry(&root, "src/a.txt", "a copy.txt").is_err(), "exists");
        assert!(copy_entry(&root, "src/a.txt", "../outside.txt").is_err(), "outside");
    }

    #[test]
    fn trash_refuses_the_root_paths_outside_and_missing_files() {
        // Only the refusals: a real move would fill the Trash of whoever runs the tests.
        let (_d, root) = root();
        assert!(move_to_trash(&root, "").is_err(), "root");
        assert!(move_to_trash(&root, "../outside.txt").is_err(), "outside");
        assert!(move_to_trash(&root, "nope.py").is_err(), "missing");
        assert!(root.join("main.py").exists());
    }

    #[test]
    fn external_urls_are_web_or_mail_only() {
        assert!(is_external_url("https://github.com/x"));
        assert!(is_external_url("mailto:a@b.c"));
        assert!(!is_external_url("file:///etc/passwd"));
        assert!(!is_external_url("javascript:alert(1)"));
        assert!(!is_external_url("tmcode://launch"));
        assert!(!is_external_url("https://a b"));
    }

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
    fn saves_keep_the_files_encoding_and_bom() {
        let (_d, root) = root();
        // A French Windows-1252 file: the accents survive a read and an edited save.
        fs::write(root.join("fr.txt"), b"caf\xE9 cr\xE8me\r\n").unwrap();
        let text = read_file(&root, "fr.txt").unwrap();
        assert_eq!(text, "caf\u{e9} cr\u{e8}me\r\n");
        write_file(&root, "fr.txt", &format!("{text}d\u{e9}j\u{e0}\r\n")).unwrap();
        assert_eq!(fs::read(root.join("fr.txt")).unwrap(), b"caf\xE9 cr\xE8me\r\nd\xE9j\xE0\r\n".to_vec());
        // A character Windows-1252 can't hold is refused, not replaced.
        assert!(write_file(&root, "fr.txt", "\u{2713}").unwrap_err().contains("Save with Encoding"));
        assert_eq!(fs::read(root.join("fr.txt")).unwrap(), b"caf\xE9 cr\xE8me\r\nd\xE9j\xE0\r\n".to_vec());
        // UTF-8 with BOM keeps its BOM.
        fs::write(root.join("bom.py"), b"\xEF\xBB\xBFx = 1\n").unwrap();
        write_file(&root, "bom.py", "x = 2\n").unwrap();
        assert_eq!(fs::read(root.join("bom.py")).unwrap(), b"\xEF\xBB\xBFx = 2\n".to_vec());
        // UTF-16 opens as text (its NULs are not "binary") and stays UTF-16.
        fs::write(root.join("w.txt"), b"\xFF\xFEh\0i\0").unwrap();
        assert_eq!(read_file(&root, "w.txt").unwrap(), "hi");
        write_file(&root, "w.txt", "ho").unwrap();
        assert_eq!(fs::read(root.join("w.txt")).unwrap(), b"\xFF\xFEh\0o\0".to_vec());
        // New files are UTF-8.
        write_file(&root, "new.txt", "\u{e9}").unwrap();
        assert_eq!(fs::read(root.join("new.txt")).unwrap(), "\u{e9}".as_bytes());
    }

    #[test]
    fn imports_dropped_files_and_asks_before_replacing() {
        let (_d, root) = root();
        let outside = tempfile::tempdir().unwrap();
        let o = dunce::canonicalize(outside.path()).unwrap();
        fs::write(o.join("main.py"), "print('new')\n").unwrap();
        fs::create_dir_all(o.join("lib/sub")).unwrap();
        fs::write(o.join("lib/sub/a.txt"), "a").unwrap();
        let sources = vec![o.join("main.py").display().to_string(), o.join("lib").display().to_string()];
        // main.py is taken: nothing is copied yet.
        let first = import_paths(&root, &sources, "", false).unwrap();
        assert_eq!(first, Imported { imported: vec![], conflicts: vec!["main.py".into()] });
        assert!(!root.join("lib").exists());
        let second = import_paths(&root, &sources, "", true).unwrap();
        assert_eq!(second.imported, vec!["main.py".to_string(), "lib".to_string()]);
        assert_eq!(fs::read_to_string(root.join("main.py")).unwrap(), "print('new')\n");
        assert_eq!(fs::read_to_string(root.join("lib/sub/a.txt")).unwrap(), "a");
        // Into a sub-folder; never into itself or outside the workspace.
        assert_eq!(import_paths(&root, &[o.join("lib/sub/a.txt").display().to_string()], "src", false).unwrap().imported, vec!["src/a.txt".to_string()]);
        assert!(import_paths(&root, &[root.display().to_string()], "src", true).is_err());
        assert!(import_paths(&root, &sources, "../x", true).is_err());
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
