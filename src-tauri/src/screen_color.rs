//! `pick_screen_color()` - the colour picker's eyedropper, on macOS.
//!
//! The picker offers "pick a colour from the screen" wherever the webview has
//! `EyeDropper`, and only Chromium has it: WebView2 on Windows does, the
//! `WKWebView` the app draws in on macOS does not. AppKit has had the same
//! thing natively since 10.15 - `NSColorSampler`, the loupe the system colour
//! panel uses - so on macOS the button asks for that instead. It samples any
//! pixel on any display, which is what the web API does too.
//!
//! The answer is `#rrggbb` in sRGB, the space every colour in a box style is
//! stored in, or `None` when the user pressed Escape. A platform without a
//! sampler answers an error; `src/lib/screen-color.js` never asks there.

#[tauri::command]
pub async fn pick_screen_color(app: tauri::AppHandle) -> Result<Option<String>, String> {
  #[cfg(target_os = "macos")]
  {
    macos::pick(app).await
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = app;
    Err("no native screen colour sampler on this platform".into())
  }
}

#[cfg(target_os = "macos")]
mod macos {
  use std::sync::mpsc;

  use block2::RcBlock;
  use objc2_app_kit::{NSColor, NSColorSampler, NSColorSpace};

  pub async fn pick(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = mpsc::channel::<Option<String>>();
    // AppKit UI belongs to the main thread, and the handler is called back
    // there too, once, when the user clicks or presses Escape.
    app
      .run_on_main_thread(move || {
        let handler = RcBlock::new(move |color: *mut NSColor| {
          // SAFETY: AppKit hands over either nil or a valid colour that
          // lives for the duration of the call.
          let hex = unsafe { color.as_ref() }.and_then(to_srgb_hex);
          let _ = tx.send(hex);
        });
        let sampler = NSColorSampler::new();
        // SAFETY: called on the main thread; the sampler retains itself and
        // the handler until the session ends.
        unsafe { sampler.showSamplerWithSelectionHandler(&handler) };
      })
      .map_err(|error| error.to_string())?;
    // The wait is for a person, so it goes on a blocking thread rather than
    // holding an async worker.
    tauri::async_runtime::spawn_blocking(move || rx.recv())
      .await
      .map_err(|error| error.to_string())?
      .map_err(|_| "the colour sampler closed without answering".to_string())
  }

  /// A sampled colour arrives in the display's own space; box styles are
  /// sRGB, so it is converted before it is read.
  fn to_srgb_hex(color: &NSColor) -> Option<String> {
    let srgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
    let byte = |c: f64| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
    Some(format!(
      "#{:02x}{:02x}{:02x}",
      byte(srgb.redComponent()),
      byte(srgb.greenComponent()),
      byte(srgb.blueComponent()),
    ))
  }
}
