//! The extension host: runs VS Code extensions' code in the system Node.js.
//!
//! `exthost_start` spawns `node <resources>/exthost.cjs` (bundled from
//! packages/exthost) and relays its stdio to the workbench over a Tauri
//! channel, the same way debug.rs bridges a DAP adapter: the host writes
//! Content-Length-framed JSON-RPC messages on stdout, each one goes to the
//! workbench as text; `exthost_send` frames the workbench's messages onto its
//! stdin. All protocol logic lives in TypeScript; this module only starts,
//! relays and stops processes. The workbench restarts a crashed host.
//!
//! Extension code runs as the user, as in VS Code. It never runs during an
//! exam: the workbench turns the host off (`exthost_policy`) and this side
//! also refuses to start while the open folder is an exam folder.
//!
//! `exthost_secret` backs `ExtensionContext.secrets` with the OS keychain.

use crate::debug::{encode, DapReader};
use crate::runner::{Tree, INHERITED_NOISE};
use crate::toolchains::Toolchains;
use crate::workspace::Workspace;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

pub const SCRIPT: &str = "resources/exthost.cjs";
const SECRET_SERVICE: &str = "TMCode Extensions";

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ExtHostEvent {
    /// One JSON-RPC message (the body of a frame).
    Message { message: String },
    /// Diagnostics the host printed on stderr.
    Stderr { data: String },
    Exit { code: Option<i32> },
}

struct Proc {
    tree: Tree,
    stdin: Arc<Mutex<ChildStdin>>,
}

pub struct ExtHosts {
    /// False during exams (the workbench's policy): nothing may start, running hosts are killed.
    allowed: AtomicBool,
    next: AtomicU32,
    procs: Mutex<HashMap<u32, Proc>>,
}

impl Default for ExtHosts {
    fn default() -> Self {
        ExtHosts { allowed: AtomicBool::new(true), next: AtomicU32::new(0), procs: Mutex::new(HashMap::new()) }
    }
}

impl ExtHosts {
    pub fn kill_all(&self) {
        for (_, p) in self.procs.lock().unwrap().drain() {
            p.tree.kill();
        }
    }

    fn stop(&self, id: u32) {
        if let Some(p) = self.procs.lock().unwrap().remove(&id) {
            p.tree.kill();
        }
    }

    fn send(&self, id: u32, message: &str) -> Result<(), String> {
        let stdin = self.procs.lock().unwrap().get(&id).map(|p| p.stdin.clone()).ok_or("The extension host is not running.")?;
        let mut w = stdin.lock().unwrap();
        w.write_all(&encode(message)).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }
}

/// The `node` command line for the host script.
pub fn host_command(node: &Path, script: &Path) -> (PathBuf, Vec<String>) {
    (
        node.to_path_buf(),
        vec![
            // Extension hosts are long-lived; keep memory bounded on school laptops.
            "--max-old-space-size=3072".into(),
            script.to_string_lossy().into_owned(),
        ],
    )
}

/// Spawns the host and pumps its output into `sink` until it exits. Returns the
/// process (stdin for sending, tree for killing). `on_exit` runs once, after the
/// final `Exit` event was delivered.
pub fn spawn_host(
    node: &Path,
    script: &Path,
    cwd: &Path,
    sink: Arc<dyn Fn(ExtHostEvent) + Send + Sync>,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<(Tree, ChildStdin), String> {
    let (program, args) = host_command(node, script);
    let mut c = Command::new(&program);
    c.args(&args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for var in INHERITED_NOISE {
        c.env_remove(var);
    }
    c.env("TMCODE_EXTHOST", "1");
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
    let mut child: Child = c.spawn().map_err(|e| format!("Could not start Node.js ({}): {e}", program.display()))?;
    let tree = Tree::of(child.id());
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    if let Some(err) = child.stderr.take() {
        let s = sink.clone();
        std::thread::Builder::new()
            .name("exthost-stderr".into())
            .spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    log::info!("exthost: {line}");
                    s(ExtHostEvent::Stderr { data: format!("{line}\n") });
                }
            })
            .map_err(|e| e.to_string())?;
    }
    let child = Arc::new(Mutex::new(child));
    std::thread::Builder::new()
        .name("exthost-stdout".into())
        .spawn(move || {
            let mut reader = DapReader::default();
            let mut out: Box<dyn Read + Send> = Box::new(stdout);
            let mut buf = [0u8; 32768];
            loop {
                match out.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => reader.push(&buf[..n]),
                }
                loop {
                    match reader.next() {
                        Ok(Some(message)) => sink(ExtHostEvent::Message { message }),
                        Ok(None) => break,
                        Err(e) => log::warn!("exthost: {e}"),
                    }
                }
            }
            // stdout closed: collect the exit code (briefly), then report it.
            let started = Instant::now();
            let code = loop {
                match child.lock().unwrap().try_wait() {
                    Ok(Some(s)) => break s.code(),
                    Ok(None) if started.elapsed() < Duration::from_secs(2) => std::thread::sleep(Duration::from_millis(20)),
                    _ => break None,
                }
            };
            tree.kill();
            let _ = child.lock().unwrap().wait();
            sink(ExtHostEvent::Exit { code });
            on_exit();
        })
        .map_err(|e| e.to_string())?;
    Ok((tree, stdin))
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Exam folders live under `<app data>/exams` (see exam.rs).
fn in_exam_folder(app: &AppHandle, ws: &Workspace) -> bool {
    matches!((ws.root(), app_data(app)), (Ok(root), Ok(data)) if root.starts_with(data.join("exams")))
}

fn script_path(app: &AppHandle) -> Result<PathBuf, String> {
    let p = app.path().resolve(SCRIPT, BaseDirectory::Resource).map_err(|e| e.to_string())?;
    if p.is_file() {
        return Ok(p);
    }
    // `tauri dev` runs from target/debug; fall back to the source tree.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(SCRIPT);
    if cfg!(debug_assertions) && dev.is_file() {
        return Ok(dev);
    }
    Err(format!("The extension host script is missing ({}).", p.display()))
}

#[derive(Serialize)]
pub struct Started {
    id: u32,
    /// Absolute folder of installed extensions (`<dir>/<publisher.name>`).
    extensions_dir: String,
    /// Folder for extension storage (globalStorage, workspaceStorage).
    storage_dir: String,
    node: String,
    node_version: String,
}

#[tauri::command]
pub fn exthost_start(app: AppHandle, ws: State<'_, Workspace>, tools: State<'_, Toolchains>, hosts: State<'_, ExtHosts>, on_event: Channel<ExtHostEvent>) -> Result<Started, String> {
    if !hosts.allowed.load(Ordering::SeqCst) || in_exam_folder(&app, &ws) {
        return Err("Extensions are disabled during exams.".into());
    }
    let node = tools.get("node").ok_or("Extensions that run code need Node.js, which was not found on this computer. Install Node.js (nodejs.org) and restart the extension host.")?;
    let script = script_path(&app)?;
    let data = app_data(&app)?;
    let storage = data.join("extension-storage");
    let extensions = data.join("extensions");
    let _ = std::fs::create_dir_all(&storage);
    let cwd = ws.root().ok().or_else(|| app.path().home_dir().ok()).unwrap_or_else(std::env::temp_dir);
    // One Node host per window: a host left by a reloaded webview (or a restart) goes first.
    hosts.kill_all();
    let id = hosts.next.fetch_add(1, Ordering::Relaxed) + 1;
    let channel = on_event.clone();
    let sink: Arc<dyn Fn(ExtHostEvent) + Send + Sync> = Arc::new(move |e| {
        let _ = channel.send(e);
    });
    let app2 = app.clone();
    let (tree, stdin) = spawn_host(Path::new(&node.path), &script, &cwd, sink, move || {
        app2.state::<ExtHosts>().procs.lock().unwrap().remove(&id);
        log::info!("exthost {id}: exited");
    })?;
    hosts.procs.lock().unwrap().insert(id, Proc { tree, stdin: Arc::new(Mutex::new(stdin)) });
    log::info!("exthost {id}: {} {} ({})", node.path, script.display(), node.version);
    Ok(Started {
        id,
        extensions_dir: extensions.to_string_lossy().into_owned(),
        storage_dir: storage.to_string_lossy().into_owned(),
        node: node.path,
        node_version: node.version,
    })
}

/// One JSON-RPC message (text) to the host.
#[tauri::command]
pub fn exthost_send(hosts: State<'_, ExtHosts>, id: u32, message: String) -> Result<(), String> {
    hosts.send(id, &message)
}

#[tauri::command]
pub fn exthost_stop(hosts: State<'_, ExtHosts>, id: u32) -> Result<(), String> {
    hosts.stop(id);
    Ok(())
}

/// The workbench's policy: false during exams (and any locked-down mode) kills every host.
#[tauri::command]
pub fn exthost_policy(hosts: State<'_, ExtHosts>, allowed: bool) -> Result<(), String> {
    hosts.allowed.store(allowed, Ordering::SeqCst);
    if !allowed {
        hosts.kill_all();
    }
    Ok(())
}

/// Keychain account of one secret: "<publisher.name>/<key>".
pub fn secret_account(extension: &str, key: &str) -> Result<String, String> {
    if !crate::extensions::valid_id(extension) {
        return Err("Invalid extension id".into());
    }
    if key.is_empty() || key.len() > 512 || key.contains('\0') {
        return Err("Invalid secret key".into());
    }
    Ok(format!("{extension}/{key}"))
}

fn secret_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SECRET_SERVICE, account).map_err(|e| format!("The system keychain is not available: {e}"))
}

/// The keychain cannot list entries, so each extension keeps an index of its keys.
fn secret_index(extension: &str) -> Vec<String> {
    secret_entry(&format!("{extension}/\u{0}index"))
        .ok()
        .and_then(|e| e.get_password().ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn set_secret_index(extension: &str, keys: &[String]) {
    if let Ok(e) = secret_entry(&format!("{extension}/\u{0}index")) {
        let _ = if keys.is_empty() { e.delete_credential().or(Ok(())) } else { e.set_password(&serde_json::to_string(keys).unwrap_or_default()) };
    }
}

/// `ExtensionContext.secrets`: op = get | store | delete | keys.
#[tauri::command]
pub fn exthost_secret(op: String, extension: String, key: Option<String>, value: Option<String>) -> Result<Option<serde_json::Value>, String> {
    let extension = extension.to_lowercase();
    if op == "keys" {
        if !crate::extensions::valid_id(&extension) {
            return Err("Invalid extension id".into());
        }
        return Ok(Some(serde_json::json!(secret_index(&extension))));
    }
    let key = key.unwrap_or_default();
    let account = secret_account(&extension, &key)?;
    let entry = secret_entry(&account)?;
    match op.as_str() {
        "get" => match entry.get_password() {
            Ok(v) => Ok(Some(serde_json::Value::String(v))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Could not read the secret from the system keychain: {e}")),
        },
        "store" => {
            entry.set_password(&value.unwrap_or_default()).map_err(|e| format!("Could not store the secret in the system keychain: {e}"))?;
            let mut keys = secret_index(&extension);
            if !keys.contains(&key) {
                keys.push(key);
                set_secret_index(&extension, &keys);
            }
            Ok(None)
        }
        "delete" => {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(format!("Could not remove the secret from the system keychain: {e}")),
            }
            let keys: Vec<String> = secret_index(&extension).into_iter().filter(|k| *k != key).collect();
            set_secret_index(&extension, &keys);
            Ok(None)
        }
        _ => Err(format!("Unknown secret operation '{op}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn node() -> Option<PathBuf> {
        Toolchains::default().get("node").map(|t| PathBuf::from(t.path))
    }

    fn script() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(SCRIPT)
    }

    #[test]
    fn secret_accounts_are_scoped_to_valid_extensions() {
        assert_eq!(secret_account("owlco.owl", "token").unwrap(), "owlco.owl/token");
        assert!(secret_account("../x", "token").is_err());
        assert!(secret_account("owlco.owl", "").is_err());
        assert!(secret_account("owlco.owl", "a\0b").is_err());
    }

    #[test]
    fn the_command_line_runs_the_bundled_script() {
        let (program, args) = host_command(Path::new("/usr/bin/node"), Path::new("/app/resources/exthost.cjs"));
        assert_eq!(program, PathBuf::from("/usr/bin/node"));
        assert_eq!(args.last().unwrap(), "/app/resources/exthost.cjs");
        assert!(script().is_file(), "run `node packages/exthost/build.mjs` to bundle the host");
    }

    /// Spawns the real bundled host with the system Node and relays a request
    /// and its response through the same framing the app uses.
    #[test]
    fn spawns_the_host_and_relays_messages() {
        let Some(node) = node() else {
            eprintln!("skipped: no node");
            return;
        };
        let (tx, rx) = mpsc::channel::<ExtHostEvent>();
        let tx = Mutex::new(tx);
        let sink: Arc<dyn Fn(ExtHostEvent) + Send + Sync> = Arc::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        });
        let (exited_tx, exited_rx) = mpsc::channel::<()>();
        let (tree, mut stdin) = spawn_host(&node, &script(), &std::env::temp_dir(), sink, move || {
            let _ = exited_tx.send(());
        })
        .unwrap();
        let wait = |pred: &dyn Fn(&ExtHostEvent) -> bool| -> ExtHostEvent {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                let e = rx.recv_timeout(left).expect("timed out waiting for the extension host");
                if pred(&e) {
                    return e;
                }
            }
        };
        // The host announces itself, then answers a ping.
        wait(&|e| matches!(e, ExtHostEvent::Message { message } if message.contains("$main.ready")));
        stdin.write_all(&encode(r#"{"id":7,"method":"$ping","params":[]}"#)).unwrap();
        stdin.flush().unwrap();
        let reply = wait(&|e| matches!(e, ExtHostEvent::Message { message } if message.contains(r#""id":7"#)));
        let ExtHostEvent::Message { message } = reply else { unreachable!() };
        let v: serde_json::Value = serde_json::from_str(&message).unwrap();
        assert_eq!(v["result"], "pong");
        // Closing stdin makes the host leave; the exit is reported once.
        drop(stdin);
        let exit = wait(&|e| matches!(e, ExtHostEvent::Exit { .. }));
        assert_eq!(exit, ExtHostEvent::Exit { code: Some(0) });
        exited_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        tree.kill();
    }

    #[test]
    fn a_killed_host_reports_its_exit() {
        let Some(node) = node() else { return };
        let (tx, rx) = mpsc::channel::<ExtHostEvent>();
        let tx = Mutex::new(tx);
        let sink: Arc<dyn Fn(ExtHostEvent) + Send + Sync> = Arc::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        });
        let (tree, _stdin) = spawn_host(&node, &script(), &std::env::temp_dir(), sink, || {}).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let ExtHostEvent::Message { message } = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).unwrap() {
                if message.contains("$main.ready") {
                    break;
                }
            }
        }
        tree.kill();
        loop {
            if let ExtHostEvent::Exit { code } = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                assert_ne!(code, Some(0));
                break;
            }
        }
    }
}
