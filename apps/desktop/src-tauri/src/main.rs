// Prevents an extra console window on Windows in release. DO NOT REMOVE.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by git as GIT_ASKPASS (HTTPS to GitHub): answer and exit before any UI starts.
    if let Some(code) = tmcode_lib::askpass::handle() {
        std::process::exit(code);
    }
    tmcode_lib::run()
}
