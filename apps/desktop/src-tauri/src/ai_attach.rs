//! Files attached to a TMCode AI question: picked in a native dialog, dropped
//! on the window, or copied in Finder / File Explorer. The webview can read
//! only paths the user gave it in one of those ways (granted here), never an
//! arbitrary path it names.

use base64::Engine;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, State};

/// Text larger than this is cut (the chat sends far less anyway).
const MAX_TEXT_BYTES: u64 = 1024 * 1024;
/// Images are sent as they are (the workbench scales them down first).
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Default)]
pub struct Granted(Mutex<HashSet<PathBuf>>);

impl Granted {
    pub fn grant<I: IntoIterator<Item = PathBuf>>(&self, paths: I) {
        let mut set = self.0.lock().unwrap();
        // Only the latest gestures matter; keep the set small.
        if set.len() > 500 {
            set.clear();
        }
        for p in paths {
            if let Ok(c) = dunce::canonicalize(&p) {
                set.insert(c);
            }
        }
    }
    fn allows(&self, p: &Path) -> bool {
        dunce::canonicalize(p).map(|c| self.0.lock().unwrap().contains(&c)).unwrap_or(false)
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Attached {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// UTF-8 text (cut at 1 MB); None for binary files and images.
    pub text: Option<String>,
    pub truncated: bool,
    /// png / jpeg / gif / webp, as base64.
    pub image: Option<AttachedImage>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct AttachedImage {
    pub mime: String,
    pub base64: String,
}

fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Reads one attachment (pure apart from the file system).
pub fn read_attachment(path: &Path) -> Result<Attached, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Cannot read '{}': {e}", path.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if meta.is_dir() {
        return Err(format!("'{name}' is a folder. Attach the files inside it instead."));
    }
    let size = meta.len();
    let base = Attached { path: path.to_string_lossy().into_owned(), name: name.clone(), size, text: None, truncated: false, image: None };
    if let Some(mime) = image_mime(path) {
        if size > MAX_IMAGE_BYTES {
            return Err(format!("'{name}' is larger than 10 MB."));
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        return Ok(Attached { image: Some(AttachedImage { mime: mime.into(), base64: base64::engine::general_purpose::STANDARD.encode(bytes) }), ..base });
    }
    let mut buf = Vec::new();
    fs::File::open(path).and_then(|f| f.take(MAX_TEXT_BYTES).read_to_end(&mut buf)).map_err(|e| e.to_string())?;
    if buf.contains(&0) {
        return Ok(base); // binary
    }
    let truncated = size > MAX_TEXT_BYTES;
    // A cut may split a character: drop the partial one.
    let text = match String::from_utf8(buf) {
        Ok(t) => t,
        Err(e) if truncated => {
            let valid = e.utf8_error().valid_up_to();
            let mut b = e.into_bytes();
            b.truncate(valid);
            String::from_utf8(b).unwrap_or_default()
        }
        Err(_) => return Ok(base), // not UTF-8: treated as binary
    };
    Ok(Attached { text: Some(text), truncated, ..base })
}

/// The paperclip: a native dialog, several files at once.
#[tauri::command]
pub async fn attach_pick(app: AppHandle, granted: State<'_, Granted>) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_title("Attach Files").blocking_pick_files().unwrap_or_default();
    let paths: Vec<PathBuf> = picked.into_iter().filter_map(|f| f.into_path().ok()).collect();
    granted.grant(paths.clone());
    Ok(paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

/// Files copied in Finder / File Explorer (for ⌘V in the chat).
#[tauri::command]
pub async fn attach_clipboard(granted: State<'_, Granted>) -> Result<Vec<String>, String> {
    let paths = crate::workspace::ws_clipboard_files().await;
    granted.grant(paths.iter().map(PathBuf::from));
    Ok(paths)
}

#[tauri::command]
pub async fn attach_read(granted: State<'_, Granted>, path: String) -> Result<Attached, String> {
    let p = PathBuf::from(&path);
    if !granted.allows(&p) {
        return Err("TMCode can only attach files you pick, drop or copy.".into());
    }
    tauri::async_runtime::spawn_blocking(move || read_attachment(&p)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tmcode-attach-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn reads_text_images_and_refuses_folders() {
        let t = read_attachment(&tmp("a.py", b"print('hi')\n")).unwrap();
        assert_eq!(t.text.as_deref(), Some("print('hi')\n"));
        assert_eq!(t.name, "a.py");
        assert!(!t.truncated && t.image.is_none());

        let i = read_attachment(&tmp("shot.PNG", &[0x89, b'P', b'N', b'G', 0])).unwrap();
        assert_eq!(i.image.as_ref().unwrap().mime, "image/png");
        assert!(i.text.is_none());

        let b = read_attachment(&tmp("data.bin", &[1, 2, 0, 3])).unwrap();
        assert!(b.text.is_none() && b.image.is_none());

        let dir = std::env::temp_dir();
        assert!(read_attachment(&dir).unwrap_err().contains("folder"));
    }

    #[test]
    fn cuts_long_text_on_a_character_boundary() {
        let mut big = "é".repeat((MAX_TEXT_BYTES as usize) / 2);
        big.push_str("tail");
        let t = read_attachment(&tmp("big.txt", big.as_bytes())).unwrap();
        assert!(t.truncated);
        assert!(t.text.unwrap().len() <= MAX_TEXT_BYTES as usize);
    }

    #[test]
    fn only_granted_paths_are_allowed() {
        let g = Granted::default();
        let p = tmp("granted.txt", b"x");
        assert!(!g.allows(&p));
        g.grant([p.clone()]);
        assert!(g.allows(&p));
        assert!(!g.allows(Path::new("/etc/passwd")));
    }
}
