'use strict'

/**
 * DeepSeek Harness — envoltorio de escritorio.
 *
 * Arranca su propio `dsh web --no-open --port 0`, lee del stdout la URL
 * autenticada y la carga en una ventana nativa. Al cerrar la app se lleva por
 * delante el servidor y todos sus hijos (MCPs incluidos).
 */

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  Notification,
  nativeImage,
  ipcMain,
  shell,
  dialog,
  screen,
} = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const APP_NAME = 'DSH Desktop'
const APP_ID = 'dsh-linux-desktop'
const APP_DIR = __dirname
const HOME = os.homedir()

const STARTUP_TIMEOUT_MS = 180_000

app.setName(APP_NAME)
if (process.platform === 'linux') {
  app.setDesktopName(`${APP_ID}.desktop`)
  app.commandLine.appendSwitch('class', APP_ID)
}

// Flags de CLI antes de tocar Electron.
const cliArgs = process.argv.slice(1).filter((arg) => arg.startsWith('-'))
if (cliArgs.includes('--version') || cliArgs.includes('-v')) {
  process.stdout.write(`${app.getVersion()}\n`)
  process.exit(0)
}
if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
  process.stdout.write(
    [
      'DSH Desktop — shell de escritorio no oficial para DeepSeek Harness.',
      '',
      'Uso:',
      '  dsh-desktop                 abre la aplicación',
      '  dsh-desktop --version       muestra la versión del envoltorio',
      '  dsh-desktop --help          esta ayuda',
      '',
      'Variables: DSH_BIN, DSH_DESKTOP_SANDBOX, DSH_DESKTOP_NO_SANDBOX',
      '',
    ].join('\n'),
  )
  process.exit(0)
}

// Perfil propio, sin el espacio que `productName` metería en ~/.config.
app.setPath(
  'userData',
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_ID),
)

// ---------------------------------------------------------------- directorios

const XDG_STATE = process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state')
const STATE_DIR = path.join(XDG_STATE, APP_ID)
const LOG_DIR = path.join(STATE_DIR, 'logs')
const SERVER_LOG = path.join(LOG_DIR, 'server.log')
const DESKTOP_LOG = path.join(LOG_DIR, 'desktop.log')
/** Preferencias persistentes de la app. */
const PREFERENCES_FILE = path.join(STATE_DIR, 'preferences.json')
const DEFAULT_PREFERENCES = { closeToTray: true, autoCheckUpdates: true }

function loadPreferences() {
  try {
    return { ...DEFAULT_PREFERENCES, ...JSON.parse(fs.readFileSync(PREFERENCES_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

const preferences = loadPreferences()

function savePreferences(patch) {
  Object.assign(preferences, patch)
  try {
    fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(preferences, null, 2))
  } catch {}
}

const WINDOW_STATE_FILE = path.join(STATE_DIR, 'window.json')

try {
  fs.mkdirSync(LOG_DIR, { recursive: true })
} catch {}

function trace(message) {
  try {
    fs.appendFileSync(DESKTOP_LOG, `[${new Date().toISOString()}] ${message}\n`)
  } catch {}
}

// --------------------------------------------------------------------- logs

function appendLog(chunk) {
  try {
    const stat = fs.statSync(SERVER_LOG)
    if (stat.size > 5 * 1024 * 1024) fs.renameSync(SERVER_LOG, `${SERVER_LOG}.1`)
  } catch {}
  try {
    fs.appendFileSync(SERVER_LOG, chunk)
  } catch {}
}

// ------------------------------------------------------------------ binario

function isExecutable(file) {
  try {
    return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true)
  } catch {
    return false
  }
}

function nvmCandidates() {
  const base = path.join(HOME, '.nvm', 'versions', 'node')
  let versions = []
  try {
    versions = fs.readdirSync(base)
  } catch {
    return []
  }
  return versions
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((version) => path.join(base, version, 'bin', 'dsh'))
}

function resolveDshBinary() {
  if (process.env.DSH_BIN && isExecutable(process.env.DSH_BIN)) return process.env.DSH_BIN

  const known = [
    path.join(HOME, '.local', 'bin', 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
    ...nvmCandidates(),
  ]
  for (const candidate of known) if (isExecutable(candidate)) return candidate

  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'dsh')
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function childEnvironment(dshBin) {
  const extra = [
    path.dirname(dshBin),
    path.join(HOME, '.local', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]
  const current = String(process.env.PATH || '').split(path.delimiter)
  const PATH = [...new Set([...extra, ...current])].filter(Boolean).join(path.delimiter)
  return { ...process.env, PATH, DSH_DESKTOP_APP: '1' }
}

// ------------------------------------------------------------------ estado

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {Tray | null} */
let tray = null
/** @type {import('node:child_process').ChildProcess | null} */
let serverProcess = null
let serverUrl = null
let starting = false
/** El usuario pidió salir: el cierre de ventana ya no se intercepta. */
let forceQuit = false
/** El apagado del servidor está en curso. */
let shuttingDown = false
let hiddenNoticeShown = false
let updateCheckRunning = false
let updateInstalling = false
let lastStatus = { phase: 'idle', message: '' }

function setStatus(phase, message, extra = {}) {
  lastStatus = { phase, message, ...extra, at: Date.now() }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh:status', lastStatus)
  }
  refreshTray()
}

function showSplash() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadFile(path.join(APP_DIR, 'splash.html'))
}

function showError() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadFile(path.join(APP_DIR, 'error.html'))
}

// ----------------------------------------------------------------- servidor

function stopServer() {
  return new Promise((resolve) => {
    const child = serverProcess
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      serverProcess = null
      return resolve()
    }

    const pid = child.pid
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      serverProcess = null
      resolve()
    }

    child.once('exit', finish)

    const signalGroup = (signal) => {
      try {
        process.kill(-pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {}
      }
    }

    signalGroup('SIGTERM')
    setTimeout(() => {
      if (!settled) signalGroup('SIGKILL')
      setTimeout(finish, 300)
    }, 4000)
  })
}

function startServer() {
  if (starting) return

  const dshBin = resolveDshBinary()
  if (!dshBin) {
    setStatus('error', 'No encuentro el ejecutable `dsh` en el PATH.', {
      detail:
        'Instala DeepSeek Harness (`npm i -g @deepseek-ai/dsh`) o define DSH_BIN con la ruta al binario.',
    })
    showError()
    return
  }

  starting = true
  serverUrl = null
  trace(`arrancando servidor: ${dshBin} web --no-open --port 0`)
  setStatus('starting', 'Arrancando el servidor local…', { binary: dshBin })

  let child
  try {
    child = spawn(dshBin, ['web', '--no-open', '--port', '0'], {
      cwd: HOME,
      env: childEnvironment(dshBin),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    starting = false
    setStatus('error', 'No se pudo lanzar el servidor.', { detail: String(error) })
    showError()
    return
  }

  serverProcess = child

  let stdout = ''
  let stderrTail = ''
  let timer = null

  const settleReady = (url) => {
    if (serverUrl) return
    serverUrl = url
    starting = false
    if (timer) clearTimeout(timer)
    trace(`servidor listo: ${url.replace(/token=[^&]+/, 'token=***')}`)
    setStatus('ready', 'Listo', { url })
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow
        .loadURL(url)
        .then(() => {
          maybeCapture()
          maybeTestHide()
          maybeTestUpdate()
        })
        .catch(() => {})
    }
  }

  const settleError = (message, detail) => {
    if (serverUrl) return
    starting = false
    if (timer) clearTimeout(timer)
    trace(`error de arranque: ${message}`)
    setStatus('error', message, { detail, binary: dshBin })
    showError()
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    appendLog(chunk)
    stdout += chunk
    let index
    while ((index = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, index)
      stdout = stdout.slice(index + 1)
      const match = line.match(/dsh web:\s+(https?:\/\/\S+)/)
      if (match) settleReady(match[1].trim())
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    appendLog(chunk)
    stderrTail = (stderrTail + chunk).slice(-6000)
  })

  child.on('error', (error) => {
    settleError('No se pudo ejecutar el servidor.', String(error))
  })

  child.on('exit', (code, signal) => {
    trace(`servidor terminó (código=${code ?? 'null'} señal=${signal ?? 'null'})`)
    serverProcess = null
    if (serverUrl) {
      if (!forceQuit) {
        setStatus('error', 'El servidor local se ha detenido.', {
          detail: `Código: ${code ?? signal}\n\n${stderrTail}`,
        })
        showError()
      }
      return
    }
    settleError('El servidor terminó antes de estar listo.', `Código: ${code ?? signal}\n\n${stderrTail}`)
  })

  timer = setTimeout(() => {
    settleError(
      'El servidor tardó demasiado en arrancar.',
      `Sin respuesta tras ${Math.round(STARTUP_TIMEOUT_MS / 1000)} s.\n\n${stderrTail}`,
    )
  }, STARTUP_TIMEOUT_MS)
}

async function restartServer() {
  await stopServer()
  showSplash()
  setStatus('starting', 'Reiniciando…')
  startServer()
}

// ------------------------------------------------------------------ ventana

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const bounds = mainWindow.getNormalBounds()
    fs.writeFileSync(
      WINDOW_STATE_FILE,
      JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }),
    )
  } catch {}
}

function boundsAreVisible(bounds) {
  if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return false
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapX =
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x)
    const overlapY =
      Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y)
    return overlapX > 120 && overlapY > 80
  })
}

function isInternalUrl(target) {
  if (typeof target !== 'string') return false
  if (target.startsWith('file://')) return true
  if (!serverUrl) return false
  try {
    return new URL(target).origin === new URL(serverUrl).origin
  } catch {
    return false
  }
}


// ------------------------------------------------------------- inicio auto

const AUTOSTART_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'),
  'autostart',
  `${APP_ID}.desktop`,
)

function autostartEnabled() {
  try {
    return fs.existsSync(AUTOSTART_FILE)
  } catch {
    return false
  }
}

function setAutostart(enabled) {
  try {
    if (!enabled) {
      fs.rmSync(AUTOSTART_FILE, { force: true })
      return
    }
    fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true })
    const exec = `"${process.execPath}" "${APP_DIR}"`
    fs.writeFileSync(
      AUTOSTART_FILE,
      [
        '[Desktop Entry]',
        'Type=Application',
        `Name=${APP_NAME}`,
        'Comment=Shell de escritorio no oficial para DeepSeek Harness',
        `Exec=${exec}`,
        `Icon=${APP_ID}`,
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        'Hidden=false',
        '',
      ].join('\n'),
    )
  } catch (error) {
    trace(`no se pudo cambiar el autoarranque: ${String(error)}`)
  }
}

// ------------------------------------------------------------------ bandeja

function trayStatusLabel() {
  switch (lastStatus.phase) {
    case 'ready':
      try {
        return `listo · ${new URL(lastStatus.url).host}`
      } catch {
        return 'listo'
      }
    case 'starting':
      return 'arrancando…'
    case 'error':
      return 'con errores'
    default:
      return 'inactivo'
  }
}

function refreshTray() {
  if (!tray) return
  try {
    tray.setToolTip(`${APP_NAME} — ${trayStatusLabel()}`)
    tray.setContextMenu(buildTrayMenu())
  } catch {}
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide()
  else showWindow()
}

function newSession() {
  showWindow()
  if (mainWindow && !mainWindow.isDestroyed() && serverUrl) {
    mainWindow.webContents.loadURL(serverUrl).catch(() => {})
  }
}

function notify(title, body) {
  if (!Notification.isSupported()) return
  try {
    new Notification({
      title,
      body,
      icon: path.join(APP_DIR, 'assets', 'icon-128.png'),
      silent: true,
    }).show()
  } catch {}
}

function notifyHidden() {
  if (hiddenNoticeShown) return
  hiddenNoticeShown = true
  notify(
    `${APP_NAME} sigue activo`,
    'Se ha ocultado a la bandeja del sistema. Pulsa el icono de la ballena para volver.',
  )
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Abrir DeepSeek Harness', click: () => showWindow() },
    { label: 'Nueva sesión', click: () => newSession() },
    { type: 'separator' },
    { label: `Estado: ${trayStatusLabel()}`, enabled: false },
    { label: 'Buscar actualizaciones…', click: () => checkForUpdates({ manual: true }) },
    { label: 'Reiniciar servidor', click: () => restartServer() },
    { label: 'Abrir registros', click: () => shell.openPath(LOG_DIR) },
    { type: 'separator' },
    {
      label: 'Cerrar la ventana la oculta',
      type: 'checkbox',
      checked: preferences.closeToTray,
      click: (item) => {
        savePreferences({ closeToTray: item.checked })
        refreshTray()
      },
    },
    {
      label: 'Iniciar con la sesión',
      type: 'checkbox',
      checked: autostartEnabled(),
      click: (item) => setAutostart(item.checked),
    },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        forceQuit = true
        app.quit()
      },
    },
  ])
}

function createTray() {
  if (tray) return
  try {
    const base = nativeImage.createFromPath(path.join(APP_DIR, 'assets', 'icon-22.png'))
    tray = new Tray(base)
    tray.setToolTip(`${APP_NAME} — ${trayStatusLabel()}`)
    tray.setContextMenu(buildTrayMenu())
    tray.on('click', () => toggleWindow())
    tray.on('double-click', () => showWindow())
    trace('bandeja del sistema creada')
  } catch (error) {
    tray = null
    trace(`no se pudo crear la bandeja: ${String(error)}`)
    // Sin bandeja no hay dónde recuperar la ventana: cerrar debe salir.
    savePreferences({ closeToTray: false })
  }
}

/** Captura opcional de la ventana (usada por las pruebas automáticas). */
async function maybeCapture() {
  const target = process.env.DSH_DESKTOP_CAPTURE
  if (!target || !mainWindow || mainWindow.isDestroyed()) return
  const delay = Number(process.env.DSH_DESKTOP_CAPTURE_DELAY || 6000)
  await new Promise((resolve) => setTimeout(resolve, delay))
  try {
    const image = await mainWindow.webContents.capturePage()
    fs.writeFileSync(target, image.toPNG())
    trace(`captura guardada en ${target}`)
  } catch (error) {
    trace(`captura fallida: ${String(error)}`)
  }
  app.quit()
}

/** Prueba automática del comprobador de actualizaciones. */
async function maybeTestUpdate() {
  if (!process.env.DSH_DESKTOP_TEST_UPDATE) return
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await checkForUpdates({ manual: false })
  trace(`test update: fin (instalada=${await installedVersion(resolveDshBinary())})`)
  forceQuit = true
  app.quit()
}

/** Prueba automática: cierra la ventana y comprueba que queda en la bandeja. */
async function maybeTestHide() {
  if (!process.env.DSH_DESKTOP_TEST_HIDE) return
  await new Promise((resolve) => setTimeout(resolve, 3000))
  mainWindow.close()
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const hidden = Boolean(mainWindow) && !mainWindow.isVisible()
  trace(
    `test bandeja: oculta=${hidden} servidor=${Boolean(serverProcess)} bandeja=${Boolean(tray)}`,
  )
  forceQuit = true
  app.quit()
}

// ------------------------------------------------------------ actualizaciones

const RELEASES_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases'
const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000

function parseVersion(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || '' }
}

function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) {
      return left.numbers[index] < right.numbers[index] ? -1 : 1
    }
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre < right.pre ? -1 : 1
}

function runCommand(bin, args, options = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, {
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, out: '', err: String(error) })
      return
    }

    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, options.timeout || 30_000)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, out: out.trim(), err: String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() })
    })
  })
}

function resolveNpmBinary(dshBin) {
  const candidates = []
  if (dshBin) candidates.push(path.join(path.dirname(dshBin), 'npm'))
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'npm'))
  }
  for (const candidate of candidates) if (isExecutable(candidate)) return candidate
  return 'npm'
}

async function installedVersion(dshBin) {
  const result = await runCommand(dshBin, ['--version'], {
    env: childEnvironment(dshBin),
    timeout: 20_000,
  })
  const last = result.out.split('\n').filter(Boolean).pop() || ''
  return last.trim() || null
}

async function checkForUpdates({ manual = false } = {}) {
  if (updateCheckRunning || updateInstalling) return

  const dshBin = resolveDshBinary()
  if (!dshBin) {
    if (manual) {
      dialog.showMessageBox({
        type: 'error',
        title: APP_NAME,
        message: 'No encuentro el ejecutable `dsh`.',
        detail: 'Instálalo con: npm i -g @deepseek-ai/dsh',
        buttons: ['Cerrar'],
      })
    }
    return
  }

  updateCheckRunning = true
  trace('buscando actualizaciones')

  try {
    const installed = await installedVersion(dshBin)
    const npmBin = resolveNpmBinary(dshBin)
    const result = await runCommand(npmBin, ['view', '@deepseek-ai/dsh', 'version'], {
      env: childEnvironment(dshBin),
      timeout: 30_000,
    })
    const latest = result.ok ? result.out.split('\n').filter(Boolean).pop()?.trim() : null

    savePreferences({ lastUpdateCheckAt: Date.now() })

    if (!latest) {
      trace(`no se pudo consultar npm: ${result.err.slice(0, 200)}`)
      if (manual) {
        dialog.showMessageBox(mainWindow ?? undefined, {
          type: 'error',
          title: 'Buscar actualizaciones',
          message: 'No se pudo consultar el registro de npm.',
          detail: (result.err || 'Sin respuesta del registro.').slice(0, 1200),
          buttons: ['Cerrar'],
        })
      }
      return
    }

    const newer = compareVersions(latest, installed || '0.0.0') > 0
    trace(`versiones: instalada=${installed} disponible=${latest} nueva=${newer}`)

    if (manual) {
      const buttons = newer ? ['Actualizar ahora', 'Ver novedades', 'Más tarde'] : ['Cerrar']
      const { response } = await dialog.showMessageBox(mainWindow ?? undefined, {
        type: 'info',
        title: 'Actualizaciones de DeepSeek Harness',
        message: newer ? `Nueva versión disponible: ${latest}` : 'DeepSeek Harness está al día',
        detail: [
          `Instalada: ${installed || 'desconocida'}`,
          `Disponible en npm: ${latest}`,
          '',
          'Actualizar reinstala @deepseek-ai/dsh y reinicia el servidor local.',
        ].join('\n'),
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true,
      })
      if (newer && response === 0) await installUpdate(latest, dshBin)
      if (newer && response === 1) shell.openExternal(RELEASES_URL)
      return
    }

    if (newer && preferences.lastNotifiedVersion !== latest) {
      savePreferences({ lastNotifiedVersion: latest })
      notify(
        'Actualización disponible',
        `DeepSeek Harness ${latest} ya está en npm (tienes ${installed}). Menú Ayuda → Buscar actualizaciones.`,
      )
    }
  } finally {
    updateCheckRunning = false
  }
}

async function installUpdate(latest, dshBin) {
  if (updateInstalling) return
  updateInstalling = true
  const npmBin = resolveNpmBinary(dshBin)
  trace(`actualizando a ${latest} con ${npmBin}`)
  notify('Actualizando DeepSeek Harness', `Instalando ${latest}… puede tardar un minuto.`)

  try {
    const result = await runCommand(
      npmBin,
      ['install', '-g', '@deepseek-ai/dsh@latest'],
      { env: childEnvironment(dshBin), timeout: 15 * 60 * 1000 },
    )
    appendLog(`[desktop] npm install -g @deepseek-ai/dsh@latest (código ${result.code ?? '?'})\n${result.out}\n${result.err}\n`)

    if (!result.ok) {
      showWindow()
      dialog.showMessageBox(mainWindow ?? undefined, {
        type: 'error',
        title: 'La actualización falló',
        message: 'No se pudo actualizar @deepseek-ai/dsh.',
        detail: (result.err || result.out || 'Sin detalle.').slice(-1500),
        buttons: ['Cerrar'],
      })
      return
    }

    savePreferences({ lastUpdateCheckAt: Date.now() })
    notify('DeepSeek Harness actualizado', `${latest} instalado. Reiniciando el servidor local…`)
    await restartServer()
  } finally {
    updateInstalling = false
  }
}

function maybeAutoCheckUpdates() {
  if (!preferences.autoCheckUpdates) return
  const last = preferences.lastUpdateCheckAt || 0
  if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return
  setTimeout(() => {
    checkForUpdates({ manual: false })
  }, 10_000)
}

function buildMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `Acerca de ${APP_NAME}` },
        { type: 'separator' },
        { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Deshacer' },
        { role: 'redo', label: 'Rehacer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { role: 'selectAll', label: 'Seleccionar todo' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload', label: 'Recargar' },
        { role: 'forceReload', label: 'Forzar recarga' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { role: 'zoomIn', label: 'Acercar' },
        { role: 'zoomOut', label: 'Alejar' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
      ],
    },
    {
      label: 'Ventana',
      submenu: [{ role: 'minimize', label: 'Minimizar' }, { role: 'close', label: 'Cerrar' }],
    },
    {
      label: 'Ayuda',
      submenu: [
        {
          label: 'Buscar actualizaciones…',
          click: () => checkForUpdates({ manual: true }),
        },
        {
          label: 'Comprobar al iniciar',
          type: 'checkbox',
          checked: preferences.autoCheckUpdates,
          click: (item) => savePreferences({ autoCheckUpdates: item.checked }),
        },
        { type: 'separator' },
        {
          label: 'Abrir carpeta de registros',
          click: () => shell.openPath(LOG_DIR),
        },
        {
          label: 'Volver a iniciar el servidor',
          click: () => restartServer(),
        },
        {
          label: 'Acerca de',
          click: () => {
            dialog.showMessageBox(mainWindow ?? undefined, {
              type: 'info',
              title: `Acerca de ${APP_NAME}`,
              message: APP_NAME,
              detail: [
                `Aplicación de escritorio ${app.getVersion()}`,
                `Electron ${process.versions.electron}`,
                `Chromium ${process.versions.chrome}`,
                `Servidor: ${lastStatus.url || 'no iniciado'}`,
              ].join('\n'),
              buttons: ['Cerrar'],
            })
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  const state = loadWindowState()

  const options = {
    width: state.width || 1440,
    height: state.height || 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#07090F',
    title: APP_NAME,
    icon: path.join(APP_DIR, 'assets', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  }

  if (boundsAreVisible(state)) {
    options.x = state.x
    options.y = state.y
  }

  mainWindow = new BrowserWindow(options)
  mainWindow.setMenuBarVisibility(false)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (state.maximized) mainWindow.maximize()
  })

  mainWindow.on('close', (event) => {
    saveWindowState()
    if (forceQuit || !preferences.closeToTray) return
    event.preventDefault()
    mainWindow.hide()
    notifyHidden()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const web = mainWindow.webContents

  web.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) return { action: 'allow' }
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  web.on('console-message', (...args) => {
    const detail = args[1] && typeof args[1] === 'object' ? args[1] : { level: args[1], message: args[2] }
    if (detail && (detail.level === 'error' || detail.level === 3)) {
      trace(`renderer: ${detail.message || detail}`)
    }
  })

  web.on('did-fail-load', (_event, code, description, url) => {
    trace(`fallo de carga ${code} ${description} ${url}`)
  })

  web.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url)
  })

  mainWindow.loadFile(path.join(APP_DIR, 'splash.html'))

  if (serverUrl) {
    mainWindow.loadURL(serverUrl)
  } else if (!starting && lastStatus.phase !== 'error') {
    startServer()
  } else if (lastStatus.phase === 'error') {
    showError()
  }
}

// --------------------------------------------------------------------- app

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
    // Deja el archivo de preferencias a la vista desde el primer arranque.
    if (!fs.existsSync(PREFERENCES_FILE)) savePreferences({})
    buildMenu()
    createTray()
    createWindow()
    maybeAutoCheckUpdates()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (!tray || !preferences.closeToTray) app.quit()
  })

  app.on('before-quit', (event) => {
    forceQuit = true
    if (shuttingDown) return
    if (!serverProcess) return
    event.preventDefault()
    shuttingDown = true
    stopServer().finally(() => app.quit())
  })

  process.on('exit', () => {
    if (!serverProcess || serverProcess.exitCode !== null) return
    try {
      process.kill(-serverProcess.pid, 'SIGTERM')
    } catch {}
  })
}

ipcMain.handle('dsh:status', () => lastStatus)
ipcMain.on('dsh:retry', () => restartServer())
ipcMain.on('dsh:open-logs', () => shell.openPath(LOG_DIR))
ipcMain.on('dsh:quit', () => app.quit())
