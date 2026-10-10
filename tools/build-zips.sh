#!/bin/sh
# Fabrique les deux zips à installer :
#   dist/revendo-extension-vX.Y.Z.zip  → chrome://extensions « Charger l'extension non empaquetée »
#   dist/revendo-web-vX.Y.Z.zip        → app.netlify.com/drop
# Les fichiers sont à la RACINE du zip (pas de sous-dossier) : « Extraire tout »
# de Windows crée alors un seul dossier revendo-extension-vX.Y.Z qui contient
# directement manifest.json. Avec un sous-dossier dans le zip, Windows en créait
# deux l'un dans l'autre et Chrome répondait « fichier manifeste manquant ».
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/tools/sync-shared.sh"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/extension/manifest.json")"
mkdir -p "$ROOT/dist"
rm -f "$ROOT"/dist/revendo-*.zip
(cd "$ROOT/extension" && zip -qr -X "$ROOT/dist/revendo-extension-v$VERSION.zip" . -x '.*' -x '*/.*')
(cd "$ROOT/web" && zip -qr -X "$ROOT/dist/revendo-web-v$VERSION.zip" . -x '.*' -x '*/.*')
# Vérification : manifest.json et index.html à la racine.
unzip -l "$ROOT/dist/revendo-extension-v$VERSION.zip" | grep -q ' manifest.json$' || { echo 'manifest.json absent de la racine du zip' >&2; exit 1; }
unzip -l "$ROOT/dist/revendo-web-v$VERSION.zip" | grep -q ' index.html$' || { echo 'index.html absent de la racine du zip' >&2; exit 1; }
ls -lh "$ROOT"/dist/revendo-*.zip
