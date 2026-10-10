#[cfg(target_os = "macos")]
mod menus;
pub mod askpass;
mod debug;
mod netcoredbg;
mod phpdebug;
mod account;
mod api;
mod proc;
mod projects;
mod exam;
mod extensions;
// ── extension host (feat/exthost) ──
mod exthost;
mod git;
mod github;
mod preview;
mod pty;
mod runner;
mod toolchains;
mod updates;
mod watcher;
mod webview;
mod workspace;
mod encoding;

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{App, Emitter, LogicalPosition, Manager, RunEvent, Theme, WebviewUrl};

/// Internals exposed for the integration tests in `tests/` (not part of the app API).
#[doc(hidden)]
pub mod test_support {
    pub use crate::runner::{program_for, run_piped, Context, RunEvent, Step};
    pub fn detect(tool: &str) -> Option<crate::toolchains::Toolchain> {
        crate::toolchains::Toolchains::default().get(tool)
    }
}

pub const WINDOW: &str = "main";

/// Paths macOS asked us to open before the workbench was listening (cold-start
/// "Open With", `open -a TMCode <folder>`, Dock drops). The workbench takes them once at startup.
#[derive(Default)]
pub struct PendingOpen(std::sync::Mutex<Vec<String>>);

#[tauri::command]
fn take_pending_open(pending: tauri::State<'_, PendingOpen>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}
pub const WORKBENCH: &str = "workbench";

#[derive(Serialize)]
struct AppInfo {
    version: &'static str,
    os: &'static str,
    /// Debug builds only: a folder to open and whether to run the self-test
    /// (`TMCODE_DEV_WORKSPACE`, `TMCODE_DEV_SELFTEST=1`), for checks inside the
    /// real WKWebView / WebView2 where nobody can click.
    dev_workspace: Option<String>,
    dev_selftest: bool,
    /// Debug builds only: `TMCODE_DEV_SELFTEST=git` runs the git self-test instead.
    dev_selftest_git: bool,
    /// Debug builds only: `TMCODE_DEV_SELFTEST=ui` measures the editor and terminal as rendered.
    dev_selftest_ui: bool,
    /// Debug builds only: `TMCODE_DEV_SELFTEST=projects` runs the Task Mentor projects self-test.
    dev_selftest_projects: bool,
    /// Debug builds only: `TMCODE_DEV_SELFTEST=exthost` installs real extensions and runs their code.
    dev_selftest_exthost: bool,
    /// Debug builds only: `TMCODE_DEV_SELFTEST=extensions` installs and uses real extensions end to end.
    dev_selftest_extensions: bool,
    /// Debug builds only: a tmcode:// link to open at start (`TMCODE_DEV_LAUNCH`).
    dev_launch: Option<String>,
    /// A folder or file given on the command line (`tmcode ~/project`).
    open_path: Option<String>,
}

/// The first argument that is a path (not a flag, not a tmcode:// link), made absolute.
pub fn path_arg(args: &[String], cwd: &std::path::Path) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && !a.contains("://"))
        .map(|a| {
            let p = std::path::Path::new(a);
            let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
            abs.to_string_lossy().into_owned()
        })
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: if cfg!(target_os = "macos") {
            "mac"
        } else if cfg!(windows) {
            "windows"
        } else {
            "linux"
        },
        dev_workspace: if cfg!(debug_assertions) { std::env::var("TMCODE_DEV_WORKSPACE").ok() } else { None },
        dev_selftest: cfg!(debug_assertions) && std::env::var("TMCODE_DEV_SELFTEST").as_deref() == Ok("1"),
        dev_selftest_git: cfg!(debug_assertions) && std::env::var("TMCODE_DEV_SELFTEST").as_deref() == Ok("git"),
        dev_selftest_ui: cfg!(debug_assertions) && std::env::var("TMCODE_DEV_SELFTEST").as_deref() == Ok("ui"),
        dev_selftest_projects: cfg!(debug_assertions) && std::env::var("TMCODE_DEV_SELFTEST").as_deref() == Ok("projects"),
        dev_selftest_exthost: cfg!(debug_assertions) && std::env::var("TMCODE_DEV_SELFTEST").as_deref() == Ok("exthost"),
        dev_selftest_extensions: cfg!(debug_assertions) && std::env::var("TMCODE_DEV_SELFTEST").as_deref() == Ok("extensions"),
        dev_launch: if cfg!(debug_assertions) { std::env::var("TMCODE_DEV_LAUNCH").ok() } else { None },
        open_path: path_arg(&std::env::args().collect::<Vec<_>>(), &std::env::current_dir().unwrap_or_default()),
    }
}

/// Native window appearance follows the workbench theme, so resizing and the
/// macOS title-bar overlay never flash the wrong colour.
#[tauri::command]
fn set_native_theme(app: tauri::AppHandle, theme: String) {
    let Some(window) = app.get_window(WINDOW) else { return };
    let dark = theme != "light";
    let _ = window.set_theme(Some(if dark { Theme::Dark } else { Theme::Light }));
    let bg = if dark { (31, 31, 31, 255) } else { (255, 255, 255, 255) };
    let _ = window.set_background_color(Some(bg.into()));
}

/// Whole-window zoom (View › Zoom In / Out / Reset): the workbench webview's page zoom.
#[tauri::command]
fn set_zoom(app: tauri::AppHandle, factor: f64) -> Result<(), String> {
    let webview = app.get_webview(WORKBENCH).ok_or("The workbench is not open.")?;
    webview.set_zoom(factor.clamp(0.25, 5.0)).map_err(|e| e.to_string())
}

/// Size the first window for the screen it opens on (school laptops are often 1366×768).
fn fit(work: Option<(f64, f64)>) -> (f64, f64, bool) {
    match work {
        Some((w, h)) if w <= 1440.0 || h <= 860.0 => (w.min(1280.0), h.min(800.0), true),
        Some((w, h)) => ((w * 0.8).min(1600.0), (h * 0.85).min(1000.0), false),
        None => (1280.0, 800.0, false),
    }
}

/// VS Code-style frame: on macOS the traffic lights float over the custom
/// title bar; on Windows there is no system frame and the workbench draws
/// minimise / maximise / close itself.
fn build_main_window(app: &mut App) -> tauri::Result<()> {
    let work = app.primary_monitor().ok().flatten().map(|m| {
        let a = m.work_area().size.to_logical::<f64>(m.scale_factor());
        (a.width, a.height)
    });
    let (width, height, maximized) = fit(work);
    let builder = WindowBuilder::new(app, WINDOW)
        .title("TMCode")
        .inner_size(width, height)
        .min_inner_size(600.0, 420.0)
        .maximized(maximized)
        .background_color((31, 31, 31, 255).into());
    let builder = if maximized { builder } else { builder.center() };
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false).shadow(true);
    let window = builder.build()?;
    let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
    let wb = window.add_child(
        WebviewBuilder::new(WORKBENCH, WebviewUrl::App("index.html".into())),
        LogicalPosition::new(0.0, 0.0),
        size,
    )?;
    wb.set_auto_resize(true)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| menus::build(app))
        .on_menu_event(|app, event| menus::on_menu_event(app, event.id().as_ref()));
    let app = builder
        // Must be first: a second launch (or a tmcode:// link) focuses the running window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(w) = app.get_window(WINDOW) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            // `tmcode ~/other-project` while TMCode is running opens it here.
            if let Some(path) = path_arg(&argv, std::path::Path::new(&cwd)) {
                let _ = app.emit_to(tauri::EventTarget::webview(WORKBENCH), "open-path", path);
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .manage(workspace::Workspace::default())
        .manage(pty::Terminals::default())
        .manage(toolchains::Toolchains::default())
        .manage(runner::Runs::default())
        .manage(debug::Debuggers::default())
        .manage(proc::Procs::default())
        .manage(preview::Preview::default())
        .manage(watcher::Watcher::default())
        .manage(updates::Pending::default())
        .manage(PendingOpen::default())
        .manage(git::Git::default())
        .manage(account::Account::default())
        .manage(github::GitHub::default())
        .manage(exthost::ExtHosts::default())
        .manage(webview::Webviews::default())
        .register_uri_scheme_protocol(preview::SCHEME, preview::handle)
        .register_uri_scheme_protocol(webview::SCHEME, webview::handle)
        .invoke_handler(tauri::generate_handler![
            app_info,
            set_native_theme,
            menus::menu_update,
            take_pending_open,
            workspace::ws_open,
            workspace::ws_reopen,
            workspace::ws_open_file,
            workspace::ws_open_path,
            workspace::ws_reveal,
            workspace::ws_copy,
            workspace::ws_read_base64,
            workspace::open_external,
            workspace::ws_read_dir,
            workspace::ws_read_file,
            workspace::ws_write_file,
            workspace::ws_create_file,
            workspace::ws_create_dir,
            workspace::ws_rename,
            workspace::ws_remove,
            workspace::ws_trash,
            workspace::ws_import,
            workspace::ws_file_encoding,
            workspace::ws_reopen_with_encoding,
            workspace::ws_set_encoding,
            set_zoom,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            toolchains::toolchains_detect,
            runner::run_start,
            runner::run_input,
            runner::run_kill,
            toolchains::toolchains_candidates,
            toolchains::toolchains_select,
            debug::debug_probe,
            debug::debug_install,
            debug::debug_prepare,
            debug::debug_start,
            debug::debug_send,
            debug::debug_stop,
            debug::debug_run_in_terminal,
            debug::debug_policy,
            preview::preview_publish,
            api::api_request,
            proc::proc_run,
            proc::proc_kill,
            exam::exam_device,
            exam::exam_workspace,
            exam::journal_load,
            exam::journal_append,
            exam::journal_mark_synced,
            updates::update_check,
            updates::update_install,
            extensions::ext_fetch,
            extensions::ext_list,
            extensions::ext_install,
            extensions::ext_uninstall,
            extensions::ext_read_file,
            extensions::ext_install_vsix,
            // ── extension host (feat/exthost) ──
            exthost::exthost_start,
            exthost::exthost_send,
            exthost::exthost_stop,
            exthost::exthost_policy,
            exthost::exthost_secret,
            webview::webview_publish,
            webview::webview_dispose,
            account::auth_sign_in,
            account::auth_cancel,
            account::auth_reopen_browser,
            account::auth_status,
            account::auth_sign_out,
            account::tm_api,
            projects::proj_scan,
            projects::proj_read_blob,
            projects::proj_write_blob,
            projects::proj_new_folder,
            projects::proj_use_projects_folder,
            git::git_info,
            git::git_status,
            git::git_show,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_branches,
            git::git_checkout,
            git::git_log,
            git::git_init,
            git::git_stash,
            git::git_check_ignore,
            git::git_set_identity,
            git::git_remote,
            git::git_cancel,
            git::git_pick_clone_parent,
            git::git_clone,
            github::github_sign_in,
            github::github_user,
            github::github_sign_out,
            github::github_repos,
            git::git_open_url,
        ])
        .setup(|app| {
            // Windows/Linux dev builds register tmcode:// at runtime; installers register it for real
            // (macOS: from the bundle's Info.plist).
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            build_main_window(app)?;
            // Debug self-tests measure rendering: a window behind other apps is throttled by
            // macOS (no frames, no timers), so bring it forward and keep it there.
            if cfg!(debug_assertions) && std::env::var("TMCODE_DEV_SELFTEST").is_ok() {
                if let Some(w) = app.get_webview_window(WORKBENCH) {
                    let _ = w.set_always_on_top(true);
                    let _ = w.set_focus();
                }
            }
            log::info!("TMCode {} started", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building TMCode");

    app.run(|handle, event| {
        // macOS: files dropped on the Dock icon or chosen with "Open With".
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = &event {
            for url in urls.iter().filter(|u| u.scheme() == "file") {
                if let Ok(path) = url.to_file_path() {
                    let path = path.to_string_lossy().into_owned();
                    // Queue it too: on a cold start nothing is listening yet.
                    handle.state::<PendingOpen>().0.lock().unwrap().push(path.clone());
                    let _ = handle.emit_to(tauri::EventTarget::webview(WORKBENCH), "open-path", path);
                }
            }
        }
        if let RunEvent::Exit = event {
            handle.state::<pty::Terminals>().kill_all();
            handle.state::<runner::Runs>().kill_all();
            handle.state::<debug::Debuggers>().kill_all();
            handle.state::<exthost::ExtHosts>().kill_all();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::fit;

    #[test]
    fn small_screens_open_maximized_and_never_larger_than_the_screen() {
        for (w, h) in [(1366.0, 738.0), (1280.0, 680.0), (1024.0, 728.0)] {
            let (fw, fh, max) = fit(Some((w, h)));
            assert!(max, "{w}x{h}");
            assert!(fw <= w && fh <= h);
        }
    }

    #[test]
    fn finds_the_path_argument() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let cwd = std::env::temp_dir();
        let cwd = cwd.as_path();
        let expected = cwd.join("project").to_string_lossy().into_owned();
        assert_eq!(super::path_arg(&args(&["tmcode", "project"]), cwd).as_deref(), Some(expected.as_str()));
        // An absolute path (in this OS's own form) is kept as-is.
        let abs = cwd.join("x.py").to_string_lossy().into_owned();
        assert_eq!(super::path_arg(&args(&["tmcode", "--flag", &abs]), cwd).as_deref(), Some(abs.as_str()));
        assert_eq!(super::path_arg(&args(&["tmcode", "tmcode://launch?t=1"]), cwd), None);
        assert_eq!(super::path_arg(&args(&["tmcode"]), cwd), None);
    }

    #[test]
    fn big_screens_get_a_centred_window() {
        let (w, h, max) = fit(Some((1920.0, 1050.0)));
        assert!(!max);
        assert_eq!((w, h), (1536.0, 892.5));
    }
}
