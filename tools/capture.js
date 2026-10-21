// Herramienta de desarrollo: captura una página local a PNG y sale.
// Uso: CAPTURE_PAGE=splash.html CAPTURE_OUT=/ruta/salida.png electron --no-sandbox tools/capture.js
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const page = process.env.CAPTURE_PAGE || 'splash.html'
const out = process.env.CAPTURE_OUT || path.join(os.homedir(), '.cache', 'capture.png')

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1200,
      height: 760,
      show: true,
      backgroundColor: '#07090f',
      webPreferences: { sandbox: true },
    })
    await win.loadFile(path.join(__dirname, '..', page))
    await new Promise((resolve) => setTimeout(resolve, 1800))
    const image = await win.webContents.capturePage()
    fs.writeFileSync(out, image.toPNG())
    fs.appendFileSync(path.join(os.homedir(), '.cache', 'capture-debug.log'), `${out} ${image.getSize().width}x${image.getSize().height} exists=${fs.existsSync(out)}\n`)
  } catch (error) {
    fs.appendFileSync(path.join(os.homedir(), '.cache', 'capture-debug.log'), `error ${String(error)}\n`)
  }
  app.quit()
})
