#!/bin/bash
# Builds Unique AV Show Cue for this Mac, makes the DMG, and installs the app
# into Applications. Double-click this file in Finder to run it.

cd "$(dirname "$0")" || exit 1
PROJECT="$(pwd)"
STATUS="$PROJECT/build-status.txt"
LOG="$PROJECT/build-log.txt"
APP_NAME="Unique AV Show Cue"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.showcue-node/bin:$PATH"

status() { echo "$1" | tee "$STATUS"; }
fail() { status "FAILED: $1 (see build-log.txt)"; echo; echo "Press Return to close."; read -r; exit 1; }

exec > >(tee "$LOG") 2>&1
status "STARTED $(date)"

# 1. Node.js – use the installed one, or download a private copy just for building
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  status "DOWNLOADING NODE"
  ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH=x64
  NODE_VER=v20.18.1
  mkdir -p "$HOME/.showcue-node"
  curl -fL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-$ARCH.tar.gz" | tar -xz -C "$HOME/.showcue-node" --strip-components 1 || fail "could not download Node.js"
fi
echo "Using node $(node -v), npm $(npm -v)"

# 2. Install build tools (Electron etc.)
status "INSTALLING PACKAGES"
npm install --no-audit --no-fund || fail "npm install"

# 3. Build the DMG
status "BUILDING DMG"
rm -rf dist
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --arm64 --publish never -c.mac.target=dmg || fail "building the DMG"
DMG=$(ls dist/*.dmg 2>/dev/null | head -1)
[ -f "$DMG" ] || fail "no DMG was produced"

# 4. Install from the DMG into Applications
status "INSTALLING APP"
osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1
MNT=$(mktemp -d /tmp/showcue.XXXX)
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" >/dev/null || fail "opening the DMG"
rm -rf "/Applications/$APP_NAME.app"
ditto "$MNT/$APP_NAME.app" "/Applications/$APP_NAME.app" || { hdiutil detach "$MNT" >/dev/null; fail "copying to Applications"; }
hdiutil detach "$MNT" >/dev/null
xattr -cr "/Applications/$APP_NAME.app"
codesign --force --deep --sign - "/Applications/$APP_NAME.app" >/dev/null 2>&1

# 5. Keep a copy of the DMG next to the project
cp "$DMG" "$PROJECT/../" 2>/dev/null

status "DONE $(basename "$DMG")"
open "/Applications/$APP_NAME.app"
echo
echo "Installed to Applications. The DMG is in Documents. You can close this window."
