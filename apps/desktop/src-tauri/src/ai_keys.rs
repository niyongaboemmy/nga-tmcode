//! The teacher's or student's own AI provider keys ("bring your own key"), kept in the OS
//! keychain like extension secrets (exthost.rs), under their own service name. The workbench
//! reads a key just before each TMCode AI request and sends it to Task Mentor for that request
//! only. Keys are never logged, never written to disk by TMCode and never sent anywhere else.

const SERVICE: &str = "TMCode AI Keys";

/// The providers Task Mentor accepts own keys for (GET /api/tmcode/ai/status `byok_providers`).
const PROVIDERS: &[&str] = &["openai", "anthropic", "gemini", "openrouter", "groq", "deepseek"];

/// Keychain account of one provider's key (only known providers: nothing else is stored here).
pub fn account(provider: &str) -> Result<String, String> {
    let p = provider.trim().to_lowercase();
    if PROVIDERS.contains(&p.as_str()) {
        Ok(p)
    } else {
        Err(format!("Unknown AI provider '{provider}'"))
    }
}

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &account(provider)?).map_err(|e| format!("The system keychain is not available: {e}"))
}

/// A key that is plausible to keep (not empty, one line, not huge).
pub fn valid_key(key: &str) -> bool {
    let k = key.trim();
    !k.is_empty() && k.len() <= 512 && !k.chars().any(|c| c.is_control())
}

#[tauri::command]
pub fn ai_key_set(provider: String, key: String) -> Result<(), String> {
    if !valid_key(&key) {
        return Err("That doesn't look like an API key.".into());
    }
    entry(&provider)?.set_password(key.trim()).map_err(|e| format!("Could not store the key in the system keychain: {e}"))
}

#[tauri::command]
pub fn ai_key_get(provider: String) -> Result<Option<String>, String> {
    match entry(&provider)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read the key from the system keychain: {e}")),
    }
}

#[tauri::command]
pub fn ai_key_delete(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove the key from the system keychain: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_providers_get_an_account() {
        assert_eq!(account("OpenAI").unwrap(), "openai");
        assert_eq!(account(" gemini ").unwrap(), "gemini");
        assert!(account("evil/../x").is_err());
        assert!(account("").is_err());
    }

    #[test]
    fn keys_are_one_plausible_line() {
        assert!(valid_key("sk-abc123"));
        assert!(!valid_key("   "));
        assert!(!valid_key("sk-abc\nsecond"));
        assert!(!valid_key(&"x".repeat(600)));
    }
}
