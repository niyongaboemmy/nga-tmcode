//! The API Tester's transport: an HTTP(S) request sent from Rust, so a
//! student's local server (or any public API) answers without the webview's
//! CORS rules. Only http and https; bodies over 5 MB are cut; 30 s timeout.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri_plugin_http::reqwest;

const MAX_BODY: usize = 5 * 1024 * 1024;

#[derive(Deserialize)]
pub struct ApiRequest {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Serialize)]
pub struct ApiResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    /// UTF-8 text, or base64 when `binary`.
    body: String,
    binary: bool,
    size: usize,
    truncated: bool,
    ms: u64,
}

pub(crate) fn check_url(url: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
    match u.scheme() {
        "http" | "https" => Ok(u),
        s => Err(format!("Only http:// and https:// URLs can be requested (not {s}://).")),
    }
}

#[tauri::command]
pub async fn api_request(req: ApiRequest) -> Result<ApiResponse, String> {
    let url = check_url(req.url.trim())?;
    let method = reqwest::Method::from_bytes(req.method.trim().to_uppercase().as_bytes()).map_err(|_| format!("Unknown method {}", req.method))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(concat!("TMCode/", env!("CARGO_PKG_VERSION"), " API Tester"))
        .build()
        .map_err(|e| e.to_string())?;
    let mut rb = client.request(method, url);
    for (k, v) in req.headers.iter().filter(|(k, _)| !k.trim().is_empty()) {
        rb = rb.header(k.trim(), v);
    }
    if let Some(b) = req.body {
        rb = rb.body(b);
    }
    let started = Instant::now();
    let res = rb.send().await.map_err(|e| {
        if e.is_connect() {
            "Could not connect: is the server running?".to_string()
        } else if e.is_timeout() {
            "No answer within 30 seconds.".to_string()
        } else {
            e.to_string()
        }
    })?;
    let status = res.status();
    let headers: Vec<(String, String)> = res.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let ms = started.elapsed().as_millis() as u64;
    let size = bytes.len();
    let truncated = size > MAX_BODY;
    let slice = &bytes[..size.min(MAX_BODY)];
    let (body, binary) = match std::str::from_utf8(slice) {
        Ok(s) => (s.to_string(), false),
        Err(_) => {
            use base64::Engine;
            (base64::engine::general_purpose::STANDARD.encode(slice), true)
        }
    };
    Ok(ApiResponse { status: status.as_u16(), status_text: status.canonical_reason().unwrap_or("").to_string(), headers, body, binary, size, truncated, ms })
}

#[cfg(test)]
mod tests {
    use super::check_url;

    #[test]
    fn only_http_and_https() {
        assert!(check_url("http://localhost:3000/api").is_ok());
        assert!(check_url("https://example.com").is_ok());
        assert!(check_url("file:///etc/passwd").unwrap_err().contains("Only http"));
        assert!(check_url("not a url").unwrap_err().contains("Invalid URL"));
    }
}
