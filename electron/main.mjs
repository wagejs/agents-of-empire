/**
 * The desktop shell: the same server `npm run serve` runs, in-process on a fixed port, shown in
 * one window, with a real browser view beside the chat for the links Claude gives.
 *
 * The port is fixed on purpose. localStorage belongs to an origin, so a port that moved would
 * reset every setting on the next launch.
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell, WebContentsView } from 'electron'
import fs from 'node:fs'
import { cleanStorage, STORAGE_FILE } from '../server/api.mjs'
import { handle } from '../server/serve.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 5275
const ORIGIN = `http://127.0.0.1:${PORT}`
const isWeb = (url) => /^https?:\/\//i.test(String(url))
const cap = (s, n) => String(s ?? '').slice(0, n)

app.setName('agents-world')
if (!app.requestSingleInstanceLock()) app.quit()

let win = null
let view = null
let sendState = () => {}
let quitting = false

const show = () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// The page only ever asks for clipboard writes; nothing on the web gets the camera, location
// and the rest by default, which is what Electron would otherwise grant.
const allowOnly = (ses, allowed) => {
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.includes(perm)))
  ses.setPermissionCheckHandler((_wc, perm) => allowed.includes(perm))
}

/** The browser beside the chat: its own saved session, no preload, so a site can't reach the app. */
function linkView() {
  if (view) return view
  const ses = session.fromPartition('persist:links')
  // A plain Chrome user agent: some sign-in pages refuse anything that says Electron.
  ses.setUserAgent(app.userAgentFallback.replace(/\s(?:Electron|agents-world|bot-crossing)\/\S+/g, ''))
  allowOnly(ses, ['clipboard-sanitized-write', 'fullscreen'])
  view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true } })
  const wc = view.webContents
  sendState = () =>
    win?.webContents.send('browser-state', {
      url: wc.getURL(),
      title: wc.getTitle(),
      back: wc.navigationHistory.canGoBack(),
      forward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
    })
  for (const e of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(e, sendState)
  wc.on('will-navigate', (e, url) => isWeb(url) || e.preventDefault())
  // A link to a new tab stays in the panel; a real popup (an SSO window, say) gets its own window
  // in the same session, so window.opener keeps working.
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!isWeb(url)) return { action: 'deny' }
    if (disposition === 'new-window') return { action: 'allow' }
    wc.loadURL(url)
    return { action: 'deny' }
  })
  // Keys typed into the site never reach the page, so Escape is passed on by hand.
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') win?.webContents.send('browser-escape')
  })
  win.contentView.addChildView(view)
  view.setVisible(false)
  return view
}

function createWindow() {
  allowOnly(session.defaultSession, ['clipboard-sanitized-write', 'fullscreen'])
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'agents-world',
    backgroundColor: '#0b0f17',
    webPreferences: { preload: path.join(here, 'preload.cjs'), backgroundThrottling: false },
  })
  win.on('page-title-updated', (e) => e.preventDefault())
  win.loadURL(`${ORIGIN}/`)
  const page = win.webContents
  page.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  page.on('will-navigate', (e, url) => url.startsWith(`${ORIGIN}/`) || e.preventDefault())
  // A reload takes the panel away; the view laid over it goes too.
  page.on('did-start-loading', () => view?.setVisible(false))

  // Closing hides the window and keeps the colony running; Quit really quits.
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    process.platform === 'darwin' ? win.hide() : win.minimize()
  })
  // ponytail: with throttling off nothing pauses drawing, so the page is told when nobody can see it.
  for (const [event, visible] of [['hide', false], ['minimize', false], ['show', true], ['restore', true]]) {
    win.on(event, () => page.send('visible', visible))
  }
}

// Every message below comes from the colony page and nothing else.
const fromPage = (fn) => (e, ...args) => e.sender === win?.webContents && fn(...args)

ipcMain.on('waiting', fromPage((count, fresh) => {
  app.setBadgeCount(Math.max(0, Number(count) || 0))
  if (win.isFocused() || !Notification.isSupported() || !Array.isArray(fresh)) return
  for (const t of fresh.slice(0, 5)) {
    const n = new Notification({ title: cap(t?.title, 120) || 'A thread needs you', body: cap(t?.project, 120) })
    n.on('click', () => {
      show()
      win.webContents.send('select', cap(t?.id, 200))
    })
    n.show()
  }
}))

ipcMain.on('storage', (e) => {
  try {
    e.returnValue = e.sender === win?.webContents ? cleanStorage(JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'))) : null
  } catch {
    e.returnValue = null
  }
})

ipcMain.on('browser', fromPage((cmd, arg) => {
  const v = cmd === 'hide' && !view ? null : linkView()
  if (!v) return
  const wc = v.webContents
  if (cmd === 'open' && isWeb(arg)) {
    v.setVisible(true)
    if (wc.getURL() !== arg) wc.loadURL(arg)
    else sendState()
  } else if (cmd === 'bounds' && arg) {
    const r = Object.fromEntries(['x', 'y', 'width', 'height'].map((k) => [k, Math.max(0, Math.round(Number(arg[k]) || 0))]))
    v.setBounds(r)
  } else if (cmd === 'hide') v.setVisible(false)
  else if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  else if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  else if (cmd === 'reload') wc.reload()
}))

app.on('second-instance', show)
app.on('activate', show)
app.on('before-quit', () => (quitting = true))

app.whenReady().then(() => {
  const server = http.createServer(handle)
  server.on('error', (err) => {
    dialog.showErrorBox('agents-world', err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Quit what holds it, or start with PORT=<another port>.` : String(err.message))
    app.exit(1)
  })
  server.listen(PORT, '127.0.0.1', createWindow)
})
