//! Built-in language servers (review V4): semantic IntelliSense for Python
//! without the student installing an extension. This module only fetches,
//! starts and frames servers (LSP uses the same `Content-Length` framing as
//! DAP); the protocol client lives in TypeScript (workbench `lsp/`).
//!
//! - Python: Pyright (MIT), the npm package's `langserver.index.js --stdio`,
//!   run with the Node.js TMCode already detects. Downloaded once, on request,
//!   from the npm registry, pinned by version and the registry's SHA-512.
//! - Java: Eclipse JDT LS needs a JDK 17+ and a ~50 MB download; not built in
//!   yet (docs/LANGUAGE_SERVERS.md has the plan).
//!
//! Exams: servers are never downloaded in an exam folder, and only start
//! there when the exam's policy allows editor intelligence (`lsp_policy`).

use crate::debug::{app_data, encode, in_exam, DapReader, InstallEvent};
use crate::runner::{Tree, INHERITED_NOISE};
use crate::toolchains::Toolchains;
use crate::workspace::Workspace;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

// ───────────────────────── Pyright (pinned) ─────────────────────────

pub const PYRIGHT_VERSION: &str = "1.1.414";
/// SHA-512 of `pyright-1.1.414.tgz`: the npm registry's `dist.integrity`, in hex.
pub const PYRIGHT_SHA512: &str = "14f6596f9d637a90d7e1e3fb4c460378d16d984dd683092411c269bc7dff426512b23d04032dcb5eefb10784ff1560de8edb179427c5affadb5858f0bb0b97c3";
/// The archive is about 6 MB; anything far bigger is not the real package.
const MAX_DOWNLOAD: usize = 64 * 1024 * 1024;

pub fn pyright_url(version: &str) -> String {
    format!("https://registry.npmjs.org/pyright/-/pyright-{version}.tgz")
}

/// `<app data>/language-servers/pyright/<version>`.
fn pyright_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("language-servers").join("pyright").join(PYRIGHT_VERSION))
}

/// The server script inside an unpacked npm tarball (whose root folder is `package/`).
pub fn pyright_server(dir: &Path) -> PathBuf {
    dir.join("package").join("langserver.index.js")
}

/// Does `bytes` match the pinned SHA-512 (hex)?
pub fn sha512_matches(bytes: &[u8], expected_hex: &str) -> bool {
    use sha2::Digest;
    hex::encode(sha2::Sha512::digest(bytes)) == expected_hex
}

/// The command that runs a server, or why it cannot run.
#[derive(Debug, PartialEq)]
pub struct ServerCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

pub fn server_command(server: &str, node: Option<&Path>, pyright: Option<&Path>) -> Result<ServerCommand, String> {
    match server {
        "pyright" => {
            let node = node.ok_or_else(|| crate::runner::missing_tool_message("node"))?;
            let script = pyright.ok_or("Pyright is not downloaded yet.")?;
            Ok(ServerCommand { program: node.to_path_buf(), args: vec![script.to_string_lossy().into_owned(), "--stdio".into()] })
        }
        "jdtls" => Err("Java IntelliSense is not built in yet.".into()),
        other => Err(format!("Unknown language server '{other}'.")),
    }
}

// ───────────────────────── state ─────────────────────────

struct Server {
    tree: Tree,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

#[derive(Default)]
pub struct LanguageServers {
    /// The current exam's policy allows editor intelligence.
    exam_allowed: AtomicBool,
    next: AtomicU32,
    servers: Mutex<HashMap<u32, Server>>,
}

impl LanguageServers {
    pub fn kill_all(&self) {
        for (_, s) in self.servers.lock().unwrap().drain() {
            s.tree.kill();
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum LspEvent {
    Message { message: String },
    Stderr { data: String },
    Exit { code: Option<i32> },
}

#[derive(Serialize)]
pub struct Probe {
    available: bool,
    /// What can be downloaded to make it available ("pyright").
    install: Option<&'static str>,
    /// e.g. "Pyright 1.1.414 (Node.js v22.3.0)".
    detail: Option<String>,
    message: Option<String>,
    /// Python, for the server's import resolution (`python.pythonPath`).
    python: Option<String>,
}

// ───────────────────────── commands ─────────────────────────

/// Can `server` run on this computer, and if not, what would fix it?
#[tauri::command]
pub async fn lsp_probe(app: AppHandle, server: String) -> Result<Probe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tools = app.state::<Toolchains>();
        let python = tools.get("python").map(|t| t.path);
        let missing = |message: String, install: Option<&'static str>| Probe { available: false, install, detail: None, message: Some(message), python: python.clone() };
        Ok(match server.as_str() {
            "pyright" => match tools.get("node") {
                None => missing(crate::runner::missing_tool_message("node"), None),
                Some(node) => {
                    let script = pyright_dir(&app).ok().map(|d| pyright_server(&d)).filter(|s| s.is_file());
                    match script {
                        None => missing(format!("Python IntelliSense uses Pyright {PYRIGHT_VERSION} (about 6 MB), downloaded once."), Some("pyright")),
                        Some(_) => Probe { available: true, install: None, detail: Some(format!("Pyright {PYRIGHT_VERSION} (Node.js {})", node.version)), message: None, python: python.clone() },
                    }
                }
            },
            other => missing(server_command(other, None, None).err().unwrap_or_default(), None),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Downloads a server (pinned version and checksum). Never during an exam.
#[tauri::command]
pub async fn lsp_install(app: AppHandle, server: String, on_event: Channel<InstallEvent>) -> Result<(), String> {
    if in_exam(&app, &app.state::<Workspace>()) {
        return Err("Language servers are never downloaded during an exam.".into());
    }
    if server != "pyright" {
        return Err(format!("'{server}' cannot be downloaded."));
    }
    use tauri_plugin_http::reqwest;
    let dest = pyright_dir(&app)?;
    if pyright_server(&dest).is_file() {
        return Ok(());
    }
    let url = pyright_url(PYRIGHT_VERSION);
    log::info!("lsp: downloading {url}");
    let mut res = reqwest::Client::new().get(&url).send().await.map_err(|e| format!("Could not download Pyright: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Could not download Pyright (HTTP {}).", res.status()));
    }
    let total = res.content_length();
    let mut bytes = Vec::with_capacity(total.unwrap_or(6_000_000) as usize);
    let mut last = Instant::now();
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("Download interrupted: {e}"))? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_DOWNLOAD {
            return Err("The Pyright download is unexpectedly large.".into());
        }
        if last.elapsed() > Duration::from_millis(80) {
            last = Instant::now();
            let _ = on_event.send(InstallEvent::Progress { downloaded: bytes.len() as u64, total });
        }
    }
    let _ = on_event.send(InstallEvent::Progress { downloaded: bytes.len() as u64, total });
    if !sha512_matches(&bytes, PYRIGHT_SHA512) {
        log::warn!("lsp: pyright checksum mismatch");
        return Err("The downloaded Pyright failed its integrity check and was discarded.".into());
    }
    let dest2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || unpack_npm_tarball(&bytes, &dest2, |d| pyright_server(d).is_file())).await.map_err(|e| e.to_string())??;
    log::info!("lsp: pyright {PYRIGHT_VERSION} installed at {}", dest.display());
    Ok(())
}

/// Unpacks into a sibling temp folder, then renames into place (never a half-written server).
pub fn unpack_npm_tarball(bytes: &[u8], dest: &Path, valid: impl Fn(&Path) -> bool) -> Result<(), String> {
    let parent = dest.parent().ok_or("bad destination")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".partial-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        // unpack_in refuses absolute paths and `..` (no writes outside `tmp`).
        if !entry.unpack_in(&tmp).map_err(|e| e.to_string())? {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("The language server archive contains unsafe paths.".into());
        }
    }
    if !valid(&tmp) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("The archive does not contain the language server.".into());
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

/// The workbench applies an exam policy: `allowed` = the policy's intelligence
/// includes diagnostics. Turning it off stops every server.
#[tauri::command]
pub fn lsp_policy(servers: State<'_, LanguageServers>, allowed: bool) -> Result<(), String> {
    servers.exam_allowed.store(allowed, Ordering::SeqCst);
    if !allowed {
        servers.kill_all();
    }
    Ok(())
}

fn spawn(cmd: &ServerCommand, cwd: &Path) -> std::io::Result<Child> {
    let mut c = Command::new(&cmd.program);
    c.args(&cmd.args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for var in INHERITED_NOISE {
        c.env_remove(var);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c.spawn()
}

/// Starts a server in the open folder. Returns its id for `lsp_send` / `lsp_stop`.
#[tauri::command]
pub fn lsp_start(app: AppHandle, ws: State<'_, Workspace>, tools: State<'_, Toolchains>, servers: State<'_, LanguageServers>, server: String, on_event: Channel<LspEvent>) -> Result<u32, String> {
    if in_exam(&app, &ws) && !servers.exam_allowed.load(Ordering::SeqCst) {
        return Err("Language servers are turned off during this exam.".into());
    }
    let cwd = ws.root()?;
    let node = tools.get("node").map(|t| PathBuf::from(t.path));
    let script = pyright_dir(&app).ok().map(|d| pyright_server(&d)).filter(|s| s.is_file());
    let cmd = server_command(&server, node.as_deref(), script.as_deref())?;
    let mut child = spawn(&cmd, &cwd).map_err(|e| format!("Could not start {server} ({}): {e}", cmd.program.display()))?;
    let id = servers.next.fetch_add(1, Ordering::Relaxed) + 1;
    let tree = Tree::of(child.id());
    log::info!("lsp {id}: {} {:?}", cmd.program.display(), cmd.args);

    if let Some(err) = child.stderr.take() {
        let ch = on_event.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = ch.send(LspEvent::Stderr { data: format!("{line}\n") });
            }
        });
    }
    let stdout = child.stdout.take().ok_or("no server stdout")?;
    let stdin = child.stdin.take().ok_or("no server stdin")?;
    servers.servers.lock().unwrap().insert(id, Server { tree, writer: Arc::new(Mutex::new(Box::new(stdin))) });

    let app2 = app.clone();
    let child = Arc::new(Mutex::new(child));
    std::thread::Builder::new()
        .name(format!("lsp-{id}"))
        .spawn(move || {
            let mut stream: Box<dyn Read + Send> = Box::new(stdout);
            let mut reader = DapReader::default();
            let mut buf = [0u8; 32768];
            'read: loop {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => reader.push(&buf[..n]),
                }
                loop {
                    match reader.next() {
                        Ok(Some(message)) => {
                            if on_event.send(LspEvent::Message { message }).is_err() {
                                break 'read;
                            }
                        }
                        Ok(None) => break,
                        Err(e) => log::warn!("lsp {id}: {e}"),
                    }
                }
            }
            let started = Instant::now();
            let code = loop {
                match child.lock().unwrap().try_wait() {
                    Ok(Some(s)) => break s.code(),
                    Ok(None) if started.elapsed() < Duration::from_secs(2) => std::thread::sleep(Duration::from_millis(20)),
                    _ => break None,
                }
            };
            if let Some(s) = app2.state::<LanguageServers>().servers.lock().unwrap().remove(&id) {
                s.tree.kill();
            }
            let _ = child.lock().unwrap().wait();
            log::info!("lsp {id}: exited ({code:?})");
            let _ = on_event.send(LspEvent::Exit { code });
        })
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Sends one LSP message (JSON text) to a server.
#[tauri::command]
pub fn lsp_send(servers: State<'_, LanguageServers>, id: u32, message: String) -> Result<(), String> {
    let writer = servers.servers.lock().unwrap().get(&id).map(|s| s.writer.clone()).ok_or("The language server has stopped.")?;
    let mut w = writer.lock().unwrap();
    w.write_all(&encode(&message)).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// Stops a server (its whole process tree).
#[tauri::command]
pub fn lsp_stop(servers: State<'_, LanguageServers>, id: u32) -> Result<(), String> {
    if let Some(s) = servers.servers.lock().unwrap().remove(&id) {
        s.tree.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pyright_download_is_pinned() {
        assert_eq!(pyright_url(PYRIGHT_VERSION), "https://registry.npmjs.org/pyright/-/pyright-1.1.414.tgz");
        assert_eq!(PYRIGHT_SHA512.len(), 128);
        assert!(PYRIGHT_SHA512.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert!(sha512_matches(b"abc", "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"));
        assert!(!sha512_matches(b"abd", "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"));
    }

    #[test]
    fn builds_server_commands() {
        let node = Path::new("/usr/bin/node");
        let script = Path::new("/data/pyright/package/langserver.index.js");
        let cmd = server_command("pyright", Some(node), Some(script)).unwrap();
        assert_eq!(cmd.program, node);
        assert_eq!(cmd.args, vec![script.to_string_lossy().into_owned(), "--stdio".to_string()]);
        assert!(server_command("pyright", None, Some(script)).unwrap_err().contains("Node.js"));
        assert!(server_command("pyright", Some(node), None).unwrap_err().contains("not downloaded"));
        assert!(server_command("jdtls", Some(node), None).is_err());
        assert!(server_command("nope", None, None).is_err());
    }

    fn tarball(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        {
            let mut tar = tar::Builder::new(&mut gz);
            for (name, data) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(&mut header, name, *data).unwrap();
            }
            tar.finish().unwrap();
        }
        gz.finish().unwrap()
    }

    #[test]
    fn unpacks_only_a_real_pyright_package() {
        let base = std::env::temp_dir().join(format!("tmcode-lsp-test-{}", std::process::id()));
        let dest = base.join("pyright").join("1");
        let good = tarball(&[("package/package.json", b"{}"), ("package/langserver.index.js", b"//")]);
        unpack_npm_tarball(&good, &dest, |d| pyright_server(d).is_file()).unwrap();
        assert!(pyright_server(&dest).is_file());
        let bad = tarball(&[("package/index.js", b"//")]);
        let other = base.join("pyright").join("2");
        assert!(unpack_npm_tarball(&bad, &other, |d| pyright_server(d).is_file()).is_err());
        assert!(!other.exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
