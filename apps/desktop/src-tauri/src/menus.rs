//! The macOS menu bar (Windows draws its menu inside the workbench title bar).
//!
//! Custom items carry a workbench command id ("cmd:<id>"); choosing one emits
//! a `menu` event to the workbench, which runs the same command as the
//! keybinding or command palette would. Clipboard items stay native so
//! WKWebView keeps system copy/paste semantics (the exam paste guard hooks the
//! resulting DOM paste event, not the menu).

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

use crate::WORKBENCH;

/// (label, command id, accelerator). Accelerators mirror the workbench keybindings.
type Item = (&'static str, &'static str, Option<&'static str>);

const FILE: &[Item] = &[
    ("New File...", "explorer.newFile", Some("CmdOrCtrl+Alt+N")),
    ("New Folder...", "explorer.newFolder", None),
    ("New Project from Template...", "workbench.action.newProjectFromTemplate", None),
    ("-", "", None),
    ("Open Folder...", "workbench.action.files.openFolder", Some("CmdOrCtrl+O")),
    ("-", "", None),
    ("Save", "workbench.action.files.save", Some("CmdOrCtrl+S")),
    ("Save All", "workbench.action.files.saveAll", Some("CmdOrCtrl+Alt+S")),
    ("-", "", None),
    ("Close Editor", "workbench.action.closeActiveEditor", Some("CmdOrCtrl+W")),
    ("Close Folder", "workbench.action.closeFolder", None),
];

const VIEW: &[Item] = &[
    ("Command Palette...", "workbench.action.showCommands", Some("CmdOrCtrl+Shift+P")),
    ("-", "", None),
    ("Explorer", "workbench.view.explorer", Some("CmdOrCtrl+Shift+E")),
    ("Search", "workbench.view.search", Some("CmdOrCtrl+Shift+F")),
    ("-", "", None),
    ("Problems", "workbench.actions.view.problems", Some("CmdOrCtrl+Shift+M")),
    ("Output", "workbench.action.output.toggleOutput", Some("CmdOrCtrl+Shift+U")),
    ("Terminal", "workbench.action.terminal.toggleTerminal", None),
    ("-", "", None),
    ("Toggle Primary Side Bar", "workbench.action.toggleSidebarVisibility", Some("CmdOrCtrl+B")),
    ("Toggle Panel", "workbench.action.togglePanel", Some("CmdOrCtrl+J")),
    ("Split Editor", "workbench.action.splitEditor", Some("CmdOrCtrl+\\")),
    ("-", "", None),
    ("Word Wrap", "editor.action.toggleWordWrap", Some("Alt+Z")),
    ("Minimap", "editor.action.toggleMinimap", None),
    ("Zoom In", "editor.action.fontZoomIn", Some("CmdOrCtrl+=")),
    ("Zoom Out", "editor.action.fontZoomOut", Some("CmdOrCtrl+-")),
];

const GO: &[Item] = &[
    ("Go to File...", "workbench.action.quickOpen", Some("CmdOrCtrl+P")),
    ("Go to Line/Column...", "workbench.action.gotoLine", Some("Ctrl+G")),
    ("Go to Definition", "editor.action.revealDefinition", None),
];

const TERMINAL: &[Item] = &[("New Terminal", "workbench.action.terminal.new", None)];

const HELP: &[Item] = &[
    ("Welcome", "workbench.action.openWelcome", None),
    ("Show All Commands", "workbench.action.showCommands", None),
    ("Keyboard Shortcuts Reference", "workbench.action.keybindingsReference", None),
];

fn submenu<R: Runtime>(app: &AppHandle<R>, title: &str, items: &[Item]) -> tauri::Result<tauri::menu::Submenu<R>> {
    let mut b = SubmenuBuilder::new(app, title);
    for (label, id, accel) in items {
        if *label == "-" {
            b = b.separator();
            continue;
        }
        let mut item = MenuItemBuilder::with_id(format!("cmd:{id}"), *label);
        if let Some(a) = accel {
            item = item.accelerator(*a);
        }
        b = b.item(&item.build(app)?);
    }
    b.build()
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = SubmenuBuilder::new(app, "TMCode")
        .item(&PredefinedMenuItem::about(
            app,
            Some("About TMCode"),
            Some(AboutMetadata {
                name: Some("TMCode".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                copyright: Some("© 2026 New Generation Academy".into()),
                ..Default::default()
            }),
        )?)
        .separator()
        .item(&MenuItemBuilder::with_id("cmd:workbench.action.openSettings", "Settings...").accelerator("CmdOrCtrl+,").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // Undo/redo go to Monaco's own stacks (as in VS Code); clipboard stays native.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&MenuItemBuilder::with_id("cmd:undo", "Undo").accelerator("CmdOrCtrl+Z").build(app)?)
        .item(&MenuItemBuilder::with_id("cmd:redo", "Redo").accelerator("CmdOrCtrl+Shift+Z").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        // Not the predefined selectAll: (it only selects inside a plain text field): the workbench
        // selects all in whatever has focus — editor, terminal, input or list.
        .item(&MenuItemBuilder::with_id("cmd:workbench.action.selectAllInFocus", "Select All").accelerator("CmdOrCtrl+A").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("cmd:actions.find", "Find").accelerator("CmdOrCtrl+F").build(app)?)
        .item(&MenuItemBuilder::with_id("cmd:editor.action.startFindReplaceAction", "Replace").accelerator("CmdOrCtrl+Alt+F").build(app)?)
        .item(&MenuItemBuilder::with_id("cmd:workbench.view.search", "Find in Files").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("cmd:editor.action.commentLine", "Toggle Line Comment").accelerator("CmdOrCtrl+/").build(app)?)
        .item(&MenuItemBuilder::with_id("cmd:editor.action.formatDocument", "Format Document").accelerator("Shift+Alt+F").build(app)?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&submenu(app, "File", FILE)?)
        .item(&edit)
        .item(&submenu(app, "View", VIEW)?)
        .item(&submenu(app, "Go", GO)?)
        .item(&submenu(app, "Terminal", TERMINAL)?)
        .item(&window)
        .item(&submenu(app, "Help", HELP)?)
        .build()
}

/// Forwards "cmd:<id>" menu clicks to the workbench.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(command) = id.strip_prefix("cmd:") {
        let _ = app.emit_to(EventTarget::webview(WORKBENCH), "menu", command.to_string());
    }
}
