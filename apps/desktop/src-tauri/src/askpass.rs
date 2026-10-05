//! TMCode as git's `GIT_ASKPASS` helper.
//!
//! For an HTTPS push/pull/clone to github.com while signed in, `git.rs` runs
//! git with `GIT_ASKPASS=<this binary>`, `TMCODE_ASKPASS=1` and the
//! credential in `TMCODE_GIT_USER` / `TMCODE_GIT_TOKEN` — set on that one git
//! child only. Git then starts this binary with the prompt as its argument
//! ("Username for 'https://github.com': "); `main` calls `handle()` before
//! anything else (no window, no Tauri), we print the answer and exit.
//! Nothing is written anywhere.

/// The answer to one git prompt, or None (git then fails cleanly).
pub fn answer(prompt: &str, user: Option<&str>, token: Option<&str>) -> Option<String> {
    let p = prompt.trim_start().to_ascii_lowercase();
    if p.starts_with("username") {
        return user.filter(|u| !u.is_empty()).map(str::to_string);
    }
    if p.starts_with("password") {
        return token.filter(|t| !t.is_empty()).map(str::to_string);
    }
    // Anything else (an SSH host-key question, a passphrase) is not ours to answer.
    None
}

/// The prompt git passed: `tmcode "<prompt>"` or `tmcode --askpass "<prompt>"`.
pub fn prompt_from_args(args: &[String]) -> Option<&str> {
    match args.get(1).map(String::as_str) {
        Some("--askpass") => args.get(2).map(String::as_str),
        Some(p) => Some(p),
        None => None,
    }
}

/// Some(exit code) when this process was started as the askpass helper.
pub fn handle() -> Option<i32> {
    if std::env::var("TMCODE_ASKPASS").as_deref() != Ok("1") {
        return None;
    }
    let args: Vec<String> = std::env::args().collect();
    let user = std::env::var("TMCODE_GIT_USER").ok();
    let token = std::env::var("TMCODE_GIT_TOKEN").ok();
    match prompt_from_args(&args).and_then(|p| answer(p, user.as_deref(), token.as_deref())) {
        Some(reply) => {
            use std::io::Write;
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{reply}");
            let _ = out.flush();
            Some(0)
        }
        None => Some(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_username_and_password_prompts() {
        assert_eq!(answer("Username for 'https://github.com': ", Some("x-access-token"), Some("tok")).as_deref(), Some("x-access-token"));
        assert_eq!(answer("Password for 'https://x-access-token@github.com': ", Some("u"), Some("tok")).as_deref(), Some("tok"));
        assert_eq!(answer("Are you sure you want to continue connecting (yes/no)?", Some("u"), Some("tok")), None);
        assert_eq!(answer("Enter passphrase for key '/home/u/.ssh/id_ed25519': ", Some("u"), Some("tok")), None);
        assert_eq!(answer("Password for 'https://github.com': ", Some("u"), None), None);
        assert_eq!(answer("Password: ", Some("u"), Some("")), None);
    }

    #[test]
    fn reads_the_prompt_with_or_without_the_flag() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(prompt_from_args(&v(&["tmcode", "Username for 'https://github.com': "])), Some("Username for 'https://github.com': "));
        assert_eq!(prompt_from_args(&v(&["tmcode", "--askpass", "Password: "])), Some("Password: "));
        assert_eq!(prompt_from_args(&v(&["tmcode"])), None);
        assert_eq!(prompt_from_args(&v(&["tmcode", "--askpass"])), None);
    }

    #[test]
    fn not_askpass_without_the_marker() {
        // The test runner itself never has TMCODE_ASKPASS set.
        if std::env::var("TMCODE_ASKPASS").is_err() {
            assert_eq!(handle(), None);
        }
    }
}
