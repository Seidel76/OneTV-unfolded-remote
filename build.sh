#!/usr/bin/env bash
# Fabrique l'archive .tar.gz installable dans le Web Configurator de la Remote.
#
# AUCUNE compilation : la Remote embarque Node.js. On copie les sources + les
# node_modules de production, et c'est tout. Résultat : artifacts/uc-intg-onetv-<v>.tar.gz
set -euo pipefail

cd "$(dirname "$0")"
VERSION="$(node -p "require('./driver.json').version")"
STAGE="build/stage"

rm -rf build artifacts
mkdir -p "$STAGE/bin" artifacts

# Dépendances de production uniquement, dans un arbre propre.
npm install --omit=dev --no-audit --no-fund

# Layout imposé par le firmware : driver.json à la racine, code dans ./bin
cp -R src/. "$STAGE/bin/"
cp -R node_modules "$STAGE/bin/node_modules"
cp package.json "$STAGE/bin/package.json"
cp driver.json "$STAGE/driver.json"

# Le firmware lance ./bin/driver.js — nos modules sont déjà à côté.
rm -f "$STAGE/bin/driver.json"

# 🚨 Le firmware REFUSE les liens symboliques dans l'archive. npm en pose dans
# node_modules/.bin (ici multicast-dns → ../multicast-dns/cli.js) : ce sont des CLI dont
# on ne se sert pas, on les supprime. On vérifie ensuite qu'il n'en reste aucun.
rm -rf "$STAGE/bin/node_modules/.bin"
LINKS="$(find "$STAGE" -type l | wc -l | tr -d ' ')"
if [ "$LINKS" != "0" ]; then
  echo "❌ $LINKS lien(s) symbolique(s) dans l'archive — le firmware les refuse :" >&2
  find "$STAGE" -type l >&2
  exit 1
fi

tar -czf "artifacts/uc-intg-onetv-${VERSION}.tar.gz" -C "$STAGE" .
SIZE="$(du -h "artifacts/uc-intg-onetv-${VERSION}.tar.gz" | cut -f1)"
echo "→ artifacts/uc-intg-onetv-${VERSION}.tar.gz (${SIZE})"
