//! The managed device policy (TMCode vibe coding proposal §8.5, A8): a JSON file school IT puts
//! where users can't write, like Claude Code's managed settings. It sets the AI layer when nobody
//! is signed in, the highest layer on this computer, whether AI needs a sign-in, and Industrial
//! always Guided. TMCode only reads it; the workbench parses it (@tmcode/protocol DevicePolicy).
//!
//! macOS: /Library/Application Support/TMCode/policy.json
//! Linux: /etc/tmcode/policy.json
//! Windows: %ProgramData%\TMCode\policy.json

use std::path::PathBuf;

/// Larger files aren't a policy (and aren't read).
const MAX_BYTES: u64 = 64 * 1024;

pub fn policy_path() -> PathBuf {
    if let Ok(p) = std::env::var("TMCODE_DEVICE_POLICY") {
        // Tests and IT dry runs only take effect in debug builds.
        if cfg!(debug_assertions) && !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    #[cfg(target_os = "macos")]
    return PathBuf::from("/Library/Application Support/TMCode/policy.json");
    #[cfg(target_os = "windows")]
    return PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into())).join("TMCode").join("policy.json");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return PathBuf::from("/etc/tmcode/policy.json");
}

/// The file's JSON, or null when there is none. An unreadable file is an error the app shows.
pub fn read_policy(path: &std::path::Path) -> Result<Option<serde_json::Value>, String> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("The device policy {} can't be read: {e}", path.display())),
    };
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return Err(format!("The device policy {} isn't a policy file.", path.display()));
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("The device policy {} can't be read: {e}", path.display()))?;
    serde_json::from_str(&text).map(Some).map_err(|e| format!("The device policy {} isn't valid JSON: {e}", path.display()))
}

#[tauri::command]
pub fn device_policy() -> Result<Option<serde_json::Value>, String> {
    read_policy(&policy_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_no_policy() {
        assert_eq!(read_policy(std::path::Path::new("/nonexistent/tmcode/policy.json")).unwrap(), None);
    }

    #[test]
    fn reads_json_and_refuses_junk() {
        let dir = std::env::temp_dir().join(format!("tmcode-policy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.json");
        std::fs::write(&good, r#"{"signedOutLayer":"learning","requireSignIn":true}"#).unwrap();
        let v = read_policy(&good).unwrap().unwrap();
        assert_eq!(v["signedOutLayer"], "learning");
        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{nope").unwrap();
        assert!(read_policy(&bad).unwrap_err().contains("isn't valid JSON"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
