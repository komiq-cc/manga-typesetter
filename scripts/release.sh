#!/usr/bin/env bash
# Build, sign, and publish an update to R2 (update-typesetter.komiq.cc).
# Usage: ./scripts/release.sh ["release notes"]
# Run on mac -> publishes darwin entry. Run on windows (git-bash) -> publishes windows entry.
# latest.json is merged, so platforms built on other machines are preserved.
set -euo pipefail
cd "$(dirname "$0")/.."

NOTES="${1:-}"
BASE_URL="https://update-typesetter.komiq.cc"
BUCKET="typesetter-updates"
KEY_PATH="$HOME/.tauri/typesetter-updater.key"

[ -f "$KEY_PATH" ] || { echo "signing key missing: $KEY_PATH"; exit 1; }
# Tauri v2 reads TAURI_SIGNING_PRIVATE_KEY (path or key content); the
# _PATH-suffixed name is not recognized.
export TAURI_SIGNING_PRIVATE_KEY="$KEY_PATH"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
PRODUCT=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['productName'])")

# Anything this build writes is newer than this file - see `artifact` below.
STAMP=$(mktemp)
trap 'rm -f "$STAMP"' EXIT

echo "== building v$VERSION =="
npm run tauri build

# platform key + updater artifact
OS=$(uname -s); ARCH=$(uname -m)
case "$OS-$ARCH" in
  Darwin-arm64)  PLATFORM="darwin-aarch64" ;;
  Darwin-x86_64) PLATFORM="darwin-x86_64" ;;
  MINGW*-*|MSYS*-*) PLATFORM="windows-x86_64" ;;
  *) echo "unsupported platform $OS-$ARCH"; exit 1 ;;
esac

# The one file this build produced for this product, version and arch, or stop.
#
# The bundle directory outlives a build. Tauri names the DMG and the NSIS
# installer by version and never clears the old ones out, so the `ls | head -1`
# this used to be picked whichever sorted first: the 0.3.0 installer and its
# still-valid signature, uploaded under the 0.3.1 URL and manifest, which
# reinstalls the old version and offers the same update again. The updater
# tarball carries no version at all, so a "Manga Typesetter Rust.app.tar.gz"
# left by the side-by-side build could sort ahead of ours. So the name is
# built from tauri.conf.json rather than searched for (Tauri's own format:
# `<product>_<version>_<arch>`), the file must have been written by THIS build,
# and any other file claiming the same version and arch (the rest of the
# arguments, a glob) is an ambiguity to settle by hand, not a choice to make.
artifact() {
  local want="$1" f
  shift
  [ -f "$want" ] || { echo "build output missing: $want" >&2; return 1; }
  for f in "$@"; do
    if [ -e "$f" ] && [ "$f" != "$want" ]; then
      echo "ambiguous build output: $f also claims v$VERSION for this arch (beside $want); remove it and run again" >&2
      return 1
    fi
  done
  [ "$want" -nt "$STAMP" ] || { echo "stale build output: $want was not written by this build" >&2; return 1; }
  printf '%s\n' "$want"
}

BUNDLE_DIR="src-tauri/target/release/bundle"
case "$PLATFORM" in
  darwin-*)
    case "$PLATFORM" in darwin-aarch64) BARCH="aarch64" ;; *) BARCH="x64" ;; esac
    ARTIFACT=$(artifact "$BUNDLE_DIR/macos/$PRODUCT.app.tar.gz")
    # Optional, as it always was - but when there is one it must be this
    # version's, never an older one left beside it.
    DMG="$BUNDLE_DIR/dmg/${PRODUCT}_${VERSION}_${BARCH}.dmg"
    EXTRA=""
    if [ -e "$DMG" ]; then
      EXTRA=$(artifact "$DMG" "$BUNDLE_DIR"/dmg/*_"${VERSION}_${BARCH}".dmg)
    else
      echo "note: no $DMG; publishing the updater bundle only"
    fi
    EXT="app.tar.gz"
    ;;
  windows-*)
    ARTIFACT=$(artifact "$BUNDLE_DIR/nsis/${PRODUCT}_${VERSION}_x64-setup.exe" \
      "$BUNDLE_DIR"/nsis/*_"${VERSION}"_x64-setup.exe)
    EXTRA=""
    EXT="setup.exe"
    ;;
esac
SIG="$ARTIFACT.sig"
[ -f "$SIG" ] || { echo "signature missing: $SIG (is bundle.createUpdaterArtifacts true?)"; exit 1; }
# A signature left over from an earlier build of the same name would be a
# valid signature for different bytes - and the updater refuses those.
[ "$SIG" -nt "$STAMP" ] || { echo "stale signature: $SIG was not written by this build"; exit 1; }

# Platform-tagged, space-free name: keeps mac arches distinct in R2 and keeps
# update URLs safe without percent-encoding. Must match release.yml's naming.
FNAME="MangaTypesetter_${VERSION}_${PLATFORM}.${EXT}"
REMOTE="releases/v$VERSION/$FNAME"
echo "== uploading $FNAME =="
npx wrangler r2 object put "$BUCKET/$REMOTE" --file "$ARTIFACT" --remote
if [ -n "$EXTRA" ]; then
  npx wrangler r2 object put "$BUCKET/releases/v$VERSION/MangaTypesetter_${VERSION}_${PLATFORM}.dmg" --file "$EXTRA" --remote
fi

echo "== merging latest.json =="
# 404 means first release ever; any other failure must abort rather than
# silently rebuilding latest.json from nothing.
HTTP=$(curl -s -o /tmp/existing-latest.$$ -w "%{http_code}" "$BASE_URL/latest.json" || echo 000)
case "$HTTP" in
  200) EXISTING=$(cat /tmp/existing-latest.$$) ;;
  404) EXISTING='{}' ;;
  *) echo "fetching existing latest.json failed (HTTP $HTTP), aborting"; rm -f /tmp/existing-latest.$$; exit 1 ;;
esac
rm -f /tmp/existing-latest.$$
LATEST=$(EXISTING_JSON="$EXISTING" python3 - "$VERSION" "$PLATFORM" "$BASE_URL/$REMOTE" "$SIG" "$NOTES" <<'PY'
import json, sys, os, datetime
version, platform, url, sig_path, notes = sys.argv[1:6]
try:
    data = json.loads(os.environ.get("EXISTING_JSON", "{}"))
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
same_version = data.get("version") == version
platforms = data.get("platforms", {}) if same_version else {}
platforms[platform] = {"signature": open(sig_path).read().strip(), "url": url}
out = {
    "version": version,
    "notes": notes or (data.get("notes", "") if same_version else ""),
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": platforms,
}
print(json.dumps(out, indent=2))
PY
)
TMP_LATEST=$(mktemp)
echo "$LATEST" > "$TMP_LATEST"
npx wrangler r2 object put "$BUCKET/latest.json" --file "$TMP_LATEST" --remote
rm -f "$TMP_LATEST"

echo "== done =="
echo "$LATEST"
echo "check: curl $BASE_URL/latest.json"
