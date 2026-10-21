# DSH Desktop (Linux)

**Unofficial Linux desktop shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

A native Electron window around `dsh web`: no browser, no tabs, its own icon,
system tray and desktop integration. It reuses the `dsh` you already have
installed via npm, so your sessions, MCP servers, skills and credentials stay
in `~/.dsh` exactly as they are.

> Not affiliated with, endorsed by, or supported by DeepSeek. See [NOTICE](NOTICE.md).

![Splash](docs/splash.png)

## Why

The official Desktop app ships for macOS and Windows only. This project fills
the gap on Linux by wrapping the Web profile the CLI already provides, without
building the monorepo and without touching your existing DSH setup.

## Features

- **Native window** with its own icon — no browser, no address bar.
- **Own server per launch**: starts `dsh web --no-open --port 0`, parses the
  authenticated URL and loads it; on quit it kills the whole process group
  (server plus every MCP child).
- **System tray**: closing the window hides it and keeps the session warm;
  reopen instantly. Menu with open, new session, restart server, logs and quit.
- **Desktop integration**: `.desktop` entry, hicolor icons, `dsh-desktop`
  command, optional start-at-login.
- **Updates**: checks `@deepseek-ai/dsh` on npm (manual or silent daily),
  installs with npm and restarts the server.
- **Sandbox aware**: uses Chromium's sandbox when the system allows it and
  falls back to `--no-sandbox` on Ubuntu 24.04+ setups where AppArmor blocks
  unprivileged user namespaces.

## Requirements

- Linux (X11 or Wayland; developed on Ubuntu 26.04 + KDE Plasma 6 Wayland)
- Node.js 20+ and npm
- `dsh` installed: `npm i -g @deepseek-ai/dsh`

## Install

```bash
git clone https://github.com/<you>/dsh-linux-desktop.git
cd dsh-linux-desktop
./install.sh
```

`install.sh` installs to `~/.local/share/dsh-linux-desktop`, downloads Electron
(~275 MB) on first run, and registers the launcher, icons and desktop entries.

Install in place (no copy, handy while hacking on it):

```bash
DSH_DESKTOP_INSTALL_DIR=$PWD ./install.sh
```

Uninstall:

```bash
./uninstall.sh        # keeps ~/.dsh and the app state directory
```

## Usage

- App menu → **DSH Desktop**
- Desktop icon → **DSH Desktop**
- Terminal → `dsh-desktop`

Closing the window hides it to the tray. Use **Salir** in the tray menu to quit
for real. Uncheck *"Cerrar la ventana la oculta"* to go back to close-to-quit.

## Updates

- **Manual**: *Ayuda → Buscar actualizaciones…* (or the same item in the tray).
  Shows installed vs available version with *Actualizar ahora* / *Ver novedades*.
- **Automatic**: one silent check per 12 h; notifies once per new version and
  never installs on its own. Toggle with *Ayuda → Comprobar al iniciar*.

Updating runs `npm install -g @deepseek-ai/dsh@latest` using the npm that owns
the detected `dsh` binary (for example the nvm one), then restarts the local
server.

The wrapper itself does not self-update: `git pull` and, if dependencies
changed, `npm install`.

## How it works

1. Resolves the `dsh` binary (`DSH_BIN`, `~/.local/bin`, nvm, `PATH`).
2. Spawns `dsh web --no-open --port 0` in its own process group.
3. Reads the `dsh web: http://127.0.0.1:PORT/?token=…` line from stdout.
4. Loads that URL in the window; a splash covers the boot.
5. On quit, sends `SIGTERM` to the group and `SIGKILL` after 4 s.

## Environment variables

| Variable | Effect |
|---|---|
| `DSH_BIN` | Explicit path to the `dsh` binary |
| `DSH_DESKTOP_INSTALL_DIR` | Install target for `install.sh` |
| `DSH_DESKTOP_SANDBOX=1` | Force Chromium's sandbox |
| `DSH_DESKTOP_NO_SANDBOX=1` | Force `--no-sandbox` |
| `DSH_DESKTOP_CAPTURE` | Capture the window to a PNG and exit (tests) |
| `DSH_DESKTOP_CAPTURE_DELAY` | Milliseconds before capturing (default 6000) |
| `DSH_DESKTOP_TEST_HIDE` | Close the window and verify the tray path |
| `DSH_DESKTOP_TEST_UPDATE` | Run the updater check and exit |

## Files

| What | Where |
|---|---|
| App | `~/.local/share/dsh-linux-desktop/` |
| Launcher | `~/.local/bin/dsh-desktop` |
| Menu entry | `~/.local/share/applications/dsh-linux-desktop.desktop` |
| Icons | `~/.local/share/icons/hicolor/*/apps/dsh-linux-desktop.*` |
| State, preferences, logs | `~/.local/state/dsh-linux-desktop/` |
| Chromium profile | `~/.config/dsh-linux-desktop/` |

## Troubleshooting

```bash
tail -f ~/.local/state/dsh-linux-desktop/logs/desktop.log  # app boot and errors
tail -f ~/.local/state/dsh-linux-desktop/logs/server.log   # dsh web output
```

**The window does not open.** Run `dsh-desktop` in a terminal and read stderr.
On systems that block unprivileged user namespaces, start with
`DSH_DESKTOP_NO_SANDBOX=1 dsh-desktop`.

**"No encuentro el ejecutable dsh".** Install it (`npm i -g @deepseek-ai/dsh`)
or point `DSH_BIN` at it.

## License

MIT. See [LICENSE](LICENSE).
