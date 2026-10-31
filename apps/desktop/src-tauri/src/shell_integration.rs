//! Terminal shell integration, as VS Code injects it: zsh, bash and fish start
//! with a small TMCode script after the user's own startup files. The script
//! marks prompts and commands with OSC 633 so the terminal can draw command
//! decorations, jump between commands and know each exit code. It can also set
//! TMCode's coloured prompt ("auto": only when the user's prompt has no colours).
//! PowerShell and cmd are left as they are.

use std::path::{Path, PathBuf};

const ZSHENV: &str = include_str!("shell_integration/zshenv.zsh");
const ZPROFILE: &str = include_str!("shell_integration/zprofile.zsh");
const ZSHRC: &str = include_str!("shell_integration/zshrc.zsh");
const BASH: &str = include_str!("shell_integration/bash.sh");
const FISH: &str = include_str!("shell_integration/fish.fish");

/// The terminal's `shellIntegration` request from the workbench.
#[derive(serde::Deserialize, Debug, Clone)]
pub struct Request {
    pub enabled: bool,
    /// "auto" | "on" | "off"
    #[serde(default = "auto")]
    pub prompt: String,
}

fn auto() -> String {
    "auto".into()
}

/// How to start the shell instead: its arguments and environment.
#[derive(Debug, PartialEq)]
pub struct Injection {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Writes the scripts under `dir` (only when they changed).
pub fn write_scripts(dir: &Path) -> std::io::Result<()> {
    let files: [(&str, &str); 5] = [
        ("zsh/.zshenv", ZSHENV),
        ("zsh/.zprofile", ZPROFILE),
        ("zsh/.zshrc", ZSHRC),
        ("bash/tmcode.bash", BASH),
        ("fish/fish/vendor_conf.d/tmcode.fish", FISH),
    ];
    for (rel, text) in files {
        let path = dir.join(rel);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(text) {
            continue;
        }
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, text)?;
    }
    Ok(())
}

/// The arguments and environment that load the integration for this shell, or
/// None (unsupported shell, or turned off). Pure: the environment is passed in.
pub fn inject(shell_id: &str, args: &[String], req: &Request, dir: &Path, env: &dyn Fn(&str) -> Option<String>) -> Option<Injection> {
    if !req.enabled {
        return None;
    }
    let prompt = match req.prompt.as_str() {
        "on" | "off" => req.prompt.clone(),
        _ => "auto".into(),
    };
    let login = args.iter().any(|a| a == "-l" || a == "--login");
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    match shell_id {
        "zsh" => {
            let user = env("ZDOTDIR").filter(|d| !d.is_empty()).or_else(|| env("HOME")).unwrap_or_default();
            Some(Injection {
                args: args.to_vec(),
                env: vec![
                    ("ZDOTDIR".into(), s(dir.join("zsh"))),
                    ("TMCODE_USER_ZDOTDIR".into(), user),
                    ("TMCODE_PROMPT".into(), prompt),
                ],
            })
        }
        "bash" => {
            // --init-file only works without --login: the script reads the login files itself.
            let mut env_out = vec![("TMCODE_PROMPT".into(), prompt)];
            if login {
                env_out.push(("TMCODE_SHELL_LOGIN".into(), "1".into()));
            }
            Some(Injection { args: vec!["--init-file".into(), s(dir.join("bash").join("tmcode.bash")), "-i".into()], env: env_out })
        }
        "fish" => {
            let current = env("XDG_DATA_DIRS").unwrap_or_default();
            // Fish's default when XDG_DATA_DIRS is unset; keep it so system completions still load.
            let base = if current.is_empty() { "/usr/local/share:/usr/share".to_string() } else { current.clone() };
            Some(Injection {
                args: args.to_vec(),
                env: vec![
                    ("XDG_DATA_DIRS".into(), format!("{}:{base}", s(dir.join("fish")))),
                    ("TMCODE_FISH_XDG_DATA_DIRS".into(), current),
                    ("TMCODE_PROMPT".into(), prompt),
                ],
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(enabled: bool, prompt: &str) -> Request {
        Request { enabled, prompt: prompt.into() }
    }

    #[test]
    fn zsh_points_zdotdir_at_the_scripts_and_remembers_the_users() {
        let env = |k: &str| (k == "HOME").then(|| "/Users/a".to_string());
        let i = inject("zsh", &["-l".into()], &req(true, "auto"), Path::new("/data/si"), &env).unwrap();
        assert_eq!(i.args, ["-l"]);
        assert!(i.env.contains(&("ZDOTDIR".into(), "/data/si/zsh".into())));
        assert!(i.env.contains(&("TMCODE_USER_ZDOTDIR".into(), "/Users/a".into())));
        assert!(i.env.contains(&("TMCODE_PROMPT".into(), "auto".into())));
        let own = |k: &str| (k == "ZDOTDIR").then(|| "/Users/a/.config/zsh".to_string());
        let i = inject("zsh", &[], &req(true, "on"), Path::new("/d"), &own).unwrap();
        assert!(i.env.contains(&("TMCODE_USER_ZDOTDIR".into(), "/Users/a/.config/zsh".into())));
    }

    #[test]
    fn bash_uses_an_init_file_and_reads_the_login_files_itself() {
        let none = |_: &str| None;
        let i = inject("bash", &["-l".into()], &req(true, "off"), Path::new("/d"), &none).unwrap();
        assert_eq!(i.args, ["--init-file", "/d/bash/tmcode.bash", "-i"]);
        assert!(i.env.contains(&("TMCODE_SHELL_LOGIN".into(), "1".into())));
        assert!(i.env.contains(&("TMCODE_PROMPT".into(), "off".into())));
        let i = inject("bash", &[], &req(true, "auto"), Path::new("/d"), &none).unwrap();
        assert!(!i.env.iter().any(|(k, _)| k == "TMCODE_SHELL_LOGIN"));
    }

    #[test]
    fn fish_adds_a_vendor_conf_dir_and_restores_xdg_data_dirs() {
        let env = |k: &str| (k == "XDG_DATA_DIRS").then(|| "/opt/share".to_string());
        let i = inject("fish", &["-l".into()], &req(true, "auto"), Path::new("/d"), &env).unwrap();
        assert!(i.env.contains(&("XDG_DATA_DIRS".into(), "/d/fish:/opt/share".into())));
        assert!(i.env.contains(&("TMCODE_FISH_XDG_DATA_DIRS".into(), "/opt/share".into())));
        let none = |_: &str| None;
        let i = inject("fish", &[], &req(true, "auto"), Path::new("/d"), &none).unwrap();
        assert!(i.env.contains(&("XDG_DATA_DIRS".into(), "/d/fish:/usr/local/share:/usr/share".into())));
    }

    #[test]
    fn off_or_other_shells_start_unchanged() {
        let none = |_: &str| None;
        assert!(inject("zsh", &[], &req(false, "auto"), Path::new("/d"), &none).is_none());
        for shell in ["powershell", "pwsh", "cmd", "nu", "wsl"] {
            assert!(inject(shell, &[], &req(true, "auto"), Path::new("/d"), &none).is_none());
        }
    }

    #[test]
    fn writes_every_script_once() {
        let dir = std::env::temp_dir().join(format!("tmcode-si-test-{}", std::process::id()));
        write_scripts(&dir).unwrap();
        for f in ["zsh/.zshenv", "zsh/.zprofile", "zsh/.zshrc", "bash/tmcode.bash", "fish/fish/vendor_conf.d/tmcode.fish"] {
            assert!(dir.join(f).is_file(), "{f}");
        }
        write_scripts(&dir).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
