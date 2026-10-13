//! The JavaScript Console's origin: `tmconsole://localhost/host.html`
//! (`http://tmconsole.localhost/host.html` on Windows).
//!
//! The workbench's own CSP (tauri.conf.json) rightly forbids `eval` and
//! scripts from `blob:` URLs, and a Web Worker started from a `blob:` URL
//! inherits that policy, so student programs and typed expressions were
//! refused ("EvalError", "NetworkError" from importScripts). Like VS Code's
//! webviews, student code runs on its own origin instead: this page, embedded
//! in a hidden `<iframe>`, has a CSP that allows `eval` and `blob:` scripts,
//! starts the console worker and relays its messages. The page's origin is
//! not the workbench's (no access to its DOM or storage) and it never gets
//! Tauri's invoke key (initialisation scripts run in the main frame only), so
//! code run here cannot call TMCode's commands. Exams (`?net=0`) also get no
//! network.

use tauri::http::{Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext};

pub const SCHEME: &str = "tmconsole";

/// The relay: one Web Worker per program, messages both ways, nothing else.
const HOST_HTML: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>TMCode JavaScript Console</title>
<script>
"use strict";
let worker = null;
const up = (m) => parent.postMessage(Object.assign({ tmconsole: true }, m), "*");
addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const m = e.data || {};
  if (m.type === "spawn") {
    if (worker) worker.terminate();
    try {
      worker = new Worker(URL.createObjectURL(new Blob([String(m.source)], { type: "text/javascript" })));
    } catch (err) {
      worker = null;
      return up({ kind: "error", message: "The JavaScript Console couldn't start: " + ((err && err.message) || err) });
    }
    worker.onmessage = (ev) => up({ kind: "message", data: ev.data });
    worker.onerror = (ev) => { ev.preventDefault(); up({ kind: "error", message: ev.message || "The console worker failed" }); };
    up({ kind: "spawned" });
  } else if (m.type === "post") {
    if (worker) worker.postMessage(m.data);
  } else if (m.type === "terminate") {
    if (worker) { worker.terminate(); worker = null; }
  }
});
up({ kind: "ready" });
</script>
"#;

/// The page's CSP: scripts may be evaluated (it's a console), nothing else is loaded;
/// network only outside exams.
pub fn csp(network: bool) -> String {
    let connect = if network { "https: http://localhost:* http://127.0.0.1:*" } else { "'none'" };
    format!("default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src {connect}; img-src data: blob:; style-src 'unsafe-inline'")
}

pub fn handle<R: Runtime>(_ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path().trim_start_matches('/');
    let network = !request.uri().query().unwrap_or("").split('&').any(|kv| kv == "net=0");
    let builder = Response::builder()
        .header("Cache-Control", "no-cache")
        .header("X-Content-Type-Options", "nosniff");
    if path == "host.html" {
        builder
            .status(StatusCode::OK)
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Content-Security-Policy", csp(network))
            .body(HOST_HTML.as_bytes().to_vec())
            .unwrap()
    } else {
        builder.status(StatusCode::NOT_FOUND).header("Content-Type", "text/plain").body(b"Not found".to_vec()).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_csp_allows_eval_but_loads_nothing() {
        let c = csp(true);
        assert!(c.contains("'unsafe-eval'"));
        assert!(c.contains("worker-src blob:"));
        assert!(c.starts_with("default-src 'none'"));
        assert!(!c.contains("ipc:"));
    }

    #[test]
    fn exams_get_no_network() {
        assert!(csp(false).contains("connect-src 'none'"));
        assert!(csp(true).contains("connect-src https:"));
    }
}
