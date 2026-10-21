#!/usr/bin/env bash
# Desinstala DSH Desktop. No toca ~/.dsh (tus sesiones, MCPs y credenciales).
set -euo pipefail

APP_ID="dsh-linux-desktop"
DEST="${DSH_DESKTOP_INSTALL_DIR:-$HOME/.local/share/$APP_ID}"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"

rm -f "$HOME/.local/bin/dsh-desktop"
rm -f "$HOME/.local/share/applications/$APP_ID.desktop"
rm -f "$DESKTOP_DIR/$APP_ID.desktop"
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/$APP_ID.desktop"
rm -f "$HOME/.local/share/icons/hicolor"/*/apps/"$APP_ID".{png,svg} 2>/dev/null || true

# Solo borra el directorio si no es el propio repo desde el que se ejecuta.
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$SRC" != "$DEST" ] && [ -d "$DEST" ]; then
  rm -rf "$DEST"
fi

echo "Desinstalado. Se conservan ~/.dsh y el directorio de estado (~/.local/state/$APP_ID)."
