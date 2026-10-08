//! Run and Debug: bridges a Debug Adapter Protocol (DAP) adapter to the
//! workbench. The workbench speaks DAP (JSON messages); this module only
//! starts adapters, frames messages and moves them between the adapter and a
//! Tauri channel, so the protocol logic lives in one place (TypeScript).
//!
//! Adapters (never through a shell, always as a killable process tree):
//! - Python: `python -m debugpy.adapter` over stdio.
//! - JavaScript/TypeScript: Microsoft's js-debug standalone DAP server
//!   (`node dapDebugServer.js <port>`), downloaded on first use with a pinned
//!   SHA-256, over TCP. Its child sessions (`startDebugging`) are extra TCP
//!   connections to the same server (`debug_start` with `parent`).
//! - C/C++: `lldb-dap` (macOS via `xcrun`, Linux on PATH) or GDB 14+ (`gdb -i dap`).
//! - Java: not available yet (Run still works).
//!
//! Debugging is a practice-mode feature: nothing here runs while the open
//! folder is an exam folder (unless the exam's policy turned the debugger on,
//! `debug_policy`), and adapters are never downloaded during an exam.

use crate::runner::{build_dir, program_for, run_piped, run_pty, Context, RunEvent, Runs, Step, Tree, INHERITED_NOISE};
use crate::toolchains::Toolchains;
use crate::workspace::{resolve, Workspace};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

// ───────────────────────── js-debug download (pinned) ─────────────────────────

pub const JS_DEBUG_VERSION: &str = "1.140.0";
/// SHA-256 of `js-debug-dap-v1.140.0.tar.gz` (also GitHub's release asset digest).
pub const JS_DEBUG_SHA256: &str = "27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968";

pub fn js_debug_url(version: &str) -> String {
    format!("https://github.com/microsoft/vscode-js-debug/releases/download/v{version}/js-debug-dap-v{version}.tar.gz")
}

// ───────────────────────── DAP framing ─────────────────────────

/// Frames one DAP message: `Content-Length: N\r\n\r\n<json>`.
pub fn encode(json: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", json.len()).into_bytes();
    out.extend_from_slice(json.as_bytes());
    out
}

/// Incremental parser for the DAP base protocol. Bytes arrive in arbitrary
/// chunks; `next` returns each complete message body.
#[derive(Default)]
pub struct DapReader {
    buf: Vec<u8>,
}

const MAX_MESSAGE: usize = 64 * 1024 * 1024;

impl DapReader {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// The next complete message, `Ok(None)` if more bytes are needed, or an
    /// error for a header that can never become valid (the bad bytes are dropped).
    pub fn next(&mut self) -> Result<Option<String>, String> {
        let Some(end) = self.buf.windows(4).position(|w| w == b"\r\n\r\n") else {
            if self.buf.len() > 8192 {
                self.buf.clear();
                return Err("DAP header too long".into());
            }
            return Ok(None);
        };
        let header = String::from_utf8_lossy(&self.buf[..end]).into_owned();
        let length = header.split("\r\n").find_map(|line| {
            let (k, v) = line.split_once(':')?;
            k.trim().eq_ignore_ascii_case("content-length").then(|| v.trim().parse::<usize>().ok()).flatten()
        });
        let Some(length) = length.filter(|n| *n <= MAX_MESSAGE) else {
            self.buf.drain(..end + 4);
            return Err(format!("bad DAP header: {header:?}"));
        };
        let start = end + 4;
        if self.buf.len() < start + length {
            return Ok(None);
        }
        let body = String::from_utf8_lossy(&self.buf[start..start + length]).into_owned();
        self.buf.drain(..start + length);
        Ok(Some(body))
    }
}

// ───────────────────────── adapter commands ─────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum Transport {
    Stdio,
    /// The adapter is a TCP server on 127.0.0.1:port.
    Tcp(u16),
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdapterCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub transport: Transport,
}

/// What an adapter needs from this computer, gathered separately so command
/// construction is testable.
#[derive(Default, Clone)]
pub struct AdapterEnv {
    pub python: Option<(PathBuf, Vec<String>)>,
    pub node: Option<PathBuf>,
    /// Folder holding `js-debug/src/dapDebugServer.js`.
    pub js_debug: Option<PathBuf>,
    pub lldb_dap: Option<PathBuf>,
    /// GDB and its major version (DAP needs 14+).
    pub gdb: Option<(PathBuf, u32)>,
    /// Delve (Go), `dart` and `flutter`: each has a DAP adapter built in.
    pub dlv: Option<PathBuf>,
    pub dart: Option<PathBuf>,
    pub flutter: Option<PathBuf>,
    /// Java: TMCode's own adapter (`node resources/java-dap.cjs`, JDWP to the JVM) and the JDK's javac.
    pub java_dap: Option<PathBuf>,
    pub javac: Option<PathBuf>,
}

pub fn js_debug_server(dir: &Path) -> PathBuf {
    dir.join("js-debug").join("src").join("dapDebugServer.js")
}

/// The adapter process for a debug type: "python", "node" or "native" (C/C++).
pub fn adapter_command(kind: &str, env: &AdapterEnv, port: u16) -> Result<AdapterCommand, String> {
    match kind {
        "python" => {
            let (py, prefix) = env.python.clone().ok_or_else(|| crate::runner::missing_tool_message("python"))?;
            let mut args = prefix;
            args.extend(["-m".to_string(), "debugpy.adapter".to_string()]);
            Ok(AdapterCommand { program: py, args, transport: Transport::Stdio })
        }
        "node" => {
            let node = env.node.clone().ok_or_else(|| crate::runner::missing_tool_message("node"))?;
            let dir = env.js_debug.clone().ok_or("The JavaScript debugger is not installed yet.")?;
            Ok(AdapterCommand {
                program: node,
                args: vec![js_debug_server(&dir).to_string_lossy().into_owned(), port.to_string(), "127.0.0.1".into()],
                transport: Transport::Tcp(port),
            })
        }
        "native" => {
            if let Some(lldb) = &env.lldb_dap {
                return Ok(AdapterCommand { program: lldb.clone(), args: vec![], transport: Transport::Stdio });
            }
            match &env.gdb {
                Some((gdb, major)) if *major >= 14 => Ok(AdapterCommand { program: gdb.clone(), args: vec!["-i".into(), "dap".into(), "-q".into()], transport: Transport::Stdio }),
                Some((_, major)) => Err(format!("GDB {major} is too old for debugging in TMCode (GDB 14 or newer is needed), and lldb-dap was not found.")),
                None => Err(native_missing_message()),
            }
        }
        // Delve's DAP server listens on a port (it builds the Go program itself).
        "go" => {
            let dlv = env.dlv.clone().ok_or("TMCode could not find Delve (dlv), the Go debugger. Install it with: go install github.com/go-delve/delve/cmd/dlv@latest")?;
            Ok(AdapterCommand { program: dlv, args: vec!["dap".into(), "--listen".into(), format!("127.0.0.1:{port}")], transport: Transport::Tcp(port) })
        }
        "dart" => {
            let dart = env.dart.clone().ok_or("TMCode could not find the Dart SDK (dart). Install Dart or Flutter, then try again.")?;
            Ok(AdapterCommand { program: dart, args: vec!["debug_adapter".into()], transport: Transport::Stdio })
        }
        "flutter" => {
            let flutter = env.flutter.clone().ok_or("TMCode could not find Flutter (flutter). Install the Flutter SDK, then try again.")?;
            Ok(AdapterCommand { program: flutter, args: vec!["debug_adapter".into()], transport: Transport::Stdio })
        }
        "java" => {
            env.javac.as_ref().ok_or("TMCode could not find a Java JDK (javac). Install JDK 17 or newer, then try again.")?;
            let node = env.node.clone().ok_or_else(|| crate::runner::missing_tool_message("node"))?;
            let script = env.java_dap.clone().ok_or("The Java debugger is missing from this TMCode installation (resources/java-dap.cjs).")?;
            Ok(AdapterCommand { program: node, args: vec![script.to_string_lossy().into_owned()], transport: Transport::Stdio })
        }
        other => Err(format!("TMCode can't debug '{other}' programs.")),
    }
}

fn native_missing_message() -> String {
    if cfg!(target_os = "macos") {
        "TMCode could not find lldb-dap. Install the Xcode Command Line Tools (xcode-select --install), then try again.".into()
    } else if cfg!(windows) {
        "TMCode could not find a C/C++ debugger. Install LLVM (lldb-dap) or GDB 14+ and add it to PATH.".into()
    } else {
        "TMCode could not find a C/C++ debugger. Install lldb (lldb-dap) or GDB 14+ (e.g. sudo apt install lldb).".into()
    }
}

/// "GNU gdb (GDB) 14.2" → 14.
pub fn gdb_major(version_line: &str) -> Option<u32> {
    version_line
        .split_whitespace()
        .rev()
        .find_map(|w| w.split('.').next().and_then(|m| m.parse::<u32>().ok()).filter(|_| w.contains('.')))
}

fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"] {
        dirs.push(PathBuf::from(extra));
    }
    for name in names {
        for d in &dirs {
            let p = d.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() });
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn output_of(program: &Path, args: &[&str], timeout: Duration) -> Option<(bool, String)> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
    let out = child.wait_with_output().ok()?;
    Some((out.status.success(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))))
}

/// Delve is usually in $GOPATH/bin (~/go/bin), which isn't always on PATH.
fn find_dlv() -> Option<PathBuf> {
    find_on_path(&["dlv"]).or_else(|| {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
        let gopath = std::env::var_os("GOPATH").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(home).join("go"));
        let p = gopath.join("bin").join(if cfg!(windows) { "dlv.exe" } else { "dlv" });
        p.is_file().then_some(p)
    })
}

fn find_lldb_dap() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        // xcrun pops an "install tools" dialog when the Command Line Tools are missing.
        let has_tools = Command::new("/usr/bin/xcode-select").arg("-p").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
        if has_tools {
            if let Some((true, out)) = output_of(Path::new("/usr/bin/xcrun"), &["-f", "lldb-dap"], Duration::from_secs(10)) {
                let p = PathBuf::from(out.trim());
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    find_on_path(&["lldb-dap", "lldb-vscode", "lldb-dap-18", "lldb-dap-19", "lldb-dap-20"])
}

fn find_gdb() -> Option<(PathBuf, u32)> {
    let gdb = find_on_path(&["gdb"])?;
    let (_, out) = output_of(&gdb, &["--version"], Duration::from_secs(5))?;
    Some((gdb.clone(), gdb_major(out.lines().next().unwrap_or(""))?))
}

// ───────────────────────── state ─────────────────────────

#[derive(Clone, Serialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DebugEvent {
    /// One DAP message (JSON text) from the adapter.
    Message { message: String },
    /// Adapter diagnostics (stderr, server banner).
    Stderr { data: String },
    /// The connection closed; `code` is the adapter's exit code when it was the root.
    Exit { code: Option<i32> },
}

struct Conn {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    tcp: Option<TcpStream>,
    /// Root connection id (itself for a root).
    root: u32,
}

struct Server {
    tree: Tree,
    port: Option<u16>,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Debuggers {
    /// The current exam's policy allows debugging (`policy.debugger`).
    exam_allowed: AtomicBool,
    next: AtomicU32,
    conns: Mutex<HashMap<u32, Conn>>,
    servers: Mutex<HashMap<u32, Server>>,
}

impl Debuggers {
    pub fn kill_all(&self) {
        for (_, s) in self.servers.lock().unwrap().drain() {
            s.stop.store(true, Ordering::SeqCst);
            s.tree.kill();
        }
        for (_, c) in self.conns.lock().unwrap().drain() {
            if let Some(t) = c.tcp {
                let _ = t.shutdown(Shutdown::Both);
            }
        }
    }

    fn stop(&self, id: u32) {
        let root = self.conns.lock().unwrap().get(&id).map(|c| c.root).unwrap_or(id);
        if root == id {
            if let Some(s) = self.servers.lock().unwrap().remove(&id) {
                s.stop.store(true, Ordering::SeqCst);
                s.tree.kill();
            }
            let mut conns = self.conns.lock().unwrap();
            let ids: Vec<u32> = conns.iter().filter(|(_, c)| c.root == id).map(|(k, _)| *k).collect();
            for k in ids {
                if let Some(c) = conns.remove(&k) {
                    if let Some(t) = c.tcp {
                        let _ = t.shutdown(Shutdown::Both);
                    }
                }
            }
        } else if let Some(c) = self.conns.lock().unwrap().remove(&id) {
            if let Some(t) = c.tcp {
                let _ = t.shutdown(Shutdown::Both);
            }
        }
    }
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Is the open folder an exam folder (they live under `<app data>/exams`)?
/// Whether the open folder is an exam's (other modules refuse risky things there too).
pub(crate) fn in_exam(app: &AppHandle, ws: &Workspace) -> bool {
    in_exam_folder(app, ws)
}

fn in_exam_folder(app: &AppHandle, ws: &Workspace) -> bool {
    matches!((ws.root(), app_data(app)), (Ok(root), Ok(data)) if root.starts_with(data.join("exams")))
}

/// Exams are locked down: no debugger unless the exam's policy allows it.
fn refuse_in_exam(app: &AppHandle, ws: &Workspace) -> Result<(), String> {
    if in_exam_folder(app, ws) && !app.state::<Debuggers>().exam_allowed.load(Ordering::SeqCst) {
        return Err("Debugging is turned off during exams.".into());
    }
    Ok(())
}

/// The workbench applies an exam policy: `allowed` = `policy.debugger`.
/// Downloads stay refused in exam folders either way (`debug_install`).
#[tauri::command]
pub fn debug_policy(dbg: State<'_, Debuggers>, allowed: bool) -> Result<(), String> {
    dbg.exam_allowed.store(allowed, Ordering::SeqCst);
    if !allowed {
        // Turning it off ends any session that is still running.
        dbg.kill_all();
    }
    Ok(())
}

fn js_debug_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("debug-adapters").join("js-debug").join(JS_DEBUG_VERSION))
}

pub const JAVA_DAP: &str = "resources/java-dap.cjs";

/// The bundled Java adapter (next to exthost.cjs); in `tauri dev`, the source tree's copy.
fn java_dap_script(app: &AppHandle) -> Option<PathBuf> {
    let p = app.path().resolve(JAVA_DAP, tauri::path::BaseDirectory::Resource).ok().filter(|p| p.is_file());
    p.or_else(|| Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(JAVA_DAP)).filter(|p| cfg!(debug_assertions) && p.is_file()))
}

fn adapter_env(app: &AppHandle, tools: &Toolchains, kind: &str) -> AdapterEnv {
    let mut env = AdapterEnv::default();
    match kind {
        "python" => env.python = tools.get("python").map(|t| (PathBuf::from(t.path), t.prefix_args)),
        "node" => {
            env.node = tools.get("node").map(|t| PathBuf::from(t.path));
            env.js_debug = js_debug_dir(app).ok().filter(|d| js_debug_server(d).is_file());
        }
        "go" => env.dlv = find_dlv(),
        "dart" => env.dart = find_on_path(&["dart"]),
        "flutter" => env.flutter = find_on_path(&["flutter"]),
        "java" => {
            env.node = tools.get("node").map(|t| PathBuf::from(t.path));
            env.javac = tools.get("javac").map(|t| PathBuf::from(t.path)).or_else(|| find_on_path(&["javac"]));
            env.java_dap = java_dap_script(app);
        }
        "native" => {
            env.lldb_dap = find_lldb_dap();
            if env.lldb_dap.is_none() {
                env.gdb = find_gdb();
            }
        }
        _ => {}
    }
    env
}

// ───────────────────────── commands ─────────────────────────

#[derive(Serialize)]
pub struct Probe {
    available: bool,
    /// What can be installed to make it available: "debugpy" or "js-debug".
    install: Option<&'static str>,
    /// The adapter in use, e.g. "debugpy 1.8.21" or a path.
    detail: Option<String>,
    message: Option<String>,
}

/// Can `kind` be debugged on this computer, and if not, what would fix it?
#[tauri::command]
pub async fn debug_probe(app: AppHandle, kind: String) -> Result<Probe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tools = app.state::<Toolchains>();
        let env = adapter_env(&app, &tools, &kind);
        let missing = |message: String, install: Option<&'static str>| Probe { available: false, install, detail: None, message: Some(message) };
        Ok(match kind.as_str() {
            "python" => match &env.python {
                None => missing(crate::runner::missing_tool_message("python"), None),
                Some((py, prefix)) => {
                    let mut args: Vec<&str> = prefix.iter().map(String::as_str).collect();
                    args.extend(["-c", "import debugpy; print(debugpy.__version__)"]);
                    match output_of(py, &args, Duration::from_secs(15)) {
                        Some((true, v)) => Probe { available: true, install: None, detail: Some(format!("debugpy {}", v.trim())), message: None },
                        _ => missing("Debugging Python needs the debugpy package, which is not installed for this Python.".into(), Some("debugpy")),
                    }
                }
            },
            "node" => match (&env.node, &env.js_debug) {
                (None, _) => missing(crate::runner::missing_tool_message("node"), None),
                (Some(_), None) => missing(format!("Debugging JavaScript needs the js-debug adapter (v{JS_DEBUG_VERSION}, about 1.2 MB), downloaded once."), Some("js-debug")),
                (Some(_), Some(_)) => Probe { available: true, install: None, detail: Some(format!("js-debug {JS_DEBUG_VERSION}")), message: None },
            },
            other => match adapter_command(other, &env, 0) {
                Ok(cmd) => Probe { available: true, install: None, detail: Some(cmd.program.to_string_lossy().into_owned()), message: None },
                Err(message) => missing(message, None),
            },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum InstallEvent {
    Output { data: String },
    Progress { downloaded: u64, total: Option<u64> },
}

/// Installs what `debug_probe` asked for: debugpy (`pip install --user`) or js-debug (download).
#[tauri::command]
pub async fn debug_install(app: AppHandle, what: String, on_event: Channel<InstallEvent>) -> Result<(), String> {
    if in_exam_folder(&app, &app.state::<Workspace>()) {
        return Err("Debugger components are never installed during an exam.".into());
    }
    match what.as_str() {
        "debugpy" => {
            let py = app.state::<Toolchains>().get("python").ok_or_else(|| crate::runner::missing_tool_message("python"))?;
            tauri::async_runtime::spawn_blocking(move || {
                let mut args = py.prefix_args.clone();
                args.extend(["-m", "pip", "install", "--user", "--disable-pip-version-check", "debugpy"].map(String::from));
                let stop = Arc::new(AtomicBool::new(false));
                let emit = |e: RunEvent| {
                    let data = match e {
                        RunEvent::Stdout { data } | RunEvent::Stderr { data } => data,
                        RunEvent::Error { message } => message,
                        _ => return,
                    };
                    let _ = on_event.send(InstallEvent::Output { data });
                };
                let home = std::env::temp_dir();
                let exit = run_piped(Path::new(&py.path), &args, &home, "run", None, Duration::from_secs(300), 1024 * 1024, &stop, &mut |_| {}, &emit);
                match exit {
                    RunEvent::Exit { code: Some(0), .. } => Ok(()),
                    RunEvent::Exit { code, .. } => Err(format!("pip install debugpy failed (exit code {}).", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))),
                    _ => Err("pip install debugpy failed.".into()),
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "js-debug" => install_js_debug(&app, &on_event).await,
        other => Err(format!("Unknown debugger component '{other}'.")),
    }
}

async fn install_js_debug(app: &AppHandle, on_event: &Channel<InstallEvent>) -> Result<(), String> {
    use sha2::Digest;
    use tauri_plugin_http::reqwest;
    let dest = js_debug_dir(app)?;
    if js_debug_server(&dest).is_file() {
        return Ok(());
    }
    let url = js_debug_url(JS_DEBUG_VERSION);
    log::info!("debug: downloading {url}");
    let mut res = reqwest::Client::new().get(&url).send().await.map_err(|e| format!("Could not download the JavaScript debugger: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Could not download the JavaScript debugger (HTTP {}).", res.status()));
    }
    let total = res.content_length();
    let mut bytes = Vec::with_capacity(total.unwrap_or(1_300_000) as usize);
    let mut last = Instant::now();
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("Download interrupted: {e}"))? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("The JavaScript debugger download is unexpectedly large.".into());
        }
        if last.elapsed() > Duration::from_millis(80) {
            last = Instant::now();
            let _ = on_event.send(InstallEvent::Progress { downloaded: bytes.len() as u64, total });
        }
    }
    let _ = on_event.send(InstallEvent::Progress { downloaded: bytes.len() as u64, total });
    let digest = hex::encode(sha2::Sha256::digest(&bytes));
    if digest != JS_DEBUG_SHA256 {
        log::warn!("debug: js-debug checksum mismatch: {digest}");
        return Err("The downloaded JavaScript debugger failed its integrity check and was discarded.".into());
    }
    let dest2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || unpack_tar_gz(&bytes, &dest2)).await.map_err(|e| e.to_string())??;
    log::info!("debug: js-debug {JS_DEBUG_VERSION} installed at {}", dest.display());
    Ok(())
}

/// Unpacks into a sibling temp folder, then renames into place (never a half-written adapter).
pub fn unpack_tar_gz(bytes: &[u8], dest: &Path) -> Result<(), String> {
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
            return Err("The debugger archive contains unsafe paths.".into());
        }
    }
    if !js_debug_server(&tmp).is_file() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("The debugger archive does not contain js-debug.".into());
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct PrepareRequest {
    /// Workspace-relative entry file.
    pub entry: String,
    pub build: Vec<Step>,
    pub run: Step,
}

#[derive(Serialize)]
pub struct Prepared {
    /// Absolute workspace root, as the adapter will report paths.
    root: String,
    /// Absolute entry file and its folder (the default cwd).
    entry: String,
    cwd: String,
    /// The run step resolved to a program and arguments (python/node/the built binary).
    program: String,
    args: Vec<String>,
}

/// Resolves a debug target and runs its build steps (C/C++ with `-g -O0`), streaming build output.
#[tauri::command]
pub async fn debug_prepare(app: AppHandle, request: PrepareRequest, on_event: Channel<RunEvent>) -> Result<Prepared, String> {
    let ws = app.state::<Workspace>();
    refuse_in_exam(&app, &ws)?;
    let root = ws.root()?;
    let entry = resolve(&root, &request.entry)?;
    if !entry.is_file() {
        return Err(format!("'{}' does not exist.", request.entry));
    }
    let out = build_dir(&app, &root)?;
    let (build, (program, args)) = {
        let tools = app.state::<Toolchains>();
        let lookup = |t: &str| tools.get(t).map(|tc| (PathBuf::from(tc.path), tc.prefix_args));
        let ctx = Context { out: out.clone(), tools: &lookup };
        let mut build = Vec::new();
        for step in &request.build {
            build.push(program_for(&ctx, step, &entry)?);
        }
        (build, program_for(&ctx, &request.run, &entry)?)
    };
    let cwd = entry.parent().unwrap_or(&root).to_path_buf();
    let cwd2 = cwd.clone();
    let root2 = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if build.is_empty() {
            return Ok(());
        }
        let _ = std::fs::remove_dir_all(&out);
        let _ = std::fs::create_dir_all(&out);
        let stop = Arc::new(AtomicBool::new(false));
        let emit = |e: RunEvent| {
            let _ = on_event.send(e);
        };
        for (program, args) in &build {
            emit(RunEvent::Step { phase: "build".into(), command: crate::runner::display_command(program, args, &root2) });
            let exit = run_piped(program, args, &cwd2, "build", None, Duration::from_secs(60), 512 * 1024, &stop, &mut |_| {}, &emit);
            let ok = matches!(&exit, RunEvent::Exit { code: Some(0), .. });
            emit(exit);
            if !ok {
                return Err("The build failed. See Problems for the errors.".to_string());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Prepared {
        root: root.to_string_lossy().into_owned(),
        entry: entry.to_string_lossy().into_owned(),
        cwd: cwd.to_string_lossy().into_owned(),
        program: program.to_string_lossy().into_owned(),
        args,
    })
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

fn spawn_adapter(cmd: &AdapterCommand, cwd: &Path) -> std::io::Result<Child> {
    let mut c = Command::new(&cmd.program);
    c.args(&cmd.args)
        .current_dir(cwd)
        .stdin(if cmd.transport == Transport::Stdio { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1");
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

fn pump(id: u32, mut stream: Box<dyn Read + Send>, on_event: Channel<DebugEvent>, on_close: impl FnOnce(&Channel<DebugEvent>) + Send + 'static) {
    std::thread::Builder::new()
        .name(format!("dap-{id}"))
        .spawn(move || {
            let mut reader = DapReader::default();
            let mut buf = [0u8; 16384];
            loop {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => reader.push(&buf[..n]),
                }
                loop {
                    match reader.next() {
                        Ok(Some(message)) => {
                            if on_event.send(DebugEvent::Message { message }).is_err() {
                                return;
                            }
                        }
                        Ok(None) => break,
                        Err(e) => log::warn!("debug {id}: {e}"),
                    }
                }
            }
            on_close(&on_event);
        })
        .ok();
}

/// Starts an adapter (or, with `parent`, opens a child-session connection to
/// a TCP adapter that asked for one with `startDebugging`). Returns the
/// connection id for `debug_send` / `debug_stop`.
#[tauri::command]
pub fn debug_start(app: AppHandle, ws: State<'_, Workspace>, tools: State<'_, Toolchains>, dbg: State<'_, Debuggers>, kind: String, parent: Option<u32>, on_event: Channel<DebugEvent>) -> Result<u32, String> {
    refuse_in_exam(&app, &ws)?;
    let id = dbg.next.fetch_add(1, Ordering::Relaxed) + 1;
    if let Some(parent) = parent {
        let root = dbg.conns.lock().unwrap().get(&parent).map(|c| c.root).ok_or("The debug session has ended.")?;
        let port = dbg.servers.lock().unwrap().get(&root).and_then(|s| s.port).ok_or("This debugger does not support child sessions.")?;
        let tcp = TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("Could not connect to the debugger: {e}"))?;
        let _ = tcp.set_nodelay(true);
        let read = tcp.try_clone().map_err(|e| e.to_string())?;
        let write = tcp.try_clone().map_err(|e| e.to_string())?;
        dbg.conns.lock().unwrap().insert(id, Conn { writer: Arc::new(Mutex::new(Box::new(write))), tcp: Some(tcp), root });
        let app2 = app.clone();
        pump(id, Box::new(read), on_event, move |ch| {
            app2.state::<Debuggers>().conns.lock().unwrap().remove(&id);
            let _ = ch.send(DebugEvent::Exit { code: None });
        });
        log::info!("debug {id}: child session of {root}");
        return Ok(id);
    }

    let cwd = ws.root().unwrap_or_else(|_| std::env::temp_dir());
    let port = free_port()?;
    let cmd = adapter_command(&kind, &adapter_env(&app, &tools, &kind), port)?;
    let mut child = spawn_adapter(&cmd, &cwd).map_err(|e| format!("Could not start the debugger ({}): {e}", cmd.program.display()))?;
    let tree = Tree::of(child.id());
    let stop = Arc::new(AtomicBool::new(false));
    log::info!("debug {id}: {} {:?} ({:?})", cmd.program.display(), cmd.args, cmd.transport);

    // Adapter stderr → the Debug Console's diagnostics (and the log).
    if let Some(err) = child.stderr.take() {
        let ch = on_event.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                log::info!("debug {id} stderr: {line}");
                let _ = ch.send(DebugEvent::Stderr { data: format!("{line}\n") });
            }
        });
    }

    let (reader, writer, tcp): (Box<dyn Read + Send>, Box<dyn Write + Send>, Option<TcpStream>) = match cmd.transport {
        Transport::Stdio => (Box::new(child.stdout.take().ok_or("no adapter stdout")?), Box::new(child.stdin.take().ok_or("no adapter stdin")?), None),
        Transport::Tcp(port) => {
            // The server prints a banner when it listens; until then, retry.
            if let Some(out) = child.stdout.take() {
                let ch = on_event.clone();
                std::thread::spawn(move || {
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        let _ = ch.send(DebugEvent::Stderr { data: format!("{line}\n") });
                    }
                });
            }
            let started = Instant::now();
            let tcp = loop {
                match TcpStream::connect(("127.0.0.1", port)) {
                    Ok(s) => break s,
                    Err(e) => {
                        if let Ok(Some(status)) = child.try_wait() {
                            return Err(format!("The debugger exited before it was ready ({status})."));
                        }
                        if started.elapsed() > Duration::from_secs(20) {
                            tree.kill();
                            return Err(format!("The debugger did not start: {e}"));
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            };
            let _ = tcp.set_nodelay(true);
            (Box::new(tcp.try_clone().map_err(|e| e.to_string())?), Box::new(tcp.try_clone().map_err(|e| e.to_string())?), Some(tcp))
        }
    };
    let port = matches!(cmd.transport, Transport::Tcp(_)).then_some(port);
    dbg.servers.lock().unwrap().insert(id, Server { tree, port, stop: stop.clone() });
    dbg.conns.lock().unwrap().insert(id, Conn { writer: Arc::new(Mutex::new(writer)), tcp, root: id });

    let app2 = app.clone();
    let child = Arc::new(Mutex::new(child));
    pump(id, reader, on_event, move |ch| {
        // The adapter closed its end: collect its exit code, then clean up the tree.
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
        let dbg = app2.state::<Debuggers>();
        dbg.servers.lock().unwrap().remove(&id);
        dbg.conns.lock().unwrap().remove(&id);
        log::info!("debug {id}: adapter exited ({code:?})");
        let _ = ch.send(DebugEvent::Exit { code });
    });
    Ok(id)
}

/// Sends one DAP message (JSON text) to the adapter.
#[tauri::command]
pub fn debug_send(dbg: State<'_, Debuggers>, id: u32, message: String) -> Result<(), String> {
    let writer = dbg.conns.lock().unwrap().get(&id).map(|c| c.writer.clone()).ok_or("The debug session has ended.")?;
    let mut w = writer.lock().unwrap();
    w.write_all(&encode(&message)).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// Ends a connection; for a root adapter, kills its whole process tree.
#[tauri::command]
pub fn debug_stop(dbg: State<'_, Debuggers>, id: u32) -> Result<(), String> {
    dbg.stop(id);
    Ok(())
}

#[derive(Deserialize)]
pub struct TerminalRequest {
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, Option<String>>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// Programs an adapter may start through `runInTerminal`: the toolchains and debuggers TMCode found itself.
pub fn terminal_program_allowed(program: &Path, allowed: &[PathBuf]) -> bool {
    let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let p = canon(program);
    allowed.iter().any(|a| canon(a) == p)
}

/// The DAP `runInTerminal` reverse request: runs the debuggee on a pty in the
/// Run console (so `input()` works while debugging). Uses the Run console's
/// input/kill commands (`run_input`, `run_kill`) with the returned id.
#[tauri::command]
pub fn debug_run_in_terminal(app: AppHandle, ws: State<'_, Workspace>, tools: State<'_, Toolchains>, request: TerminalRequest, on_event: Channel<RunEvent>) -> Result<u32, String> {
    refuse_in_exam(&app, &ws)?;
    let root = ws.root()?;
    let (program, args) = request.args.split_first().ok_or("Nothing to run.")?;
    let mut allowed: Vec<PathBuf> = ["python", "node"].iter().filter_map(|t| tools.get(t).map(|tc| PathBuf::from(tc.path))).collect();
    allowed.extend(find_lldb_dap());
    if !terminal_program_allowed(Path::new(program), &allowed) {
        return Err(format!("The debugger asked to run '{program}', which TMCode does not allow."));
    }
    let cwd = match request.cwd.as_deref().filter(|c| !c.is_empty()) {
        Some(c) => {
            let c = dunce::canonicalize(c).map_err(|e| e.to_string())?;
            if !c.starts_with(&root) {
                return Err("The debugger asked to run outside the workspace.".into());
            }
            c
        }
        None => root.clone(),
    };
    let env: Vec<(String, String)> = request.env.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))).collect();
    let runs = app.state::<Runs>();
    let (id, stop) = runs.register();
    let program = PathBuf::from(program);
    let args = args.to_vec();
    let size = (request.cols.unwrap_or(80), request.rows.unwrap_or(24));
    let app2 = app.clone();
    std::thread::Builder::new()
        .name(format!("debuggee-{id}"))
        .spawn(move || {
            let runs = app2.state::<Runs>();
            let emit = |e: RunEvent| {
                let _ = on_event.send(e);
            };
            run_pty(&program, &args, &cwd, size, &env, &stop, id, &runs, &emit);
            runs.finish(id);
        })
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_across_arbitrary_chunks() {
        let a = r#"{"seq":1,"type":"event","event":"initialized"}"#;
        let b = r#"{"seq":2,"type":"response","body":{"text":"héllo ✓"}}"#;
        let mut bytes = encode(a);
        bytes.extend(encode(b));
        // Byte-by-byte delivery (also splits the multi-byte characters).
        let mut r = DapReader::default();
        let mut got = Vec::new();
        for byte in &bytes {
            r.push(std::slice::from_ref(byte));
            while let Some(m) = r.next().unwrap() {
                got.push(m);
            }
        }
        assert_eq!(got, vec![a.to_string(), b.to_string()]);
        // Both at once.
        let mut r = DapReader::default();
        r.push(&bytes);
        assert_eq!(r.next().unwrap().as_deref(), Some(a));
        assert_eq!(r.next().unwrap().as_deref(), Some(b));
        assert_eq!(r.next().unwrap(), None);
    }

    #[test]
    fn content_length_counts_bytes_not_chars() {
        let body = r#"{"x":"✓✓"}"#;
        let framed = String::from_utf8(encode(body)).unwrap();
        assert!(framed.starts_with(&format!("Content-Length: {}\r\n\r\n", body.len())));
        assert_ne!(body.len(), body.chars().count());
    }

    #[test]
    fn extra_headers_and_case_are_accepted_and_garbage_is_dropped() {
        let mut r = DapReader::default();
        r.push(b"content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}");
        assert_eq!(r.next().unwrap().as_deref(), Some("{}"));
        r.push(b"Bogus: 1\r\n\r\nContent-Length: 2\r\n\r\n[]");
        assert!(r.next().is_err());
        assert_eq!(r.next().unwrap().as_deref(), Some("[]"));
        // A partial body waits for more bytes.
        r.push(b"Content-Length: 8\r\n\r\n{\"a\":");
        assert_eq!(r.next().unwrap(), None);
        r.push(b"12}");
        assert_eq!(r.next().unwrap().as_deref(), Some("{\"a\":12}"));
    }

    #[test]
    fn builds_adapter_commands() {
        let env = AdapterEnv {
            python: Some((PathBuf::from("/usr/bin/python3"), vec![])),
            node: Some(PathBuf::from("/opt/node/bin/node")),
            js_debug: Some(PathBuf::from("/data/js-debug/1.140.0")),
            lldb_dap: None,
            gdb: Some((PathBuf::from("/usr/bin/gdb"), 14)),
            ..Default::default()
        };
        let more = AdapterEnv { dlv: Some(PathBuf::from("/go/bin/dlv")), dart: Some(PathBuf::from("/sdk/dart")), flutter: Some(PathBuf::from("/sdk/flutter")), ..Default::default() };
        let go = adapter_command("go", &more, 4711).unwrap();
        assert_eq!(go.args, vec!["dap", "--listen", "127.0.0.1:4711"]);
        assert_eq!(go.transport, Transport::Tcp(4711));
        assert_eq!(adapter_command("dart", &more, 0).unwrap().args, vec!["debug_adapter"]);
        assert_eq!(adapter_command("flutter", &more, 0).unwrap().program, PathBuf::from("/sdk/flutter"));
        assert!(adapter_command("go", &AdapterEnv::default(), 0).unwrap_err().contains("go install github.com/go-delve"));
        let py = adapter_command("python", &env, 0).unwrap();
        assert_eq!(py.program, PathBuf::from("/usr/bin/python3"));
        assert_eq!(py.args, vec!["-m", "debugpy.adapter"]);
        assert_eq!(py.transport, Transport::Stdio);

        let node = adapter_command("node", &env, 4711).unwrap();
        assert_eq!(node.program, PathBuf::from("/opt/node/bin/node"));
        assert_eq!(node.args[0], js_debug_server(Path::new("/data/js-debug/1.140.0")).to_string_lossy());
        assert_eq!(&node.args[1..], ["4711", "127.0.0.1"]);
        assert_eq!(node.transport, Transport::Tcp(4711));

        // No lldb-dap: GDB 14 speaks DAP with `-i dap`.
        let gdb = adapter_command("native", &env, 0).unwrap();
        assert_eq!(gdb.args, vec!["-i", "dap", "-q"]);
        // lldb-dap wins when present.
        let lldb = adapter_command("native", &AdapterEnv { lldb_dap: Some(PathBuf::from("/x/lldb-dap")), ..env.clone() }, 0).unwrap();
        assert_eq!((lldb.program, lldb.args), (PathBuf::from("/x/lldb-dap"), vec![]));
        // GDB 12 is too old.
        let old = adapter_command("native", &AdapterEnv { gdb: Some((PathBuf::from("/usr/bin/gdb"), 12)), ..env.clone() }, 0);
        assert!(old.unwrap_err().contains("GDB 12 is too old"));
        // The Windows `py -3` launcher keeps its prefix.
        let pyw = adapter_command("python", &AdapterEnv { python: Some((PathBuf::from("py"), vec!["-3".into()])), ..env.clone() }, 0).unwrap();
        assert_eq!(pyw.args, vec!["-3", "-m", "debugpy.adapter"]);
        assert!(adapter_command("node", &AdapterEnv { js_debug: None, ..env.clone() }, 1).unwrap_err().contains("not installed"));
        assert!(adapter_command("java", &env, 0).unwrap_err().contains("could not find a Java JDK"));
        let java = AdapterEnv { node: Some(PathBuf::from("/opt/node")), javac: Some(PathBuf::from("/jdk/bin/javac")), java_dap: Some(PathBuf::from("/app/resources/java-dap.cjs")), ..Default::default() };
        let cmd = adapter_command("java", &java, 0).unwrap();
        assert_eq!((cmd.program, cmd.args, cmd.transport), (PathBuf::from("/opt/node"), vec!["/app/resources/java-dap.cjs".to_string()], Transport::Stdio));
        assert!(adapter_command("python", &AdapterEnv::default(), 0).unwrap_err().contains("Python 3"));
    }

    #[test]
    fn parses_gdb_versions() {
        assert_eq!(gdb_major("GNU gdb (GDB) 14.2"), Some(14));
        assert_eq!(gdb_major("GNU gdb (Ubuntu 12.1-0ubuntu1~22.04) 12.1"), Some(12));
        assert_eq!(gdb_major("GNU gdb (GDB) 15.1.90.20240816-git"), Some(15));
        assert_eq!(gdb_major("nonsense"), None);
    }

    #[test]
    fn js_debug_download_is_pinned() {
        assert!(js_debug_url(JS_DEBUG_VERSION).ends_with("/v1.140.0/js-debug-dap-v1.140.0.tar.gz"));
        assert_eq!(JS_DEBUG_SHA256.len(), 64);
    }

    #[test]
    fn unpacks_only_a_real_js_debug_archive() {
        let dir = tempfile::tempdir().unwrap();
        let make = |files: &[(&str, &str)]| {
            let mut b = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
            for (path, body) in files {
                let mut h = tar::Header::new_gnu();
                h.set_size(body.len() as u64);
                h.set_mode(0o644);
                h.set_cksum();
                b.append_data(&mut h, path, body.as_bytes()).unwrap();
            }
            b.into_inner().unwrap().finish().unwrap()
        };
        let dest = dir.path().join("js-debug").join("1.0.0");
        assert!(unpack_tar_gz(&make(&[("README.md", "x")]), &dest).unwrap_err().contains("does not contain"));
        assert!(!dest.exists());
        unpack_tar_gz(&make(&[("js-debug/src/dapDebugServer.js", "//")]), &dest).unwrap();
        assert!(js_debug_server(&dest).is_file());
    }

    #[test]
    fn run_in_terminal_only_starts_known_programs() {
        let dir = tempfile::tempdir().unwrap();
        let py = dir.path().join("python3");
        std::fs::write(&py, "").unwrap();
        let allowed = vec![py.clone()];
        assert!(terminal_program_allowed(&py, &allowed));
        assert!(terminal_program_allowed(&dir.path().join(".").join("python3"), &allowed));
        assert!(!terminal_program_allowed(Path::new("/bin/sh"), &allowed));
    }

    /// A DAP client over a real adapter's stdio, for the end-to-end test below.
    struct TestClient {
        stdin: std::process::ChildStdin,
        rx: std::sync::mpsc::Receiver<serde_json::Value>,
        seen: Vec<serde_json::Value>,
        seq: u64,
    }

    impl TestClient {
        fn new(child: &mut Child) -> TestClient {
            let mut out = child.stdout.take().unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut r = DapReader::default();
                let mut buf = [0u8; 8192];
                while let Ok(n) = out.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    r.push(&buf[..n]);
                    while let Ok(Some(m)) = r.next() {
                        if tx.send(serde_json::from_str(&m).unwrap()).is_err() {
                            return;
                        }
                    }
                }
            });
            TestClient { stdin: child.stdin.take().unwrap(), rx, seen: Vec::new(), seq: 0 }
        }

        fn send(&mut self, command: &str, arguments: serde_json::Value) -> u64 {
            self.seq += 1;
            let msg = serde_json::json!({ "seq": self.seq, "type": "request", "command": command, "arguments": arguments });
            self.stdin.write_all(&encode(&msg.to_string())).unwrap();
            self.stdin.flush().unwrap();
            self.seq
        }

        /// The first message (seen earlier or arriving within 30 s) matching `pred`; it is consumed.
        fn wait(&mut self, what: &str, pred: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
            if let Some(i) = self.seen.iter().position(&pred) {
                return self.seen.remove(i);
            }
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                match self.rx.recv_timeout(left) {
                    Ok(v) if pred(&v) => return v,
                    Ok(v) => self.seen.push(v),
                    Err(_) => panic!("debugpy: no {what}; got {:?}", self.seen),
                }
            }
        }

        fn request(&mut self, command: &str, arguments: serde_json::Value) -> serde_json::Value {
            let seq = self.send(command, arguments);
            let r = self.wait(command, |v| v["type"] == "response" && v["request_seq"] == seq);
            assert_eq!(r["success"], true, "{command} failed: {r}");
            r["body"].clone()
        }

        fn event(&mut self, name: &str) -> serde_json::Value {
            self.wait(name, |v| v["type"] == "event" && v["event"] == name)
        }
    }

    /// The Python to test debugpy with: `TMCODE_TEST_PYTHON`, else the detected one.
    fn python_with_debugpy() -> Option<(PathBuf, Vec<String>)> {
        let (py, prefix) = match std::env::var_os("TMCODE_TEST_PYTHON") {
            Some(p) => (PathBuf::from(p), vec![]),
            None => {
                let tc = crate::toolchains::Toolchains::default().get("python")?;
                (PathBuf::from(tc.path), tc.prefix_args)
            }
        };
        let mut args: Vec<&str> = prefix.iter().map(String::as_str).collect();
        args.extend(["-c", "import debugpy"]);
        matches!(output_of(&py, &args, Duration::from_secs(15)), Some((true, _))).then_some((py, prefix))
    }

    /// A real debug session over `python -m debugpy.adapter` and our framing:
    /// breakpoint → stopped → stack/scopes/variables → evaluate → continue → exit.
    /// Skipped (with a note) when no Python with debugpy is installed; set
    /// `TMCODE_TEST_PYTHON` to a Python that has it to force the run.
    #[test]
    fn debugs_a_real_python_program_with_debugpy() {
        let Some((py, prefix)) = python_with_debugpy() else {
            eprintln!("skipped: no Python with debugpy (pip install debugpy, or set TMCODE_TEST_PYTHON)");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let script = dunce::canonicalize(dir.path()).unwrap().join("main.py");
        std::fs::write(&script, "total = 0\nfor n in [10, 20, 12]:\n    total += n\nanswer = total\nprint('answer', answer)\n").unwrap();
        let cmd = adapter_command("python", &AdapterEnv { python: Some((py.clone(), prefix.clone())), ..Default::default() }, 0).unwrap();
        let mut child = spawn_adapter(&cmd, dir.path()).unwrap();
        let tree = Tree::of(child.id());
        let mut c = TestClient::new(&mut child);

        let caps = c.request("initialize", serde_json::json!({ "clientID": "tmcode", "adapterID": "debugpy", "linesStartAt1": true, "columnsStartAt1": true, "pathFormat": "path" }));
        assert_eq!(caps["supportsConfigurationDoneRequest"], true);
        let mut python = vec![py.to_string_lossy().into_owned()];
        python.extend(prefix);
        let launch = c.send(
            "launch",
            serde_json::json!({ "type": "python", "request": "launch", "name": "test", "program": script, "cwd": dir.path(), "console": "internalConsole", "python": python, "justMyCode": true }),
        );
        c.event("initialized");
        let path = script.to_string_lossy().into_owned();
        let bps = c.request("setBreakpoints", serde_json::json!({ "source": { "path": path }, "breakpoints": [{ "line": 4 }] }));
        assert_eq!(bps["breakpoints"][0]["verified"], true, "{bps}");
        c.request("setExceptionBreakpoints", serde_json::json!({ "filters": [] }));
        c.request("configurationDone", serde_json::json!({}));
        c.wait("launch response", |v| v["type"] == "response" && v["request_seq"] == launch);

        let stopped = c.event("stopped");
        assert_eq!(stopped["body"]["reason"], "breakpoint");
        let thread = stopped["body"]["threadId"].clone();
        let frames = c.request("stackTrace", serde_json::json!({ "threadId": thread, "levels": 20 }));
        let top = &frames["stackFrames"][0];
        assert_eq!(top["line"], 4);
        assert!(top["source"]["path"].as_str().unwrap().ends_with("main.py"));
        let frame = top["id"].clone();
        let scopes = c.request("scopes", serde_json::json!({ "frameId": frame }));
        let locals = scopes["scopes"][0]["variablesReference"].clone();
        let vars = c.request("variables", serde_json::json!({ "variablesReference": locals }));
        let total = vars["variables"].as_array().unwrap().iter().find(|v| v["name"] == "total").expect("total in locals");
        assert_eq!(total["value"], "42");
        let eval = c.request("evaluate", serde_json::json!({ "expression": "total * 2", "frameId": frame, "context": "repl" }));
        assert_eq!(eval["result"], "84");

        c.request("continue", serde_json::json!({ "threadId": thread }));
        let mut printed = String::new();
        loop {
            let v = c.wait("output or exit", |v| v["type"] == "event" && (v["event"] == "output" || v["event"] == "exited" || v["event"] == "terminated"));
            match v["event"].as_str() {
                Some("output") => printed.push_str(v["body"]["output"].as_str().unwrap_or("")),
                Some("exited") => {
                    assert_eq!(v["body"]["exitCode"], 0);
                    break;
                }
                _ => break,
            }
        }
        // stdout may arrive before or after `exited`; give it a moment.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !printed.contains("answer 42") && Instant::now() < deadline {
            if let Ok(v) = c.rx.recv_timeout(Duration::from_millis(200)) {
                if v["event"] == "output" {
                    printed.push_str(v["body"]["output"].as_str().unwrap_or(""));
                }
            }
        }
        for v in &c.seen {
            if v["event"] == "output" {
                printed.push_str(v["body"]["output"].as_str().unwrap_or(""));
            }
        }
        assert!(printed.contains("answer 42"), "program output: {printed:?}");
        let _ = c.send("disconnect", serde_json::json!({ "terminateDebuggee": true }));
        tree.kill();
        let _ = child.wait();
    }
}
