#[cfg(target_os = "macos")]
mod menus;
mod exam;
mod preview;
mod pty;
mod runner;
mod toolchains;
mod workspace;

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{App, LogicalPosition, Manager, RunEvent, Theme, WebviewUrl};

/// Internals exposed for the integration tests in `tests/` (not part of the app API).
#[doc(hidden)]
pub mod test_support {
    pub use crate::runner::{program_for, run_piped, Context, RunEvent, Step};
    pub fn detect(tool: &str) -> Option<crate::toolchains::Toolchain> {
        crate::toolchains::Toolchains::default().get(tool)
    }
}

pub const WINDOW: &str = "main";
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
    /// Debug builds only: a tmcode:// link to open at start (`TMCODE_DEV_LAUNCH`).
    dev_launch: Option<String>,
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
        dev_launch: if cfg!(debug_assertions) { std::env::var("TMCODE_DEV_LAUNCH").ok() } else { None },
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
        .min_inner_size(800.0, 500.0)
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
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_window(WINDOW) {
                let _ = w.unminimize();
                let _ = w.set_focus();
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
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .manage(workspace::Workspace::default())
        .manage(pty::Terminals::default())
        .manage(toolchains::Toolchains::default())
        .manage(runner::Runs::default())
        .manage(preview::Preview::default())
        .register_uri_scheme_protocol(preview::SCHEME, preview::handle)
        .invoke_handler(tauri::generate_handler![
            app_info,
            set_native_theme,
            workspace::ws_open,
            workspace::ws_reopen,
            workspace::ws_read_dir,
            workspace::ws_read_file,
            workspace::ws_write_file,
            workspace::ws_create_file,
            workspace::ws_create_dir,
            workspace::ws_rename,
            workspace::ws_remove,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            toolchains::toolchains_detect,
            runner::run_start,
            runner::run_input,
            runner::run_kill,
            preview::preview_publish,
            exam::exam_device,
            exam::exam_workspace,
            exam::journal_load,
            exam::journal_append,
            exam::journal_mark_synced,
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
            log::info!("TMCode {} started", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building TMCode");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<pty::Terminals>().kill_all();
            handle.state::<runner::Runs>().kill_all();
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
    fn big_screens_get_a_centred_window() {
        let (w, h, max) = fit(Some((1920.0, 1050.0)));
        assert!(!max);
        assert_eq!((w, h), (1536.0, 892.5));
    }
}
