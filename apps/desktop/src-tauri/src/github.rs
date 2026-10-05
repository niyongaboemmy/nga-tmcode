//! "GitHub: Sign in with a Personal Access Token".
//!
//! The token is validated against api.github.com/user, kept in the OS
//! keychain (macOS Keychain, Windows Credential Manager, Secret Service on
//! Linux) and never handed to the webview: the workbench only ever sees the
//! signed-in user. Git uses it through `askpass.rs` for HTTPS github.com
//! remotes; this module also lists the user's repositories for "Clone from GitHub".

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_http::reqwest;

const SERVICE: &str = "TMCode GitHub";
const ACCOUNT: &str = "github.com";
const API: &str = "https://api.github.com";

/// The token, read from the keychain once per run (None inside = not signed in).
#[derive(Default)]
pub struct GitHub(Mutex<Option<Option<String>>>);

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("The system keychain is not available: {e}"))
}

/// The stored token, for git's askpass. Never logged, never sent to the webview.
pub fn stored_token(app: &AppHandle) -> Option<String> {
    let state = app.state::<GitHub>();
    let mut guard = state.0.lock().unwrap();
    if guard.is_none() {
        *guard = Some(entry().ok().and_then(|e| e.get_password().ok()));
    }
    guard.clone().flatten()
}

/// Personal access tokens are long printable ASCII without spaces.
pub fn plausible_token(token: &str) -> bool {
    (20..=255).contains(&token.len()) && token.chars().all(|c| c.is_ascii_graphic())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct User {
    login: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
    /// The avatar as a data: URL (the webview's CSP allows no remote images).
    #[serde(default)]
    avatar: Option<String>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("TMCode/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

async fn get(token: &str, url: &str) -> Result<(reqwest::StatusCode, Vec<u8>), String> {
    let res = client()?
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {}", e.without_url()))?;
    let status = res.status();
    let body = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
    Ok((status, body))
}

async fn fetch_user(token: &str) -> Result<User, String> {
    let (status, body) = get(token, &format!("{API}/user")).await?;
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("GitHub did not accept this token. Check that it is correct and has not expired.".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub answered {status}."));
    }
    let mut user: User = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    user.avatar = match &user.avatar_url {
        Some(url) => avatar_data_url(url).await,
        None => None,
    };
    Ok(user)
}

async fn avatar_data_url(url: &str) -> Option<String> {
    use base64::Engine;
    if !url.starts_with("https://avatars.githubusercontent.com/") {
        return None;
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    let res = client().ok()?.get(format!("{url}{sep}s=64")).send().await.ok()?;
    let mime = res.headers().get("content-type")?.to_str().ok()?.to_string();
    if !mime.starts_with("image/") {
        return None;
    }
    let bytes = res.bytes().await.ok()?;
    (bytes.len() < 512 * 1024).then(|| format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// Validates the token with GitHub and stores it in the keychain.
#[tauri::command]
pub async fn github_sign_in(state: State<'_, GitHub>, token: String) -> Result<User, String> {
    let token = token.trim().to_string();
    if !plausible_token(&token) {
        return Err("That doesn't look like a GitHub personal access token.".into());
    }
    let user = fetch_user(&token).await?;
    entry()?.set_password(&token).map_err(|e| format!("Could not save the token in the system keychain: {e}"))?;
    *state.0.lock().unwrap() = Some(Some(token));
    log::info!("github: signed in as {}", user.login);
    Ok(user)
}

/// The signed-in user, or None. A token GitHub no longer accepts counts as signed out.
#[tauri::command]
pub async fn github_user(app: AppHandle) -> Result<Option<User>, String> {
    let Some(token) = stored_token(&app) else { return Ok(None) };
    match fetch_user(&token).await {
        Ok(u) => Ok(Some(u)),
        Err(e) if e.starts_with("GitHub did not accept") => Ok(None),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn github_sign_out(state: State<'_, GitHub>) -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("Could not remove the token from the system keychain: {e}")),
    }
    *state.0.lock().unwrap() = Some(None);
    log::info!("github: signed out");
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Repo {
    full_name: String,
    #[serde(default)]
    description: Option<String>,
    clone_url: String,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    updated_at: Option<String>,
}

/// The signed-in user's repositories (owned, collaborator, organisation), most recently updated first.
#[tauri::command]
pub async fn github_repos(app: AppHandle) -> Result<Vec<Repo>, String> {
    let token = stored_token(&app).ok_or("Sign in to GitHub first.")?;
    let mut all = Vec::new();
    for page in 1..=10 {
        let url = format!("{API}/user/repos?per_page=100&page={page}&sort=updated&affiliation=owner,collaborator,organization_member");
        let (status, body) = get(&token, &url).await?;
        if !status.is_success() {
            return Err(format!("GitHub answered {status}."));
        }
        let repos: Vec<Repo> = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        let n = repos.len();
        all.extend(repos);
        if n < 100 {
            break;
        }
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_shape_is_checked_before_any_request() {
        assert!(plausible_token("ghp_0123456789abcdefghijABCDEFGHIJ0123"));
        assert!(plausible_token("github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz"));
        assert!(!plausible_token("short"));
        assert!(!plausible_token("has a space in the middle of it ok"));
        assert!(!plausible_token(&"x".repeat(300)));
    }

    #[test]
    fn repos_parse_from_the_api_shape() {
        let json = r#"[{"full_name":"octocat/Hello-World","description":null,"clone_url":"https://github.com/octocat/Hello-World.git","private":false,"updated_at":"2024-01-01T00:00:00Z","extra":1}]"#;
        let repos: Vec<Repo> = serde_json::from_str(json).unwrap();
        assert_eq!(repos[0].full_name, "octocat/Hello-World");
        assert!(crate::git::check_clone_url(&repos[0].clone_url).is_ok());
    }
}
