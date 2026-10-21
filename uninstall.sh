#!/usr/bin/env bash
# Desinstala la app de escritorio DeepSeek Harness (deja ~/.dsh intacto).
set -euo pipefail

APP_DIR="$HOME/.local/share/deepseek-harness-desktop"
ICONS="$HOME/.local/share/icons/hicolor"

rm -f "$HOME/.local/bin/dsh-desktop"
rm -f "$HOME/.local/share/applications/deepseek-harness.desktop"
rm -f "$HOME/Desktop/deepseek-harness.desktop"
rm -f "$ICONS"/*/apps/deepseek-harness.{png,svg}
rm -rf "$APP_DIR"

echo "Hecho. Se conservan ~/.dsh, ~/.local/state/deepseek-harness y ~/.config/deepseek-harness."
