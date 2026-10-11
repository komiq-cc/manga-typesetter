#!/usr/bin/env bash
# Build the side-by-side test copy, "Manga Typesetter Rust", and install it
# into /Applications beside the released app.
#
#   ./scripts/install-sxs.sh
#
# It is the same app under another name and identifier
# (src-tauri/tauri.sxs.conf.json), so macOS runs the two at once and each has
# its own preferences and font library. What differs:
#
#   - the text engine preference starts on 'rust' (VITE_MT_TEXT_ENGINE);
#   - it has no update endpoint: an update would replace it with the released
#     app;
#   - no DMG and no updater artifacts, so no signing key and no Finder step.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="Manga Typesetter Rust.app"
DEST="/Applications/$APP"
OUT="src-tauri/target/release/bundle/macos/$APP"
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

echo "== building =="
npm run tauri build -- --config src-tauri/tauri.sxs.conf.json --bundles app

# The engine is its own build step, and the app builds and runs without it -
# on the browser, which is the one thing this copy must not do.
ls dist/assets/mt_text*.wasm >/dev/null 2>&1 || { echo "the build has no text engine wasm"; exit 1; }
[ -d "$OUT" ] || { echo "no app was produced"; exit 1; }

echo "== installing =="
if pgrep -f "/Applications/$APP" >/dev/null; then
  echo "  quitting the running app"
  osascript -e 'quit app "Manga Typesetter Rust"' 2>/dev/null || true
  sleep 2
fi
rm -rf "$DEST"
ditto "$OUT" "$DEST"
echo "  installed to $DEST"

# As in install-local.sh: the build output is a second copy macOS registers.
rm -rf "$OUT"
$LSR -dump 2>/dev/null \
  | grep -io "path: *[^ ].*/$APP" \
  | sed 's/^path: *//' \
  | sort -u \
  | grep -v "^/Applications/$APP\$" \
  | while IFS= read -r p; do
      $LSR -u "$p" 2>/dev/null || true
    done || true
