//! Extension webviews (`window.createWebviewPanel`, `registerWebviewViewProvider`):
//! the origin their pages and resources come from.
//!
//! - `tmwebview://localhost/<handle>/index.html` (`http://tmwebview.localhost/…`
//!   on Windows) serves the page the workbench published for one webview: the
//!   extension's HTML with TMCode's prelude (acquireVsCodeApi, theme variables).
//! - `tmwebview://localhost/<handle>/file/<absolute path>` serves one file under
//!   that webview's `localResourceRoots` (what `webview.asWebviewUri` returns).
//!
//! The workbench embeds these pages in a sandboxed `<iframe>` without
//! `allow-same-origin`: the page has an opaque origin, so it cannot reach the
//! workbench's DOM, and it never gets Tauri's invoke key (initialisation
//! scripts run in the main frame only), so it cannot call commands. The page's
//! own CSP (below) also keeps `ipc:` out of `connect-src`. Nothing is served
//! while extensions are blocked (exams).

use crate::exthost::ExtHosts;
use crate::workspace::Workspace;
use percent_encoding::percent_decode_str;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, State, UriSchemeContext};

pub const SCHEME: &str = "tmwebview";

struct Page {
    html: String,
    /// Canonical folders `file/…` requests may read from.
    roots: Vec<PathBuf>,
}

#[derive(Default)]
pub struct Webviews(Mutex<HashMap<String, Page>>);

impl Webviews {
    pub fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

pub fn base_url() -> &'static str {
    if cfg!(windows) {
        "http://tmwebview.localhost"
    } else {
        "tmwebview://localhost"
    }
}

fn valid_handle(h: &str) -> bool {
    !h.is_empty() && h.len() <= 64 && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Publishes (or replaces) one webview's page; returns its URL.
#[tauri::command]
pub fn webview_publish(
    app: AppHandle,
    ws: State<'_, Workspace>,
    hosts: State<'_, ExtHosts>,
    views: State<'_, Webviews>,
    handle: String,
    html: String,
    roots: Vec<String>,
) -> Result<String, String> {
    if !hosts.is_allowed() || crate::exthost::in_exam_folder(&app, &ws) {
        return Err("Extensions are disabled during exams.".into());
    }
    if !valid_handle(&handle) {
        return Err("Invalid webview handle.".into());
    }
    let roots = roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).collect();
    views.0.lock().unwrap().insert(handle.clone(), Page { html, roots });
    Ok(format!("{}/{}/index.html", base_url(), handle))
}

#[tauri::command]
pub fn webview_dispose(views: State<'_, Webviews>, handle: String) -> Result<(), String> {
    views.0.lock().unwrap().remove(&handle);
    Ok(())
}

/// The page's CSP. The extension's own `<meta>` CSP applies on top of it (both
/// are enforced). Inline scripts are allowed here because TMCode's prelude is
/// inline; an extension that uses nonces still restricts its own page with them.
pub fn csp() -> String {
    let own = format!("{} {}:", base_url(), SCHEME);
    format!(
        "default-src 'none'; script-src {own} 'unsafe-inline' 'unsafe-eval' https: blob: data:; style-src {own} 'unsafe-inline' https: data:; \
         img-src {own} https: http: data: blob:; font-src {own} https: data:; media-src {own} https: data: blob:; \
         connect-src {own} https: wss: ws: http://localhost:* http://127.0.0.1:* data: blob:; \
         frame-src {own} https: http://localhost:* http://127.0.0.1:*; worker-src {own} blob: data:; child-src {own} blob:; \
         form-action 'none'; base-uri {own}"
    )
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>, page: bool) -> Response<Vec<u8>> {
    let mut b = Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache")
        .header("X-Content-Type-Options", "nosniff");
    if page {
        b = b.header("Content-Security-Policy", csp());
    }
    b.body(body).unwrap()
}

/// "Users/me/x.js" (Unix, leading slash stripped by the URL) or "C:/Users/me/x.js" (Windows) → a path.
fn file_path(rest: &str) -> PathBuf {
    if cfg!(windows) {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' {
            return PathBuf::from(rest.replace('/', "\\"));
        }
        return PathBuf::from(format!("\\\\{}", rest.replace('/', "\\")));
    }
    PathBuf::from(format!("/{rest}"))
}

/// The file at `requested`, if it lies inside one of `roots` (after resolving symlinks and `..`).
pub fn allowed_file(roots: &[PathBuf], requested: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(requested).ok()?;
    if !real.is_file() {
        return None;
    }
    roots.iter().any(|r| real.starts_with(r)).then_some(real)
}

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let app = ctx.app_handle();
    if !app.state::<ExtHosts>().is_allowed() {
        return respond(StatusCode::FORBIDDEN, "text/plain", b"Extensions are disabled.".to_vec(), false);
    }
    let raw = request.uri().path().trim_start_matches('/');
    let Some((handle, rest)) = raw.split_once('/') else {
        return respond(StatusCode::NOT_FOUND, "text/plain", b"Not found".to_vec(), false);
    };
    let views = app.state::<Webviews>();
    let pages = views.0.lock().unwrap();
    let Some(page) = pages.get(handle) else {
        return respond(StatusCode::NOT_FOUND, "text/plain", b"This webview is gone.".to_vec(), false);
    };
    if rest == "index.html" {
        return respond(StatusCode::OK, "text/html; charset=utf-8", page.html.clone().into_bytes(), true);
    }
    let Some(file) = rest.strip_prefix("file/") else {
        return respond(StatusCode::NOT_FOUND, "text/plain", b"Not found".to_vec(), false);
    };
    let decoded = percent_decode_str(file).decode_utf8_lossy().into_owned();
    let requested = file_path(&decoded);
    match allowed_file(&page.roots, &requested) {
        Some(path) => match std::fs::read(&path) {
            Ok(bytes) => respond(StatusCode::OK, crate::preview::mime_for(&decoded), bytes, false),
            Err(e) => respond(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", e.to_string().into_bytes(), false),
        },
        // Outside localResourceRoots, or missing: VS Code answers both with a 404 too.
        None => respond(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", format!("Not found: {decoded}").into_bytes(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_are_plain_ids() {
        assert!(valid_handle("wv-12_a"));
        assert!(!valid_handle(""));
        assert!(!valid_handle("../x"));
        assert!(!valid_handle("a/b"));
    }

    #[test]
    fn page_csp_keeps_ipc_out() {
        let c = csp();
        assert!(!c.contains("ipc:"));
        assert!(!c.contains("ipc.localhost"));
        assert!(c.contains("form-action 'none'"));
        let connect = c.split(';').find(|d| d.trim_start().starts_with("connect-src")).unwrap();
        assert!(!connect.contains(" http: "), "no blanket http: in connect-src (http://ipc.localhost on Windows)");
    }

    #[test]
    fn files_must_stay_inside_roots() {
        let dir = std::env::temp_dir().join(format!("tmcode-webview-test-{}", std::process::id()));
        let inside = dir.join("ext");
        std::fs::create_dir_all(inside.join("media")).unwrap();
        std::fs::write(inside.join("media/a.js"), "x").unwrap();
        std::fs::write(dir.join("secret.txt"), "s").unwrap();
        let roots = vec![std::fs::canonicalize(&inside).unwrap()];
        assert!(allowed_file(&roots, &inside.join("media/a.js")).is_some());
        assert!(allowed_file(&roots, &inside.join("media/../../secret.txt")).is_none());
        assert!(allowed_file(&roots, &dir.join("secret.txt")).is_none());
        assert!(allowed_file(&roots, &inside.join("missing.js")).is_none());
        assert!(allowed_file(&[], &inside.join("media/a.js")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn unix_paths_get_their_slash_back() {
        assert_eq!(file_path("Users/me/x.js"), PathBuf::from("/Users/me/x.js"));
    }
}
