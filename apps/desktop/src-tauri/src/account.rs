//! "Sign in with NGA": one sign-in gives TMCode both a Central MIS session and
//! a Task Mentor session (docs/PROJECTS_PLAN.md §1).
//!
//! 1. A PKCE pair and a loopback listener on 127.0.0.1:<random port>.
//! 2. The system browser opens MIS `/desktop/signin` (Google works there,
//!    unlike in a webview); MIS form-POSTs `{code, state}` back to the loopback.
//! 3. The code is redeemed at MIS (`/auth/desktop-handoff/redeem`) for the MIS
//!    token, which Task Mentor exchanges (`/api/tmcode/auth/exchange`) for a
//!    TMCode user token.
//!
//! Both tokens live only in the OS keychain and in this process. The webview
//! sees the signed-in user and reaches Task Mentor through `tm_api`, which
//! attaches the token and only allows `/api/tmcode/…` paths.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_http::reqwest;

const SERVICE: &str = "TMCode Account";
const MIS_ACCOUNT: &str = "mis";
const TM_ACCOUNT: &str = "taskmentor";
const WAIT: Duration = Duration::from_secs(300);

/// Where NGA lives. Debug builds can point at local servers with
/// TMCODE_MIS_WEB / TMCODE_MIS_API / TMCODE_TM_API.
#[derive(Clone, Debug, Serialize)]
pub struct Origins {
    pub mis_web: String,
    pub mis_api: String,
    pub tm_api: String,
}

pub fn origins() -> Origins {
    let env = |k: &str, prod: &str| {
        if cfg!(debug_assertions) {
            std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| prod.to_string())
        } else {
            prod.to_string()
        }
    };
    Origins {
        mis_web: env("TMCODE_MIS_WEB", "https://mis.amashuri.com"),
        mis_api: env("TMCODE_MIS_API", "https://api.amashuri.com"),
        tm_api: env("TMCODE_TM_API", "https://taskmentor-api.amashuri.com"),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AccountUser {
    pub id: u64,
    #[serde(default)]
    pub mis_user_id: Option<u64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AccountStatus {
    pub signed_in: bool,
    pub user: Option<AccountUser>,
    pub tm_api: String,
    /// "idle" | "waiting" (browser open) | "completing"
    pub phase: String,
    /// Why the last attempt or check failed, for the UI.
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Account {
    inner: Mutex<Inner>,
    generation: AtomicU64,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    mis: Option<String>,
    tm: Option<String>,
    user: Option<AccountUser>,
    phase: String,
    error: Option<String>,
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("The system keychain is not available: {e}"))
}

fn load(inner: &mut Inner) {
    if inner.loaded {
        return;
    }
    inner.loaded = true;
    inner.mis = entry(MIS_ACCOUNT).ok().and_then(|e| e.get_password().ok());
    inner.tm = entry(TM_ACCOUNT).ok().and_then(|e| e.get_password().ok());
}

fn forget(inner: &mut Inner) {
    for a in [MIS_ACCOUNT, TM_ACCOUNT] {
        if let Ok(e) = entry(a) {
            match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(err) => log::warn!("account: could not remove a keychain entry: {err}"),
            }
        }
    }
    inner.mis = None;
    inner.tm = None;
    inner.user = None;
}

fn status_of(inner: &Inner) -> AccountStatus {
    AccountStatus {
        signed_in: inner.tm.is_some() && inner.mis.is_some() && inner.user.is_some(),
        user: inner.user.clone(),
        tm_api: origins().tm_api,
        phase: if inner.phase.is_empty() { "idle".into() } else { inner.phase.clone() },
        error: inner.error.clone(),
    }
}

/// An exam folder is open: accounts and projects stay out of exams.
fn exam_active(app: &AppHandle) -> bool {
    let ws = app.state::<crate::workspace::Workspace>();
    match (ws.root(), app.path().app_data_dir()) {
        (Ok(root), Ok(data)) => root.starts_with(dunce::canonicalize(data.join("exams")).unwrap_or(data.join("exams"))),
        _ => false,
    }
}

// ── PKCE + loopback ──────────────────────────────────────────────────────

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS randomness");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// PKCE (RFC 7636, S256): a 43-character verifier and its challenge.
pub fn pkce_pair() -> (String, String) {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS randomness");
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// The hand-off code MIS issues is a JWT: three base64url parts.
pub fn plausible_code(c: &str) -> bool {
    c.len() > 40 && c.len() < 4096 && c.split('.').count() == 3 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

fn form_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(&s.replace('+', " ")).decode_utf8_lossy().into_owned()
}

/// Parses `application/x-www-form-urlencoded`.
pub fn parse_form(body: &str) -> Vec<(String, String)> {
    body.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (form_decode(k), form_decode(v)),
            None => (form_decode(p), String::new()),
        })
        .collect()
}

/// Checks one loopback request: `POST /signin` with the right state and a plausible code.
pub fn accept_signin(request_line: &str, body: &str, state: &str) -> Option<String> {
    if !request_line.starts_with("POST /signin ") {
        return None;
    }
    let form = parse_form(body);
    let get = |k: &str| form.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    if get("state").as_deref() != Some(state) {
        return None;
    }
    get("code").filter(|c| plausible_code(c))
}

/// Reads one HTTP request, answers it, and returns the code if it is the right one.
fn handle(mut stream: TcpStream, state: &str) -> Option<String> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                length = v.trim().parse().unwrap_or(0).min(16_384);
            }
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    let code = accept_signin(&request_line, &String::from_utf8_lossy(&body), state);
    let (status, text) = if code.is_some() {
        ("200 OK", "You're signed in to TMCode with your NGA account. You can close this tab and go back to TMCode.")
    } else {
        ("400 Bad Request", "This sign-in link is not valid any more. Start again from TMCode.")
    };
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>TMCode</title><body style=\"font:16px system-ui;margin:15vh auto;max-width:28rem;text-align:center\"><h1 style=\"font-size:20px\">TMCode</h1><p>{text}</p><script>setTimeout(function(){{window.close()}},800)</script>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    code
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("TMCode/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

/// `{"message": "..."}` or `{"error_code", "message"}` from NGA servers, else a generic line.
fn server_message(body: &[u8], fallback: &str) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| fallback.to_string())
}

/// MIS answers `{ success, data: { token, user } }` (older builds: `{ token }`).
pub fn redeemed_token(body: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    v.pointer("/data/token")
        .or_else(|| v.get("token"))
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

#[derive(Deserialize)]
struct Exchanged {
    token: String,
    user: AccountUser,
}

async fn complete(code: &str, verifier: &str) -> Result<(String, String, AccountUser), String> {
    let o = origins();
    let http = client()?;
    let res = http
        .post(format!("{}/auth/desktop-handoff/redeem", o.mis_api))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "code": code, "verifier": verifier }).to_string())
        .send()
        .await
        .map_err(|e| format!("Could not reach NGA (MIS): {}", e.without_url()))?;
    let status = res.status();
    let body = res.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(server_message(&body, "NGA (MIS) did not accept the sign-in. Try again."));
    }
    let mis = redeemed_token(&body).ok_or_else(|| {
        log::warn!("account: MIS redeem reply without a token ({} bytes)", body.len());
        "NGA (MIS) sent an unexpected sign-in reply.".to_string()
    })?;
    let (tm, user) = exchange(&mis).await?;
    Ok((mis, tm, user))
}

/// MIS token → TMCode user token (Task Mentor creates the local account on first use).
async fn exchange(mis_token: &str) -> Result<(String, AccountUser), String> {
    let res = client()?
        .post(format!("{}/api/tmcode/auth/exchange", origins().tm_api))
        .bearer_auth(mis_token)
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "client": "tmcode", "version": env!("CARGO_PKG_VERSION") }).to_string())
        .send()
        .await
        .map_err(|e| format!("Could not reach Task Mentor: {}", e.without_url()))?;
    let status = res.status();
    let body = res.bytes().await.map_err(|e| e.to_string())?;
    if status == reqwest::StatusCode::NOT_FOUND {
        // Task Mentor without the projects API yet (rolled out separately).
        return Err("Task Mentor projects are coming soon: your Task Mentor doesn't offer them yet. Everything else in TMCode works as usual.".into());
    }
    if !status.is_success() {
        return Err(server_message(&body, "Task Mentor did not accept the sign-in."));
    }
    let ex: Exchanged = serde_json::from_slice(&body).map_err(|_| "Task Mentor sent an unexpected sign-in reply.".to_string())?;
    Ok((ex.token, ex.user))
}

fn emit_status(app: &AppHandle) {
    use tauri::Emitter;
    let status = status_of(&app.state::<Account>().inner.lock().unwrap());
    let _ = app.emit("account-changed", status);
}

/// Opens the browser and waits (in the background) for MIS to call back.
#[tauri::command]
pub fn auth_sign_in(app: AppHandle, account: State<'_, Account>) -> Result<(), String> {
    if exam_active(&app) {
        return Err("Signing in is not available during an exam.".into());
    }
    let gen = account.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Cannot listen for the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let state = random_hex(16);
    let (verifier, challenge) = pkce_pair();
    let o = origins();
    let url = format!(
        "{}/desktop/signin?redirect_uri={}&state={}&challenge={}",
        o.mis_web,
        percent_encoding::utf8_percent_encode(&format!("http://127.0.0.1:{port}/signin"), percent_encoding::NON_ALPHANUMERIC),
        state,
        challenge
    );
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| format!("Cannot open the browser: {e}"))?;
    {
        let mut inner = account.inner.lock().unwrap();
        inner.phase = "waiting".into();
        inner.error = None;
    }
    emit_status(&app);
    log::info!("account: waiting for the browser sign-in on 127.0.0.1:{port}");
    std::thread::spawn(move || {
        let account = app.state::<Account>();
        let _ = listener.set_nonblocking(true);
        let deadline = Instant::now() + WAIT;
        let mut code = None;
        while Instant::now() < deadline && account.generation.load(Ordering::SeqCst) == gen {
            match listener.accept() {
                Ok((stream, _)) => {
                    if let Some(c) = handle(stream, &state) {
                        code = Some(c);
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
                Err(_) => break,
            }
        }
        if account.generation.load(Ordering::SeqCst) != gen {
            return; // cancelled or replaced
        }
        let Some(code) = code else {
            let mut inner = account.inner.lock().unwrap();
            inner.phase = "idle".into();
            inner.error = Some("The sign-in timed out. Try again.".into());
            drop(inner);
            emit_status(&app);
            return;
        };
        account.inner.lock().unwrap().phase = "completing".into();
        emit_status(&app);
        let result = tauri::async_runtime::block_on(complete(&code, &verifier));
        let mut inner = account.inner.lock().unwrap();
        inner.phase = "idle".into();
        match result {
            Ok((mis, tm, user)) => {
                let saved = entry(MIS_ACCOUNT).and_then(|e| e.set_password(&mis).map_err(|e| e.to_string())).and_then(|_| entry(TM_ACCOUNT).and_then(|e| e.set_password(&tm).map_err(|e| e.to_string())));
                if let Err(e) = saved {
                    log::warn!("account: keychain save failed: {e}");
                }
                inner.loaded = true;
                inner.mis = Some(mis);
                inner.tm = Some(tm);
                log::info!("account: signed in as user {}", user.id);
                inner.user = Some(user);
                inner.error = None;
            }
            Err(e) => {
                log::warn!("account: sign-in failed: {e}");
                inner.error = Some(e);
            }
        }
        drop(inner);
        emit_status(&app);
    });
    Ok(())
}

#[tauri::command]
pub fn auth_cancel(app: AppHandle, account: State<'_, Account>) {
    account.generation.fetch_add(1, Ordering::SeqCst);
    account.inner.lock().unwrap().phase = "idle".into();
    emit_status(&app);
}

/// The current account, checked with Task Mentor (a revoked session signs out).
#[tauri::command]
pub async fn auth_status(app: AppHandle, refresh: bool) -> Result<AccountStatus, String> {
    let account = app.state::<Account>();
    // Debug builds only: TMCODE_DEV_MIS_TOKEN signs in without the browser (native self-tests).
    if cfg!(debug_assertions) {
        let seed = std::env::var("TMCODE_DEV_MIS_TOKEN").ok().filter(|t| !t.is_empty());
        let needs = account.inner.lock().unwrap().tm.is_none();
        if let (Some(mis), true) = (seed, needs) {
            match exchange(&mis).await {
                Ok((tm, user)) => {
                    let mut inner = account.inner.lock().unwrap();
                    inner.loaded = true;
                    inner.mis = Some(mis);
                    inner.tm = Some(tm);
                    inner.user = Some(user);
                }
                Err(e) => log::warn!("account: dev sign-in failed: {e}"),
            }
        }
    }
    let token = {
        let mut inner = account.inner.lock().unwrap();
        if inner.tm.is_none() {
            load(&mut inner);
        }
        if !refresh && inner.user.is_some() {
            return Ok(status_of(&inner));
        }
        match (&inner.tm, &inner.mis) {
            (Some(tm), Some(_)) => tm.clone(),
            _ => return Ok(status_of(&inner)),
        }
    };
    // Resolve the network part first: the lock is never held across an await.
    enum Outcome {
        Revoked,
        Ok(Vec<u8>),
        Status(u16),
        Offline,
    }
    let outcome = match client()?.get(format!("{}/api/tmcode/auth/me", origins().tm_api)).bearer_auth(&token).send().await {
        Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => Outcome::Revoked,
        Ok(r) if r.status().is_success() => Outcome::Ok(r.bytes().await.map(|b| b.to_vec()).unwrap_or_default()),
        Ok(r) => Outcome::Status(r.status().as_u16()),
        Err(_) => Outcome::Offline,
    };
    let mut inner = account.inner.lock().unwrap();
    match outcome {
        Outcome::Revoked => {
            log::info!("account: Task Mentor ended the session; signing out");
            forget(&mut inner);
            inner.error = Some("Your NGA session ended. Sign in again.".into());
        }
        Outcome::Ok(body) => match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(v) => {
                let user = v.get("user").cloned().unwrap_or(v);
                if let Ok(u) = serde_json::from_value::<AccountUser>(user) {
                    inner.user = Some(u);
                    inner.error = None;
                }
            }
            Err(_) => inner.error = Some("Task Mentor sent an unexpected reply.".into()),
        },
        Outcome::Status(code) => inner.error = Some(format!("Task Mentor is not available right now ({code}).")),
        // Offline: keep the cached user so local work goes on.
        Outcome::Offline => inner.error = Some("Offline: Task Mentor cannot be reached.".into()),
    }
    Ok(status_of(&inner))
}

#[tauri::command]
pub async fn auth_sign_out(app: AppHandle) -> Result<(), String> {
    let mis = {
        let account = app.state::<Account>();
        let mut inner = account.inner.lock().unwrap();
        load(&mut inner);
        let mis = inner.mis.clone();
        forget(&mut inner);
        mis
    };
    // MIS sign-out ends the NGA session everywhere (back-channel logout to every app).
    if let Some(token) = mis {
        if let Ok(http) = client() {
            let _ = http.post(format!("{}/auth/logout", origins().mis_api)).bearer_auth(token).send().await;
        }
    }
    emit_status(&app);
    Ok(())
}

// ── Task Mentor API proxy ─────────────────────────────────────────────────

/// Only Task Mentor's TMCode API, never another path or host.
pub fn valid_tm_path(path: &str) -> bool {
    path.starts_with("/api/tmcode/")
        && !path.contains("..")
        && !path.contains("//")
        && !path.contains('\\')
        && !path.contains('#')
        && path.len() < 2048
        && !path.bytes().any(|b| b.is_ascii_control() || b == b' ')
}

#[derive(Deserialize)]
pub struct TmRequest {
    method: String,
    path: String,
    /// JSON body (sent as application/json).
    #[serde(default)]
    json: Option<serde_json::Value>,
    /// Raw body as base64 (blob uploads), sent with `content_type`.
    #[serde(default)]
    body_base64: Option<String>,
    #[serde(default)]
    content_type: Option<String>,
    /// "json" (default) | "base64" (blob downloads)
    #[serde(default)]
    response: Option<String>,
}

#[derive(Serialize)]
pub struct TmResponse {
    status: u16,
    /// JSON value, or { "base64": "..." } when `response` = "base64".
    body: serde_json::Value,
}

#[tauri::command]
pub async fn tm_api(app: AppHandle, request: TmRequest) -> Result<TmResponse, String> {
    use base64::Engine;
    if !valid_tm_path(&request.path) {
        return Err("Not a Task Mentor TMCode API path.".into());
    }
    if exam_active(&app) {
        return Err("Task Mentor projects are not available during an exam.".into());
    }
    let (token, mis) = {
        let account = app.state::<Account>();
        let mut inner = account.inner.lock().unwrap();
        load(&mut inner);
        (inner.tm.clone().ok_or("Sign in to use Task Mentor projects.")?, inner.mis.clone())
    };
    let method = reqwest::Method::from_bytes(request.method.to_uppercase().as_bytes()).map_err(|_| "Bad method")?;
    let mut req = client()?.request(method, format!("{}{}", origins().tm_api, request.path)).bearer_auth(token);
    // Which subjects the user studies or teaches comes from MIS, and Task Mentor asks MIS
    // with this token: assignments, Start, grading and linkable activities all need it.
    // (Sending it only on /activities and /links left /assignments with no subjects at all:
    // an empty Assignments view and "You aren't enrolled in this assignment's course".)
    // valid_tm_path already limits requests to the Task Mentor API's /api/tmcode/ routes.
    if let Some(mis) = mis {
        req = req.header("X-MIS-Token", mis);
    }
    if let Some(json) = request.json {
        req = req.header("Content-Type", "application/json").body(json.to_string());
    } else if let Some(b64) = request.body_base64 {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "Bad body")?;
        req = req.header("Content-Type", request.content_type.unwrap_or_else(|| "application/octet-stream".into())).body(bytes);
    }
    let res = req.send().await.map_err(|e| format!("Could not reach Task Mentor: {}", e.without_url()))?;
    let status = res.status().as_u16();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if status == 401 {
        let account = app.state::<Account>();
        forget(&mut account.inner.lock().unwrap());
        account.inner.lock().unwrap().error = Some("Your NGA session ended. Sign in again.".into());
        emit_status(&app);
    }
    let body = if request.response.as_deref() == Some("base64") && (200..300).contains(&status) {
        serde_json::json!({ "base64": base64::engine::general_purpose::STANDARD.encode(&bytes) })
    } else if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({ "message": String::from_utf8_lossy(&bytes).chars().take(500).collect::<String>() }))
    };
    Ok(TmResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_the_verifier() {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let (v, c) = pkce_pair();
        assert_eq!(v.len(), 43);
        assert_eq!(c, URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes())));
        assert_ne!(pkce_pair().0, v);
    }

    #[test]
    fn loopback_accepts_only_the_right_state_and_path() {
        let code = "aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb.cccccccccccccccc";
        let body = format!("code={code}&state=s1");
        assert_eq!(accept_signin("POST /signin HTTP/1.1\r\n", &body, "s1").as_deref(), Some(code));
        assert_eq!(accept_signin("POST /signin HTTP/1.1\r\n", &body, "other"), None);
        assert_eq!(accept_signin("GET /signin HTTP/1.1\r\n", &body, "s1"), None);
        assert_eq!(accept_signin("POST /evil HTTP/1.1\r\n", &body, "s1"), None);
        assert_eq!(accept_signin("POST /signin HTTP/1.1\r\n", "code=short&state=s1", "s1"), None);
        assert_eq!(accept_signin("POST /signin HTTP/1.1\r\n", "code=a.b.c%3Cscript%3E&state=s1", "s1"), None);
    }

    #[test]
    fn mis_redeem_reply_shapes() {
        assert_eq!(redeemed_token(br#"{"success":true,"data":{"token":"a.b.c","user":{}}}"#).as_deref(), Some("a.b.c"));
        assert_eq!(redeemed_token(br#"{"token":"x.y.z"}"#).as_deref(), Some("x.y.z"));
        assert_eq!(redeemed_token(br#"{"success":true,"data":{}}"#), None);
        assert_eq!(redeemed_token(b"not json"), None);
    }

    #[test]
    fn form_decoding() {
        assert_eq!(parse_form("a=1+2&b=%2F%3D&c"), vec![("a".into(), "1 2".into()), ("b".into(), "/=".into()), ("c".into(), String::new())]);
    }

    #[test]
    fn tm_paths_are_limited_to_the_tmcode_api() {
        assert!(valid_tm_path("/api/tmcode/projects"));
        assert!(valid_tm_path("/api/tmcode/projects/4/blobs/abc?x=1"));
        assert!(!valid_tm_path("/api/auth/me"));
        assert!(!valid_tm_path("/api/tmcode/../auth/me"));
        assert!(!valid_tm_path("/api/tmcode//x"));
        assert!(!valid_tm_path("https://evil.com/api/tmcode/x"));
        assert!(!valid_tm_path("/api/tmcode/x y"));
        assert!(!valid_tm_path("/api/tmcode/x\n"));
    }

    #[test]
    fn production_origins_are_fixed() {
        let o = origins();
        if !cfg!(debug_assertions) {
            assert_eq!(o.tm_api, "https://taskmentor-api.amashuri.com");
        }
        assert!(o.mis_web.starts_with("http"));
    }
}
