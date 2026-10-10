//! The macOS menu bar (Windows draws its menu inside the workbench title bar).
//!
//! Built from the same spec as the in-app menus (packages/workbench/src/commands/menus.json),
//! so the two can't drift. Custom items carry a workbench command id ("cmd:<id>"); choosing
//! one emits a `menu` event to the workbench, which runs the same command as the keybinding
//! or command palette would. Once the workbench is up it sends each item's label, enabled
//! state and accelerator (`menu_update`), so disabled commands are greyed out here too and
//! user keybindings show. Clipboard items stay native so WKWebView keeps system copy/paste
//! semantics (the exam paste guard hooks the resulting DOM paste event, not the menu).

use serde::Deserialize;
use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

use crate::WORKBENCH;

const SPEC: &str = include_str!("../../../../packages/workbench/src/commands/menus.json");

#[derive(Deserialize)]
struct Spec {
    menus: Vec<MenuSpec>,
}

#[derive(Deserialize)]
struct MenuSpec {
    label: String,
    #[serde(default)]
    native: Option<String>,
    items: Vec<ItemSpec>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ItemSpec {
    /// "-" (separator) or a bare command id.
    Plain(String),
    Command {
        command: String,
        label: String,
        #[serde(default)]
        accel: Option<String>,
        #[serde(default)]
        native: Option<String>,
    },
    Role {
        role: String,
    },
}

fn spec() -> Spec {
    serde_json::from_str(SPEC).expect("menus.json is valid (checked by `cargo test`)")
}

fn role_item<R: Runtime>(app: &AppHandle<R>, role: &str) -> tauri::Result<Option<PredefinedMenuItem<R>>> {
    Ok(Some(match role {
        "about" => PredefinedMenuItem::about(
            app,
            Some("About TMCode"),
            Some(AboutMetadata {
                name: Some("TMCode".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                copyright: Some("© 2026 New Generation Academy".into()),
                ..Default::default()
            }),
        )?,
        "hide" => PredefinedMenuItem::hide(app, None)?,
        "hideOthers" => PredefinedMenuItem::hide_others(app, None)?,
        "showAll" => PredefinedMenuItem::show_all(app, None)?,
        "cut" => PredefinedMenuItem::cut(app, None)?,
        "copy" => PredefinedMenuItem::copy(app, None)?,
        "paste" => PredefinedMenuItem::paste(app, None)?,
        "minimize" => PredefinedMenuItem::minimize(app, None)?,
        "maximize" => PredefinedMenuItem::maximize(app, None)?,
        "fullscreen" => PredefinedMenuItem::fullscreen(app, None)?,
        _ => return Ok(None),
    }))
}

fn submenu<R: Runtime>(app: &AppHandle<R>, menu: &MenuSpec) -> tauri::Result<Submenu<R>> {
    let mut b = SubmenuBuilder::new(app, &menu.label);
    for item in &menu.items {
        match item {
            ItemSpec::Plain(s) if s == "-" => b = b.separator(),
            // A bare id: the workbench sends its label at start-up.
            ItemSpec::Plain(id) => b = b.item(&MenuItemBuilder::with_id(format!("cmd:{id}"), id).build(app)?),
            ItemSpec::Command { command, label, accel, native } => {
                if native.as_deref() == Some("never") {
                    continue;
                }
                let mut it = MenuItemBuilder::with_id(format!("cmd:{command}"), label);
                if let Some(a) = accel.as_deref().filter(|a| !a.is_empty()) {
                    it = it.accelerator(a);
                }
                b = b.item(&it.build(app)?);
            }
            ItemSpec::Role { role } => {
                if let Some(r) = role_item(app, role)? {
                    b = b.item(&r);
                }
            }
        }
    }
    b.build()
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let mut menu = MenuBuilder::new(app);
    for m in spec().menus.iter().filter(|m| m.native.as_deref() != Some("never")) {
        menu = menu.item(&submenu(app, m)?);
    }
    menu.build()
}

/// Forwards "cmd:<id>" menu clicks to the workbench.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(command) = id.strip_prefix("cmd:") {
        let _ = app.emit_to(EventTarget::webview(WORKBENCH), "menu", command.to_string());
    }
}

#[derive(Deserialize)]
pub struct ItemState {
    id: String,
    text: String,
    enabled: bool,
    accel: Option<String>,
}

fn apply<R: Runtime>(items: &[MenuItemKind<R>], states: &std::collections::HashMap<String, ItemState>) {
    for item in items {
        match item {
            MenuItemKind::Submenu(sub) => {
                if let Ok(children) = sub.items() {
                    apply(&children, states);
                }
            }
            MenuItemKind::MenuItem(mi) => {
                let id = mi.id().as_ref();
                let Some(command) = id.strip_prefix("cmd:") else { continue };
                let Some(state) = states.get(command) else { continue };
                let _ = mi.set_text(&state.text);
                let _ = mi.set_enabled(state.enabled);
                let _ = mi.set_accelerator(state.accel.as_deref().filter(|a| !a.is_empty()));
            }
            _ => {}
        }
    }
}

/// The workbench's view of each command item: label, enabled state, accelerator (macOS only).
#[tauri::command]
pub fn menu_update<R: Runtime>(app: AppHandle<R>, items: Vec<ItemState>) {
    let states: std::collections::HashMap<String, ItemState> = items.into_iter().map(|s| (s.id.clone(), s)).collect();
    // Menu changes must happen on the main thread.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(menu) = handle.menu() {
            if let Ok(top) = menu.items() {
                apply(&top, &states);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_parses_and_items_are_well_formed() {
        let s = spec();
        let labels: Vec<&str> = s.menus.iter().map(|m| m.label.as_str()).collect();
        for want in ["TMCode", "File", "Edit", "Selection", "View", "Go", "Run", "Terminal", "Window", "Help"] {
            assert!(labels.contains(&want), "missing menu {want}");
        }
        for m in &s.menus {
            for it in &m.items {
                match it {
                    ItemSpec::Plain(p) => assert!(!p.is_empty()),
                    ItemSpec::Command { command, label, .. } => {
                        assert!(!command.is_empty() && !label.is_empty(), "{} has an empty item", m.label);
                    }
                    ItemSpec::Role { role } => {
                        assert!(
                            ["about", "hide", "hideOthers", "showAll", "cut", "copy", "paste", "minimize", "maximize", "fullscreen"].contains(&role.as_str()),
                            "unknown role {role}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn quit_keeps_its_accelerator() {
        let s = spec();
        let quit = s.menus.iter().flat_map(|m| m.items.iter()).find_map(|it| match it {
            ItemSpec::Command { command, accel, .. } if command == "workbench.action.quit" => accel.clone(),
            _ => None,
        });
        assert_eq!(quit.as_deref(), Some("CmdOrCtrl+Q"));
    }
}
