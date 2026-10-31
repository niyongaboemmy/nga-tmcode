//! Exports the workbench makes (the SQL schema diagram as PNG, PDF or SVG): the user picks where in a native Save
//! dialog, so the webview never names a path outside the workspace, and only bytes it rendered are written.

use base64::Engine;

/// The most an export may weigh (a huge diagram as PNG is a few tens of MB).
const MAX_BYTES: usize = 200 * 1024 * 1024;

#[tauri::command]
pub async fn export_save(app: tauri::AppHandle, file_name: String, base64: String, filter_name: String, extensions: Vec<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64.as_bytes()).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("The export is larger than 200 MB.".into());
    }
    let name = safe_name(&file_name);
    let exts: Vec<&str> = extensions.iter().map(String::as_str).filter(|e| !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric())).collect();
    let mut dialog = app.dialog().file().set_title("Export").set_file_name(&name);
    if !exts.is_empty() {
        dialog = dialog.add_filter(&filter_name, &exts);
    }
    let Some(picked) = dialog.blocking_save_file() else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    log::info!("exported {}", path.display());
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// The suggested name without folders or characters the OS refuses.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    let clean = clean.trim().trim_start_matches('.').to_string();
    if clean.is_empty() { "export".into() } else { clean }
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn names_stay_names() {
        assert_eq!(safe_name("schema.png"), "schema.png");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("a:b?.pdf"), "a_b_.pdf");
        assert_eq!(safe_name(""), "export");
        assert_eq!(safe_name(".hidden"), "hidden");
    }
}
