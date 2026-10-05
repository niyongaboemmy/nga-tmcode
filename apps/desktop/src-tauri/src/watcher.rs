//! Watches the open folder so changes made outside TMCode (git pull, another
//! editor, a build writing files) show up in the explorer and in open editors.
//! Events are debounced and sent as workspace-relative paths.

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, EventTarget};

use crate::WORKBENCH;

/// Folders whose churn nobody needs to see (and that can be huge).
const IGNORED: &[&str] = &["node_modules", ".git", "target", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".gradle"];

#[derive(Default)]
pub struct Watcher(Mutex<Option<Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>>>);

/// Workspace-relative "/"-path, or None when the path is outside or ignored.
pub fn relevant(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        if let Component::Normal(p) = c {
            let s = p.to_string_lossy().into_owned();
            if IGNORED.contains(&s.as_str()) || s.ends_with(".tmcode-tmp") || s == ".DS_Store" {
                return None;
            }
            parts.push(s);
        }
    }
    Some(parts.join("/"))
}

impl Watcher {
    /// Starts watching `root` (replacing any previous watch).
    pub fn watch(&self, app: &AppHandle, root: PathBuf) {
        let mut guard = self.0.lock().unwrap();
        *guard = None; // stop the old watcher first
        let app = app.clone();
        let root2 = root.clone();
        let debouncer = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let mut paths: Vec<String> = events.iter().filter_map(|e| relevant(&root2, &e.path)).collect();
            paths.sort();
            paths.dedup();
            if !paths.is_empty() {
                let _ = app.emit_to(EventTarget::webview(WORKBENCH), "fs-changed", paths);
            }
        });
        match debouncer {
            Ok(mut d) => {
                if let Err(e) = d.watcher().watch(&root, RecursiveMode::Recursive) {
                    log::warn!("cannot watch {}: {e}", root.display());
                    return;
                }
                *guard = Some(d);
            }
            Err(e) => log::warn!("file watcher unavailable: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::relevant;
    use std::path::Path;

    #[test]
    fn keeps_workspace_paths_and_drops_noise() {
        let root = Path::new("/w");
        assert_eq!(relevant(root, Path::new("/w/src/main.py")).as_deref(), Some("src/main.py"));
        assert_eq!(relevant(root, Path::new("/w")).as_deref(), Some(""));
        assert_eq!(relevant(root, Path::new("/w/node_modules/x/index.js")), None);
        assert_eq!(relevant(root, Path::new("/w/.git/HEAD")), None);
        assert_eq!(relevant(root, Path::new("/w/.main.py.tmcode-tmp")), None);
        assert_eq!(relevant(root, Path::new("/elsewhere/a")), None);
    }
}
