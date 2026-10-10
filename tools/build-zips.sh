#!/bin/sh
# Fabrique les deux zips à installer :
#   dist/revendo-extension-vX.Y.Z.zip  → chrome://extensions « Charger l'extension non empaquetée »
#   dist/revendo-web-vX.Y.Z.zip        → app.netlify.com/drop
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/tools/sync-shared.sh"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/extension/manifest.json")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$ROOT/dist"
rm -f "$ROOT"/dist/revendo-*.zip
cp -r "$ROOT/extension" "$TMP/revendo-extension-v$VERSION"
cp -r "$ROOT/web" "$TMP/revendo-web-v$VERSION"
(cd "$TMP" && zip -qr -X "$ROOT/dist/revendo-extension-v$VERSION.zip" "revendo-extension-v$VERSION" && zip -qr -X "$ROOT/dist/revendo-web-v$VERSION.zip" "revendo-web-v$VERSION")
ls -lh "$ROOT"/dist/revendo-*.zip
