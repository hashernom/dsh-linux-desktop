#!/usr/bin/env bash
# Instala DSH Desktop para el usuario actual.
#
#   ./install.sh                      copia a ~/.local/share/dsh-linux-desktop
#   DSH_DESKTOP_INSTALL_DIR=$PWD ./install.sh   instala en el propio repo
set -euo pipefail

APP_ID="dsh-linux-desktop"
APP_NAME="DSH Desktop"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${DSH_DESKTOP_INSTALL_DIR:-$HOME/.local/share/$APP_ID}"

BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICONS_DIR="$HOME/.local/share/icons/hicolor"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

say "Origen: $SRC"
say "Destino: $DEST"

# 1) Código
if [ "$SRC" != "$DEST" ]; then
  mkdir -p "$DEST"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude .git --exclude node_modules "$SRC/" "$DEST/"
  else
    cp -a "$SRC/." "$DEST/"
    rm -rf "$DEST/.git"
  fi
fi

# 2) Dependencias (Electron)
if [ ! -x "$DEST/node_modules/electron/dist/electron" ]; then
  say "Instalando dependencias (Electron, ~275 MB)…"
  (cd "$DEST" && npm install --no-audit --no-fund)
fi

# 3) Lanzador
mkdir -p "$BIN_DIR"
ln -sf "$DEST/bin/deepseek-harness" "$BIN_DIR/dsh-desktop"
say "Lanzador: $BIN_DIR/dsh-desktop"

# 4) Iconos
for size in 22 24 32 44 48 64 128 256 512 1024; do
  src_icon="$DEST/assets/icon-$size.png"
  [ -f "$src_icon" ] || continue
  dir="$ICONS_DIR/${size}x${size}/apps"
  mkdir -p "$dir"
  cp -f "$src_icon" "$dir/$APP_ID.png"
done
mkdir -p "$ICONS_DIR/scalable/apps"
cp -f "$DEST/assets/icon.svg" "$ICONS_DIR/scalable/apps/$APP_ID.svg"
gtk-update-icon-cache -f -t "$ICONS_DIR" >/dev/null 2>&1 || true

# 5) Entrada de escritorio
desktop_entry() {
  cat <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=$APP_NAME
GenericName=Shell de escritorio para agentes IA
Comment=Shell de escritorio no oficial para DeepSeek Harness
Exec=$DEST/bin/deepseek-harness
TryExec=$DEST/bin/deepseek-harness
Icon=$APP_ID
Terminal=false
StartupNotify=true
StartupWMClass=$APP_ID
Categories=Development;
Keywords=dsh;deepseek;harness;agent;linux;electron;
DESKTOP
}

mkdir -p "$APPS_DIR"
desktop_entry > "$APPS_DIR/$APP_ID.desktop"
chmod +x "$APPS_DIR/$APP_ID.desktop"
if [ -d "$DESKTOP_DIR" ]; then
  desktop_entry > "$DESKTOP_DIR/$APP_ID.desktop"
  chmod +x "$DESKTOP_DIR/$APP_ID.desktop"
  gio set "$DESKTOP_DIR/$APP_ID.desktop" metadata::trusted true >/dev/null 2>&1 || true
fi

# 6) Limpieza de la instalación anterior (nombres viejos)
rm -f "$APPS_DIR/deepseek-harness.desktop" "$DESKTOP_DIR/deepseek-harness.desktop"
rm -f "$ICONS_DIR"/*/apps/deepseek-harness.{png,svg} 2>/dev/null || true

update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true

say "Listo. Abre «$APP_NAME» desde el menú, el escritorio o con: dsh-desktop"
