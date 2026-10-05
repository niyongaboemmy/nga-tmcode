fn main() {
    // Every app command needs an explicit permission, granted to the workbench
    // webview only (capabilities/workbench.json). Preview webviews get none.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_info",
            "set_native_theme",
            "ws_open",
            "ws_reopen",
            "ws_read_dir",
            "ws_read_file",
            "ws_write_file",
            "ws_create_file",
            "ws_create_dir",
            "ws_rename",
            "ws_remove",
            "pty_spawn",
            "pty_write",
            "pty_resize",
            "pty_kill",
        ]),
    ))
    .expect("failed to run tauri-build");
}
