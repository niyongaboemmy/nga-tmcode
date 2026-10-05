//! The web preview origin (plan §9.1): `tmpreview://localhost/<gen>/<path>`
//! (`http://tmpreview.localhost/...` on Windows) serves one workspace folder,
//! with files the workbench publishes (the injected entry page, React
//! bundles, unsaved edits) taking priority over disk.
//!
//! The preview iframe is sandboxed (opaque origin), so it can't reach the app's
//! IPC; responses carry their own CSP, which blocks the network unless the
//! session allows it. No local port is opened.

use crate::workspace::{resolve, Workspace};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, Runtime, State, UriSchemeContext};

pub const SCHEME: &str = "tmpreview";

#[derive(Default)]
struct Published {
    root: String,
    overlay: HashMap<String, String>,
    internet: bool,
    generation: u64,
}

#[derive(Default)]
pub struct Preview(Mutex<Published>);

const PATH_SEGMENT: &AsciiSet = &CONTROLS.add(b' ').add(b'"').add(b'#').add(b'<').add(b'>').add(b'?').add(b'`').add(b'{').add(b'}').add(b'%');

fn base_url() -> &'static str {
    if cfg!(windows) {
        "http://tmpreview.localhost"
    } else {
        "tmpreview://localhost"
    }
}

#[tauri::command]
pub fn preview_publish(
    ws: State<'_, Workspace>,
    preview: State<'_, Preview>,
    root: String,
    entry: String,
    overlay: HashMap<String, String>,
    internet: bool,
) -> Result<String, String> {
    let ws_root = ws.root()?;
    let dir = resolve(&ws_root, &root)?;
    if !dir.is_dir() {
        return Err(format!("'{root}' is not a folder."));
    }
    let mut p = preview.0.lock().unwrap();
    p.generation += 1;
    p.root = root;
    p.overlay = overlay;
    p.internet = internet;
    let path: String = entry.split('/').map(|s| utf8_percent_encode(s, PATH_SEGMENT).to_string()).collect::<Vec<_>>().join("/");
    // The generation in the path busts any cache between reloads.
    Ok(format!("{}/{}/{}", base_url(), p.generation, path))
}

pub fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" | "jsx" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "md" | "csv" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// The page's own CSP: scripts and styles from the preview origin (inline
/// allowed, it's the student's page), network only when the session allows it.
pub fn csp(internet: bool) -> String {
    let own = format!("{} {}:", base_url(), SCHEME);
    let net = if internet { " https:" } else { "" };
    format!(
        "default-src {own} data: blob:{net}; script-src {own} 'unsafe-inline' 'unsafe-eval' blob:{net}; style-src {own} 'unsafe-inline'{net}; \
         img-src {own} data: blob:{net}; font-src {own} data:{net}; media-src {own} data: blob:{net}; \
         connect-src {}; frame-src 'none'; form-action 'none'; base-uri {own}",
        if internet { "https:" } else { "'none'" }
    )
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>, internet: bool) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Content-Security-Policy", csp(internet))
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap()
}

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let app = ctx.app_handle();
    let raw = request.uri().path().trim_start_matches('/').to_string();
    // "<generation>/<path>"
    let rel = match raw.split_once('/') {
        Some((_, rest)) => percent_decode_str(rest).decode_utf8_lossy().into_owned(),
        None => return respond(StatusCode::NOT_FOUND, "text/plain", b"Not found".to_vec(), false),
    };
    let rel = if rel.is_empty() || rel.ends_with('/') { format!("{rel}index.html") } else { rel };
    let preview = app.state::<Preview>();
    let p = preview.0.lock().unwrap();
    if let Some(text) = p.overlay.get(&rel) {
        return respond(StatusCode::OK, mime_for(&rel), text.clone().into_bytes(), p.internet);
    }
    let Ok(ws_root) = app.state::<Workspace>().root() else {
        return respond(StatusCode::NOT_FOUND, "text/plain", b"No folder is open".to_vec(), p.internet);
    };
    let joined = if p.root.is_empty() { rel.clone() } else { format!("{}/{}", p.root, rel) };
    match resolve(&ws_root, &joined) {
        Ok(path) if path.is_file() => match std::fs::read(&path) {
            Ok(bytes) => respond(StatusCode::OK, mime_for(&rel), bytes, p.internet),
            Err(e) => respond(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", e.to_string().into_bytes(), p.internet),
        },
        _ => respond(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", format!("Not found: {rel}").into_bytes(), p.internet),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exam_previews_have_no_network() {
        let c = csp(false);
        assert!(c.contains("connect-src 'none'"));
        assert!(!c.contains("https:"));
        assert!(csp(true).contains("connect-src https:"));
    }

    #[test]
    fn mime_types() {
        assert_eq!(mime_for("index.html"), "text/html; charset=utf-8");
        assert_eq!(mime_for("img/LOGO.PNG"), "image/png");
        assert_eq!(mime_for("noext"), "application/octet-stream");
    }
}
