// `pub` because the `.sut` parser and its scorer are reachable from the crate's
// tests as well as from the `brush_import` command below.
pub mod brush;
// `pub` for examples/detect_pages.rs, the headless Detect scripts call.
pub mod detect;
mod durability;
mod trash;
mod font_coverage;
mod font_decode;
// Linux-only at runtime; compiled under `test` everywhere so its unit tests
// run on the Mac too (the code is plain POSIX).
#[cfg(any(target_os = "linux", test))]
mod linux;
mod memory;
mod screen_color;
mod system_fonts;

/// Command-line flag that makes the binary probe one execution provider and
/// exit instead of starting the app. It takes the provider's name as its
/// argument; see `detect::accel::probe_isolated`.
pub const PROBE_FLAG: &str = detect::accel::PROBE_FLAG;

/// The child side of the device probe. Nothing but the ONNX provider
/// registration runs here, so a driver that aborts takes only this process -
/// and only the one rung it was asked about, which is why the rung to try is
/// an argument rather than the whole ladder.
pub fn probe_device_main(rung: &str) {
  println!("{}", detect::accel::probe_rung(rung));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  #[cfg(target_os = "linux")]
  linux::prepare();
  tauri::Builder::default()
    // First, as the plugin asks. Two copies of the app autosaving the same
    // chapter.json would each write over the other's work (SAV-2), so a second
    // launch only brings the window that is already open to the front.
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      use tauri::Manager;
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
    }))
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    // In-process ONNX engine for detection and OCR.
    .manage(detect::engine::DetectEngine::new(detect::engine::default_models_dir()))
    .invoke_handler(tauri::generate_handler![
      detect::engine::detect_analyze,
      detect::engine::detect_models_cache,
      detect::engine::detect_models_cache_clear,
      detect::engine::detect_health,
      brush::brush_import,
      memory::process_memory,
      screen_color::pick_screen_color,
      system_fonts::system_fonts,
      system_fonts::system_font_face,
      font_coverage::system_font_coverage,
      font_decode::font_to_sfnt,
      durability::fsync_path,
      trash::trash_path
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use std::path::Path;

  /// `asset://` and the fs plugin are two scopes that share nothing, so the
  /// same deny list is written twice - once in `tauri.conf.json` under
  /// `app.security.assetProtocol.scope`, once in `capabilities/default.json`
  /// under `fs:scope`. A path denied in one and forgotten in the other is
  /// still reachable, and nothing about editing one file makes the other
  /// obvious, so the invariant is asserted rather than left as a comment.
  #[test]
  fn the_two_scope_deny_lists_are_identical() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let read = |p: &str| -> serde_json::Value {
      serde_json::from_str(&std::fs::read_to_string(root.join(p)).expect(p)).expect(p)
    };

    let asset = read("tauri.conf.json")["app"]["security"]["assetProtocol"]["scope"].clone();
    let fs = read("capabilities/default.json")["permissions"]
      .as_array()
      .expect("permissions is a list")
      .iter()
      .find(|p| p["identifier"] == "fs:scope")
      .cloned()
      .expect("capabilities/default.json declares an fs:scope permission");

    // The fs entries are `{ "path": "..." }` objects; the asset ones are bare
    // strings. Compare what they mean, not how each file spells it.
    let paths = |v: &serde_json::Value| -> Vec<String> {
      v.as_array()
        .map(|list| {
          list
            .iter()
            .map(|e| e.get("path").unwrap_or(e).as_str().unwrap_or_default().to_string())
            .collect()
        })
        .unwrap_or_default()
    };

    for list in ["allow", "deny"] {
      let a = paths(&asset[list]);
      let f = paths(&fs[list]);
      assert!(!a.is_empty(), "the asset protocol {list} list is empty");
      assert_eq!(
        a, f,
        "the asset:// and fs:scope {list} lists have drifted apart; edit both"
      );
    }
  }
}
