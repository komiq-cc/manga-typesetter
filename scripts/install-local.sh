#!/usr/bin/env bash
# Build the DMG and install it into /Applications, leaving exactly one copy of
# the app registered with macOS.
#
#   ./scripts/install-local.sh
#
# Why this exists. Two things pollute the LaunchServices database on every
# `npm run tauri build`, and both make duplicate entries show up in Launchpad,
# Spotlight and Open With:
#
#   1. bundle_dmg.sh mounts a scratch volume at /Volumes/dmg.XXXXXX while it
#      builds the image. macOS registers the app inside it. The mount is
#      normally ejected, but the registration stays forever - and if a build is
#      interrupted the mount stays too, which then makes the NEXT build's
#      bundle step fail outright.
#   2. The build output itself, target/release/bundle/macos/<app>, is a second
#      real copy of the app on disk and is registered like any other.
#
# So: eject leftovers first, build, install, then unregister everything that is
# not /Applications.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="Manga Typesetter.app"
DEST="/Applications/$APP"
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

echo "== ejecting leftover build volumes =="
for v in /Volumes/dmg.* "/Volumes/Manga Typesetter"; do
  [ -d "$v" ] || continue
  echo "  $v"
  hdiutil detach "$v" -force >/dev/null 2>&1 || true
done
# A rw scratch image left behind by an interrupted run is not reused, only in
# the way.
rm -f src-tauri/target/release/bundle/macos/rw.*.dmg
# Stale updater artifacts from a previous build sit in the same folder the DMG
# is staged from; leaving them means they get packed INTO the DMG next to the
# app.
rm -f "src-tauri/target/release/bundle/macos/$APP.tar.gz" \
      "src-tauri/target/release/bundle/macos/$APP.tar.gz.sig"

echo "== building =="
# Tauri's updater step hard-fails without the signing key; same source as
# release.sh so a local install never dies at the last bundling step.
export TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY:-$HOME/.tauri/typesetter-updater.key}"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
npm run tauri build

# The DMG carries the licence (`bundle.licenseFile`), so attaching it asks the
# user to agree first, and with no one at a terminal to answer hdiutil cancels
# the attach ("user canceled operation"). `yes` answers it. The subshell keeps
# `yes` dying of SIGPIPE from failing the pipeline under pipefail.
attach() { (yes 2>/dev/null || true) | hdiutil attach "$@"; }

DMG=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg | head -1)
[ -n "$DMG" ] || { echo "no DMG was produced"; exit 1; }
echo "== built $DMG =="

# Tauri stages the configured dmg background next to the app while bundling,
# so a visible copy lands in the image root beside the hidden .background one.
# Strip it: convert rw, delete, convert back.
PEEK=$(attach "$DMG" -nobrowse -readonly | grep -o '/Volumes/.*' | tail -1)
STRAY=0
[ -f "$PEEK/dmg-background.png" ] && STRAY=1
hdiutil detach "$PEEK" -force >/dev/null
if [ "$STRAY" = 1 ]; then
  echo "== stripping stray background from image root =="
  hdiutil convert "$DMG" -format UDRW -o "$DMG.rw.dmg" >/dev/null
  M=$(attach "$DMG.rw.dmg" | grep -o '/Volumes/.*' | tail -1)
  rm -f "$M/dmg-background.png"
  hdiutil detach "$M" -force >/dev/null
  rm -f "$DMG"
  hdiutil convert "$DMG.rw.dmg" -format UDZO -o "$DMG" >/dev/null
  rm -f "$DMG.rw.dmg"
fi

echo "== installing =="
if pgrep -f "/Applications/$APP" >/dev/null; then
  echo "  quitting the running app"
  osascript -e 'quit app "Manga Typesetter"' 2>/dev/null || true
  sleep 2
fi
MOUNT=$(attach "$DMG" -nobrowse -readonly | grep -o '/Volumes/.*' | tail -1)
[ -n "$MOUNT" ] || { echo "could not mount $DMG"; exit 1; }
# Replaced rather than merged: a leftover file from an older version inside the
# bundle is exactly the kind of thing that makes one machine behave unlike
# every other.
rm -rf "$DEST"
ditto "$MOUNT/$APP" "$DEST"
hdiutil detach "$MOUNT" -force >/dev/null
echo "  installed to $DEST"

# The build output is a second real copy of the app on disk, so macOS re-scans
# and re-registers it minutes after any unregister. Removing it is the only
# thing that actually holds. Nothing downstream wants it: release.sh publishes
# the .app.tar.gz updater artifact and the DMG, both of which stay.
echo "== removing the build-output copy =="
rm -rf "src-tauri/target/release/bundle/macos/$APP"

echo "== dropping every registration that is not /Applications =="
# The dump is the only way to see them; each is dropped by path. Dead paths
# unregister just as well as live ones, which is what clears the backlog from
# every earlier build.
$LSR -dump 2>/dev/null \
  | grep -io "path: *[^ ].*/$APP" \
  | sed 's/^path: *//' \
  | sort -u \
  | grep -v "^/Applications/$APP\$" \
  | while IFS= read -r p; do
      echo "  $p"
      $LSR -u "$p" 2>/dev/null || true
    done

echo "== registered copies now =="
$LSR -dump 2>/dev/null | grep -i "/$APP" | sed 's/^ *//' | sort -u
