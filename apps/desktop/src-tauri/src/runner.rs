//! Runs student code locally, for feedback only (the grade is always a server
//! re-run). A run is a profile's build steps then its run step; every step
//! names a *tool* resolved here, never a program path from the UI, and the
//! "exe" tool may only start a binary the build wrote into the run's output
//! folder.
//!
//! Two modes:
//! - `pty`: interactive "Run" — the program sees a terminal, so `input()`
//!   prompts, echo and line editing behave as in a real console.
//! - `pipe`: tests — stdin is fed in full, output is captured and capped.
//!
//! Every run can be killed as a whole process tree (process group on Unix, a
//! Job Object on Windows) and has a wall-clock limit in pipe mode.

use crate::toolchains::Toolchains;
use crate::workspace::{resolve, Workspace};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

#[derive(Deserialize, Clone, Debug)]
pub struct Step {
    pub tool: String,
    pub args: Vec<String>,
}

#[derive(Deserialize, Debug)]
pub struct RunRequest {
    /// Workspace-relative entry file (e.g. "task1/main.py").
    pub entry: String,
    pub build: Vec<Step>,
    pub run: Step,
    /// "pty" (interactive) or "pipe" (tests).
    pub mode: String,
    /// Pipe mode: the whole stdin, then EOF.
    pub stdin: Option<String>,
    pub timeout_ms: Option<u64>,
    pub output_limit_kb: Option<usize>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// "Run with Arguments…": appended to the run step as-is (no token expansion).
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RunEvent {
    /// A step starts; `command` is shown to the student ("$ python3 -u main.py").
    Step { phase: String, command: String },
    Stdout { data: String },
    Stderr { data: String },
    Exit {
        phase: String,
        code: Option<i32>,
        timed_out: bool,
        truncated: bool,
        killed: bool,
        duration_ms: u64,
    },
    Error { message: String },
}

/// How to stop a run's whole process tree.
#[derive(Clone, Copy)]
pub struct Tree {
    #[cfg(unix)]
    pgid: i32,
    #[cfg(windows)]
    job: isize,
}

impl Tree {
    /// The tree led by `pid` (a process group leader on Unix; assigned to a new Job Object on Windows).
    pub(crate) fn of(pid: u32) -> Tree {
        #[cfg(unix)]
        {
            Tree { pgid: pid as i32 }
        }
        #[cfg(windows)]
        {
            job_for(pid).unwrap_or(Tree { job: 0 })
        }
    }

    pub(crate) fn kill(&self) {
        #[cfg(unix)]
        unsafe {
            libc::killpg(self.pgid, libc::SIGKILL);
        }
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job as _, 1);
        }
    }
}

#[cfg(windows)]
fn job_for(pid: u32) -> Option<Tree> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if !process.is_null() {
            AssignProcessToJobObject(job, process);
            CloseHandle(process);
        }
        Some(Tree { job: job as isize })
    }
}

struct Session {
    stdin: Option<Box<dyn Write + Send>>,
    tree: Option<Tree>,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Runs {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

impl Runs {
    /// Registers a run started elsewhere (a debuggee in the Run console) so
    /// `run_input` / `run_kill` reach it. Returns its id and stop flag.
    pub(crate) fn register(&self) -> (u32, Arc<AtomicBool>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let stop = Arc::new(AtomicBool::new(false));
        self.sessions.lock().unwrap().insert(id, Session { stdin: None, tree: None, stop: stop.clone() });
        (id, stop)
    }

    pub(crate) fn finish(&self, id: u32) {
        self.sessions.lock().unwrap().remove(&id);
    }

    pub fn kill_all(&self) {
        for (_, s) in self.sessions.lock().unwrap().drain() {
            s.stop.store(true, Ordering::SeqCst);
            if let Some(t) = s.tree {
                t.kill();
            }
        }
    }
}

/// Paths and toolchain lookups a run needs, separated from Tauri state for tests.
pub struct Context<'a> {
    pub out: PathBuf,
    pub tools: &'a dyn Fn(&str) -> Option<(PathBuf, Vec<String>)>,
}

const SKIP_DIRS: &[&str] = &["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build", "target", ".tmcode"];

fn sources(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                sources(&p, ext, out);
            }
        } else if p.extension().map(|x| x.eq_ignore_ascii_case(ext)).unwrap_or(false) {
            out.push(p);
        }
    }
}

/// Expands {entry}, {entry_stem}, {out} and {sources:<ext>} into concrete arguments.
pub fn expand(args: &[String], entry: &Path, out: &Path) -> Result<Vec<String>, String> {
    let dir = entry.parent().unwrap_or(entry);
    let stem = entry.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut result = Vec::new();
    for arg in args {
        if let Some(ext) = arg.strip_prefix("{sources:").and_then(|r| r.strip_suffix('}')) {
            let mut found = Vec::new();
            sources(dir, ext, &mut found);
            if found.is_empty() {
                return Err(format!("No .{ext} files found next to {}.", entry.display()));
            }
            result.extend(found.into_iter().map(|p| p.to_string_lossy().into_owned()));
            continue;
        }
        result.push(
            arg.replace("{entry_stem}", &stem)
                .replace("{entry}", &entry.to_string_lossy())
                .replace("{out}", &out.to_string_lossy()),
        );
    }
    Ok(result)
}

/// Resolves a step to (program, args). `exe` may only run a binary inside `out`.
pub fn program_for(ctx: &Context, step: &Step, entry: &Path) -> Result<(PathBuf, Vec<String>), String> {
    let args = expand(&step.args, entry, &ctx.out)?;
    if step.tool == "exe" {
        let (first, rest) = args.split_first().ok_or("The run step has no program.")?;
        let mut exe = PathBuf::from(first);
        if cfg!(windows) && exe.extension().is_none() {
            exe.set_extension("exe");
        }
        if !exe.starts_with(&ctx.out) {
            return Err("Only programs built by this run can be started.".into());
        }
        return Ok((exe, rest.to_vec()));
    }
    let (path, mut prefix) = (ctx.tools)(&step.tool).ok_or_else(|| missing_tool_message(&step.tool))?;
    prefix.extend(args);
    Ok((path, prefix))
}

pub fn missing_tool_message(tool: &str) -> String {
    let what = match tool {
        "python" => "Python 3",
        "node" => "Node.js",
        "cc" => "a C compiler (gcc or clang)",
        "cxx" => "a C++ compiler (g++ or clang++)",
        "javac" | "java" => "a Java JDK (version 17 or newer)",
        "go" => "Go (go.dev/dl)",
        "rustc" => "Rust (rustc, from rustup.rs)",
        other => other,
    };
    format!("TMCode could not find {what} on this computer. Install it (Help › Check My Computer has the links), then choose \"Refresh Toolchains\".")
}

pub(crate) fn display_command(program: &Path, args: &[String], root: &Path) -> String {
    let short = |s: &str| {
        let p = Path::new(s);
        p.strip_prefix(root).map(|r| r.to_string_lossy().into_owned()).unwrap_or_else(|_| s.to_string())
    };
    let name = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    std::iter::once(name)
        .chain(args.iter().map(|a| {
            let s = short(a);
            if s.contains(' ') { format!("\"{s}\"") } else { s }
        }))
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) const INHERITED_NOISE: &[&str] = &["FORCE_COLOR", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS"];

fn spawn_pipe(program: &Path, args: &[String], cwd: &Path) -> std::io::Result<std::process::Child> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONNOUSERSITE", "1")
        .env("NO_COLOR", "1");
    // Inherited settings must not change a student's output (colours, preloaded modules, paths).
    for var in INHERITED_NOISE {
        cmd.env_remove(var);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// Runs one step with pipes; streams output; returns the exit event.
pub fn run_piped(
    program: &Path,
    args: &[String],
    cwd: &Path,
    phase: &str,
    stdin: Option<&str>,
    timeout: Duration,
    limit: usize,
    stop: &Arc<AtomicBool>,
    on_tree: &mut dyn FnMut(Tree),
    emit: &(dyn Fn(RunEvent) + Sync),
) -> RunEvent {
    let started = Instant::now();
    let mut child = match spawn_pipe(program, args, cwd) {
        Ok(c) => c,
        Err(e) => {
            emit(RunEvent::Error { message: format!("Could not start {}: {e}", program.display()) });
            return RunEvent::Exit { phase: phase.into(), code: None, timed_out: false, truncated: false, killed: false, duration_ms: 0 };
        }
    };
    #[cfg(unix)]
    let tree = Tree { pgid: child.id() as i32 };
    #[cfg(windows)]
    let tree = job_for(child.id()).unwrap_or(Tree { job: 0 });
    on_tree(tree);

    if let Some(mut w) = child.stdin.take() {
        let input = stdin.unwrap_or("").to_string();
        // Writing in a thread: a program that doesn't read stdin must not block us.
        std::thread::spawn(move || {
            let _ = w.write_all(input.as_bytes());
        });
    }
    let total = Arc::new(Mutex::new(0usize));
    let truncated = Arc::new(AtomicBool::new(false));
    let mut readers = Vec::new();
    for (stream, is_err) in [(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), false), (child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>), true)] {
        let Some(mut stream) = stream else { continue };
        let total = total.clone();
        let truncated = truncated.clone();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        readers.push((rx, is_err));
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending = Vec::new();
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut t = total.lock().unwrap();
                if *t >= limit {
                    truncated.store(true, Ordering::SeqCst);
                    continue; // keep draining so the child never blocks on a full pipe
                }
                let take = n.min(limit - *t);
                *t += take;
                drop(t);
                pending.extend_from_slice(&buf[..take]);
                let text = crate::pty::take_utf8(&mut pending);
                if !text.is_empty() && tx.send(text).is_err() {
                    break;
                }
                if take < n {
                    truncated.store(true, Ordering::SeqCst);
                }
            }
            if !pending.is_empty() {
                let _ = tx.send(String::from_utf8_lossy(&pending).into_owned());
            }
        });
    }

    let mut timed_out = false;
    let mut killed = false;
    let status = loop {
        for (rx, is_err) in &readers {
            while let Ok(data) = rx.try_recv() {
                emit(if *is_err { RunEvent::Stderr { data } } else { RunEvent::Stdout { data } });
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if stop.load(Ordering::SeqCst) {
            killed = true;
            tree.kill();
        } else if started.elapsed() > timeout {
            timed_out = true;
            tree.kill();
        } else if truncated.load(Ordering::SeqCst) {
            tree.kill();
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // Drain whatever arrived after exit.
    std::thread::sleep(Duration::from_millis(20));
    for (rx, is_err) in &readers {
        while let Ok(data) = rx.recv_timeout(Duration::from_millis(50)) {
            emit(if *is_err { RunEvent::Stderr { data } } else { RunEvent::Stdout { data } });
        }
    }
    tree.kill(); // anything the program left running in the background
    RunEvent::Exit {
        phase: phase.into(),
        code: status.and_then(|s| s.code()),
        timed_out,
        truncated: truncated.load(Ordering::SeqCst),
        killed,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}

pub(crate) fn build_dir(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut h);
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("build")
        .join(format!("{:016x}", h.finish()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn run_start(
    app: AppHandle,
    ws: State<'_, Workspace>,
    tools: State<'_, Toolchains>,
    runs: State<'_, Runs>,
    request: RunRequest,
    on_event: Channel<RunEvent>,
) -> Result<u32, String> {
    let root = ws.root()?;
    let entry = resolve(&root, &request.entry)?;
    if !entry.is_file() {
        return Err(format!("'{}' does not exist.", request.entry));
    }
    let out = build_dir(&app, &root)?;
    let cwd = entry.parent().unwrap_or(&root).to_path_buf();
    let id = runs.next.fetch_add(1, Ordering::Relaxed) + 1;
    let stop = Arc::new(AtomicBool::new(false));
    runs.sessions.lock().unwrap().insert(id, Session { stdin: None, tree: None, stop: stop.clone() });

    // Resolve every step up front so a missing compiler is reported before anything runs.
    let tool_lookup = |t: &str| tools.get(t).map(|tc| (PathBuf::from(tc.path), tc.prefix_args));
    let ctx = Context { out: out.clone(), tools: &tool_lookup };
    let mut build = Vec::new();
    for step in &request.build {
        build.push(program_for(&ctx, step, &entry)?);
    }
    let mut run = program_for(&ctx, &request.run, &entry)?;
    run.1.extend(request.args.iter().cloned());
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(10_000).clamp(500, 120_000));
    let limit = request.output_limit_kb.unwrap_or(256).clamp(4, 4096) * 1024;
    let app2 = app.clone();

    std::thread::Builder::new()
        .name(format!("run-{id}"))
        .spawn(move || {
            let runs = app2.state::<Runs>();
            let emit = |e: RunEvent| {
                let _ = on_event.send(e);
            };
            let set_tree = |t: Tree| {
                if let Some(s) = runs.sessions.lock().unwrap().get_mut(&id) {
                    s.tree = Some(t);
                }
            };
            // Clean previous build products so a failed build can never run a stale binary.
            if !build.is_empty() {
                let _ = std::fs::remove_dir_all(&out);
                let _ = std::fs::create_dir_all(&out);
            }
            for (program, args) in &build {
                emit(RunEvent::Step { phase: "build".into(), command: display_command(program, args, &root) });
                let exit = run_piped(program, args, &cwd, "build", None, Duration::from_secs(60), 512 * 1024, &stop, &mut |t| set_tree(t), &emit);
                let failed = !matches!(&exit, RunEvent::Exit { code: Some(0), .. });
                emit(exit);
                if failed {
                    runs.sessions.lock().unwrap().remove(&id);
                    return;
                }
            }
            let (program, args) = run;
            emit(RunEvent::Step { phase: "run".into(), command: display_command(&program, &args, &root) });
            if request.mode == "pty" {
                let size = (request.cols.unwrap_or(80), request.rows.unwrap_or(24));
                run_pty(&program, &args, &cwd, size, &[], &stop, id, &runs, &emit);
            } else {
                let exit = run_piped(&program, &args, &cwd, "run", request.stdin.as_deref(), timeout, limit, &stop, &mut |t| set_tree(t), &emit);
                emit(exit);
            }
            runs.sessions.lock().unwrap().remove(&id);
        })
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Runs `program` on a pty, streaming output; `env` is applied after the
/// inherited noise is removed (a debug adapter's NODE_OPTIONS must survive).
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_pty(program: &Path, args: &[String], cwd: &Path, size: (u16, u16), env: &[(String, String)], stop: &Arc<AtomicBool>, id: u32, runs: &Runs, emit: &dyn Fn(RunEvent)) {
    let started = Instant::now();
    let fail = |message: String| {
        emit(RunEvent::Error { message });
        emit(RunEvent::Exit { phase: "run".into(), code: None, timed_out: false, truncated: false, killed: false, duration_ms: 0 });
    };
    let pty = match native_pty_system().openpty(PtySize {
        rows: size.1,
        cols: size.0,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => return fail(e.to_string()),
    };
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONNOUSERSITE", "1");
    for var in INHERITED_NOISE {
        cmd.env_remove(var);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = match pty.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => return fail(format!("Could not start {}: {e}", program.display())),
    };
    drop(pty.slave);
    let pid = child.process_id().unwrap_or(0);
    let tree = Tree::of(pid); // the pty child leads its own session (Unix)
    let writer = pty.master.take_writer().ok();
    if let Some(s) = runs.sessions.lock().unwrap().get_mut(&id) {
        s.tree = Some(tree);
        s.stdin = writer;
    }
    let mut reader = match pty.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => return fail(e.to_string()),
    };
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            let text = crate::pty::take_utf8(&mut pending);
            if !text.is_empty() && tx.send(text).is_err() {
                break;
            }
        }
    });
    let mut killed = false;
    let code = loop {
        while let Ok(data) = rx.try_recv() {
            emit(RunEvent::Stdout { data });
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.exit_code() as i32),
            Ok(None) => {}
            Err(_) => break None,
        }
        if stop.load(Ordering::SeqCst) && !killed {
            killed = true;
            tree.kill();
            let _ = child.kill();
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    while let Ok(data) = rx.recv_timeout(Duration::from_millis(60)) {
        emit(RunEvent::Stdout { data });
    }
    drop(pty.master);
    tree.kill();
    emit(RunEvent::Exit { phase: "run".into(), code: if killed { None } else { code }, timed_out: false, truncated: false, killed, duration_ms: started.elapsed().as_millis() as u64 });
}

#[tauri::command]
pub fn run_input(runs: State<'_, Runs>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = runs.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("The program has finished.")?;
    let w = s.stdin.as_mut().ok_or("This run does not take input.")?;
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn run_kill(runs: State<'_, Runs>, id: u32) -> Result<(), String> {
    if let Some(s) = runs.sessions.lock().unwrap().get(&id) {
        s.stop.store(true, Ordering::SeqCst);
        if let Some(t) = s.tree {
            t.kill();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::sync::Mutex as StdMutex;

    #[cfg(unix)]
    fn collect() -> (Arc<StdMutex<Vec<RunEvent>>>, impl Fn(RunEvent) + Sync) {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let e2 = events.clone();
        (events, move |e| e2.lock().unwrap().push(e))
    }

    #[cfg(unix)]
    fn stdout_of(events: &[RunEvent]) -> String {
        events
            .iter()
            .filter_map(|e| if let RunEvent::Stdout { data } = e { Some(data.as_str()) } else { None })
            .collect()
    }

    #[test]
    fn expands_tokens_and_sources() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("main.c"), "").unwrap();
        std::fs::write(root.join("util.c"), "").unwrap();
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/x.c"), "").unwrap();
        let out = root.join("out");
        let args = expand(&["{sources:c}".into(), "-o".into(), "{out}/main".into(), "{entry_stem}".into()], &root.join("main.c"), &out).unwrap();
        assert_eq!(args.len(), 5);
        assert!(args[0].ends_with("main.c") && args[1].ends_with("util.c"));
        assert_eq!(args[3], format!("{}/main", out.display()));
        assert_eq!(args[4], "main");
        assert!(expand(&["{sources:java}".into()], &root.join("main.c"), &out).is_err());
    }

    #[test]
    fn exe_tool_may_only_run_build_output() {
        let tools = |_: &str| None;
        let ctx = Context { out: PathBuf::from("/cache/build/x"), tools: &tools };
        let ok = program_for(&ctx, &Step { tool: "exe".into(), args: vec!["{out}/main".into()] }, Path::new("/w/main.c"));
        assert!(ok.is_ok());
        let bad = program_for(&ctx, &Step { tool: "exe".into(), args: vec!["/bin/sh".into()] }, Path::new("/w/main.c"));
        assert!(bad.unwrap_err().contains("Only programs built"));
        let missing = program_for(&ctx, &Step { tool: "python".into(), args: vec![] }, Path::new("/w/main.py"));
        assert!(missing.unwrap_err().contains("Python 3"));
    }

    #[cfg(unix)]
    #[test]
    fn pipes_stdin_and_captures_output() {
        let (events, emit) = collect();
        let stop = Arc::new(AtomicBool::new(false));
        let exit = run_piped(Path::new("/bin/sh"), &["-c".into(), "read a; read b; echo $((a+b)); echo oops >&2".into()], Path::new("/tmp"), "run", Some("2\n3\n"), Duration::from_secs(5), 1024, &stop, &mut |_| {}, &emit);
        let ev = events.lock().unwrap();
        assert_eq!(stdout_of(&ev), "5\n");
        assert!(ev.iter().any(|e| matches!(e, RunEvent::Stderr { data } if data.contains("oops"))));
        assert!(matches!(exit, RunEvent::Exit { code: Some(0), timed_out: false, .. }));
    }

    #[cfg(unix)]
    #[test]
    fn times_out_and_kills_the_whole_tree() {
        let (_events, emit) = collect();
        let stop = Arc::new(AtomicBool::new(false));
        let marker = tempfile::NamedTempFile::new().unwrap();
        // A background grandchild that would touch the marker after the timeout.
        let script = format!("(sleep 1.5; echo late > {}) & sleep 30", marker.path().display());
        let started = Instant::now();
        let exit = run_piped(Path::new("/bin/sh"), &["-c".into(), script], Path::new("/tmp"), "run", None, Duration::from_millis(500), 1024, &stop, &mut |_| {}, &emit);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(matches!(exit, RunEvent::Exit { timed_out: true, .. }));
        std::thread::sleep(Duration::from_secs(2));
        assert_eq!(std::fs::read_to_string(marker.path()).unwrap(), "", "grandchild survived the kill");
    }

    #[cfg(unix)]
    #[test]
    fn caps_runaway_output() {
        let (events, emit) = collect();
        let stop = Arc::new(AtomicBool::new(false));
        let exit = run_piped(Path::new("/usr/bin/yes"), &[], Path::new("/tmp"), "run", None, Duration::from_secs(10), 4096, &stop, &mut |_| {}, &emit);
        assert!(matches!(exit, RunEvent::Exit { truncated: true, .. }));
        assert!(stdout_of(&events.lock().unwrap()).len() <= 4096);
    }
}
