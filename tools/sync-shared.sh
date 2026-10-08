#!/bin/sh
# Copie extension/shared (source de vérité) vers web/shared.
# À lancer après toute modification d'un fichier de shared/.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$ROOT/web/shared"
cp -r "$ROOT/extension/shared" "$ROOT/web/shared"
echo "web/shared synchronisé depuis extension/shared"
