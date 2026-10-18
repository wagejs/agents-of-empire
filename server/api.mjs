import fsp from 'node:fs/promises'
import { readLimits } from './limits.mjs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { schemeHasHandler, schemeOf } from './lib/xdg.mjs'
import { openInTerminal } from './lib/terminal.mjs'
import { previewLink, withPrStatus } from './link.mjs'
import { grepFiles, listFiles, openInEditor, readFile, readImage } from './files.mjs'
import { freshLoop, loopStatus, writeLoops } from './loops.mjs'
import { readMarkdown } from './mdfile.mjs'
import { focusWindowOfPid } from './lib/windows.mjs'
import { shareRoles, shareRoute } from './conductor.mjs'
import { activeRun, answerPermission, attachRun, chatStatus, getRun, listCommands, modeOf, modelOf, setRunModel, queueMessage, renameThread, setRunMode, startChat, startRun, stopRun } from './chat.mjs'
import {
  chatTarget,
  defaultHarness,
  harnessStatus,
  newSession as harnessNewSession,
  openThread as harnessOpenThread,
  readMessages,
  readPrs,
  scanThreads,
} from './scan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.AGENTS_OF_EMPIRE_DATA || path.join(here, '..', 'data')
const STATE_FILE = path.join(DATA_DIR, 'colony.json')
/** The skills in the Fresh loop row, chosen on the page. */
const LOOPS_FILE = path.join(DATA_DIR, 'loops.json')

/**
 * The page's own browser storage (chat modes and sizes, the open chat, the last plan), mirrored
 * here so the desktop app starts where the browser tab left off. The keys are the page's only.
 */
export const STORAGE_FILE = path.join(DATA_DIR, 'storage.json')
const OWN_KEY = /^agents-of-empire\./

export function cleanStorage(body) {
  const pick = (o) =>
    Object.fromEntries(
      Object.entries(asObject(o)).filter(([k, v]) => OWN_KEY.test(k) && typeof v === 'string' && v.length < 256 * 1024)
    )
  return { local: pick(body?.local), session: pick(body?.session) }
}

const STATE_VERSION = 2

/**
 * v1 keyed everything on a bare session id, because Claude Code was the only harness and its
 * ids are UUIDs. Adapters now prefix (`claude-code:…`, `codex:…`) so two harnesses can never
 * name the same thread, which means a v1 file's archive list no longer matches anything.
 *
 * Only Claude Code ever wrote a bare id, so the rewrite is unambiguous. One shot, on read.
 */
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const migrateId = (id) => (BARE_UUID.test(id) ? `claude-code:${id}` : id)

function migrate(raw) {
  if (Number(raw.version) >= 2) return raw
  const keys = (o) => Object.fromEntries(Object.entries(asObject(o)).map(([k, v]) => [migrateId(k), v]))
  return {
    ...raw,
    archived: asArray(raw.archived).map(migrateId),
    archivedAt: keys(raw.archivedAt),
    opened: asArray(raw.opened).map(migrateId),
    seen: keys(raw.seen),
    viewedAt: keys(raw.viewedAt),
  }
}

/**
 * Colony state is only ever the things the *game* invents — which plot a project got,
 * what a thread's building looks like, what you archived, which repos you took off the map.
 * The threads themselves stay
 * read-only: this file is the only thing Agents of Empire writes, anywhere.
 */
const emptyState = () => ({
  version: STATE_VERSION,
  archived: [],
  archivedAt: {},
  opened: [],
  plots: {},
  seen: {},
  hiddenProjects: [],
  viewedAt: {},
  titles: {},
  hexes: {},
  placements: {},
  settings: null,
  updatedAt: 0,
})

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const asArray = (v) => (Array.isArray(v) ? v : [])
/** Names you gave threads here. Only strings with something in them: the page shows each one. */
const asTitles = (v) =>
  Object.fromEntries(Object.entries(asObject(v)).filter(([, t]) => typeof t === 'string' && t.trim()))

/** The villages a hex can live in. Misc has no hexes: its plots are the repos themselves. */
const HEX_VILLAGES = new Set(['sprint', 'side'])
const HEX_NAME_MAX = 80
const isCell = (c) => Array.isArray(c) && c.length === 2 && c.every(Number.isInteger)
/**
 * Hexes you made in the Sprint and Side-project villages. A hex needs a village and a name to
 * be drawn at all, so anything without both is dropped rather than drawn wrong. `cells` is
 * where an archived hex stood, kept here rather than in `plots` so archived hexes never crowd
 * the layout memory.
 */
function asHexes(v) {
  const out = {}
  for (const [id, hex] of Object.entries(asObject(v))) {
    if (!hex || typeof hex !== 'object' || !HEX_VILLAGES.has(hex.village)) continue
    const name = typeof hex.name === 'string' ? hex.name.trim().slice(0, HEX_NAME_MAX) : ''
    if (!name) continue
    const clean = { village: hex.village, name, archived: hex.archived === true, createdAt: Number(hex.createdAt) || 0 }
    if (Array.isArray(hex.cells) && hex.cells.length && hex.cells.every(isCell)) clean.cells = hex.cells
    out[id] = clean
  }
  return out
}
/** Which hex each thread was placed in: thread id → hex id. Anything else is dropped. */
const asPlacements = (v) =>
  Object.fromEntries(Object.entries(asObject(v)).filter(([, hex]) => typeof hex === 'string' && hex))

async function readState() {
  try {
    const raw = migrate(JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')))
    return {
      version: STATE_VERSION,
      archived: asArray(raw.archived),
      archivedAt: asObject(raw.archivedAt),
      opened: asArray(raw.opened),
      plots: asObject(raw.plots),
      seen: asObject(raw.seen),
      hiddenProjects: asArray(raw.hiddenProjects).map(String).filter(Boolean),
      viewedAt: asObject(raw.viewedAt),
      titles: asTitles(raw.titles),
      hexes: asHexes(raw.hexes),
      placements: asPlacements(raw.placements),
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
      updatedAt: Number(raw.updatedAt) || 0,
    }
  } catch {
    return emptyState()
  }
}

/**
 * One writer: the browser owns this file and PUTs it whole. Nothing on the server writes it —
 * if anything did, the next save from a page holding older state would silently drop every
 * archive made since that page loaded.
 */
/**
 * Writes are serialised through one chain, and each gets its own temp file.
 *
 * Both halves matter and neither is theoretical. A shared `colony.json.tmp` means two saves
 * landing together race on the rename and one throws ENOENT — a 500 the page has no idea what
 * to do with, so the save is simply lost. And read-then-write is not atomic across an `await`,
 * so without the chain two callers can both pass the version check below before either writes.
 */
let writeQueue = Promise.resolve()
let tmpSeq = 0
const serialise = (fn) => (writeQueue = writeQueue.then(fn, fn))

async function writeState(next) {
  const state = {
    version: STATE_VERSION,
    archived: asArray(next.archived),
    archivedAt: asObject(next.archivedAt),
    opened: asArray(next.opened),
    plots: asObject(next.plots),
    seen: asObject(next.seen),
    hiddenProjects: asArray(next.hiddenProjects).map(String).filter(Boolean),
    viewedAt: asObject(next.viewedAt),
    titles: asTitles(next.titles),
    hexes: asHexes(next.hexes),
    placements: asPlacements(next.placements),
    settings: next.settings && typeof next.settings === 'object' ? next.settings : null,
    updatedAt: Date.now(),
  }
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${STATE_FILE}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
    await fsp.rename(tmp, STATE_FILE)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return state
}

/**
/**
 * Hand a `harness://…` deep link, or a folder, to whatever opens things on this OS. The
 * opener gets an argument list, never a shell string.
 *
 * Only `present()` calls this, and no harness knowledge ever reaches it: an adapter says what it
 * wants opened and this decides how, which is the seam that keeps `server/harnesses/` swappable.
 *
 * macOS's `open(1)` does both jobs, and `xdg-open` is the Linux equivalent. On Windows the
 * equivalent is ShellExecute, reached through `rundll32 url.dll,FileProtocolHandler`: a
 * registered protocol URL goes to its app and a folder opens in Explorer, with the argument
 * passed through untouched. Two more obvious routes were tried and rejected — `explorer.exe
 * <url>` silently drops any URL that carries a query string, so `code/new?folder=…` never
 * arrived, and `cmd /c start` parses its own argument line, where the `%3A%5C` escapes in that
 * same link are exactly what it expands.
 *
 * The spawn is guarded because the opener may simply not be installed — a headless Linux box
 * has no `xdg-open` — and an unhandled `error` event on a child process takes the whole server
 * down. Failing quietly is right here: there is nothing the page could do with the error, and
 * the scan path must never depend on whether presentation worked.
 */
const OPENERS = {
  darwin: ['open'],
  win32: ['rundll32', 'url.dll,FileProtocolHandler'],
  linux: ['xdg-open'],
}

function launch(target) {
  const opener = OPENERS[process.platform]
  if (!opener) return
  const [cmd, ...args] = opener
  const child = spawn(cmd, [...args, target], { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

/**
 * A folder is openable only if it is still on this machine and still a directory. Paths
 * arrive from the page, which got them from a scan that may be minutes old — a repo that
 * has since been moved or deleted must fail here rather than hand the opener a dead path.
 * Absolute is judged by `path.isAbsolute` rather than a leading `/`, which no Windows path has.
 * `~` is the home folder: a chat started with no repo picked starts there.
 */
async function resolveFolder(folder) {
  if (folder === '~' || folder?.startsWith?.('~/')) folder = path.join(os.homedir(), folder.slice(1))
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null
  const dir = path.resolve(folder)
  const stat = await fsp.stat(dir).catch(() => null)
  return stat && stat.isDirectory() ? dir : null
}

/**
 * `command.cwd` came from the page — inside `ref`, or as the folder itself — so it gets the same
 * check as any other folder the page names. There is no fallback directory on purpose:
 * `claude --resume` looks a session up under the folder it ran in, and a terminal that opens on
 * "No conversation found" and closes is worse than an error toast.
 */
async function runInTerminal(command) {
  if (!command.cwd) return { ok: false, error: 'That thread has no folder on record to resume in' }
  const cwd = await resolveFolder(command.cwd)
  if (!cwd) return { ok: false, error: 'The folder that thread ran in is not on this machine any more' }
  // A folder that exists but cannot be entered fails inside every terminal alike, and the
  // terminal gets the blame; say what is actually wrong instead.
  const enterable = await fsp.access(cwd, fsp.constants.X_OK).then(() => true, () => false)
  if (!enterable) return { ok: false, error: 'The folder that thread ran in cannot be entered' }
  const opened = await openInTerminal(command.argv, cwd)
  return opened.ok ? { ok: true, via: 'terminal' } : opened
}

/**
 * Show a harness's answer to "open this" — `{ ok, url, command }` — the way the page asked for
 * it, and say truthfully whether anything happened.
 *
 * A page asking for a terminal never gets the desktop app instead, even when the CLI is missing:
 * an app window appearing after choosing a terminal reads as the setting being ignored, where an
 * error toast reads as something to fix.
 *
 * Otherwise macOS and Windows hand the URL to the opener: a scheme the harness's app registers is
 * always answered there, so nothing is probed. Linux is the platform where the URL may have
 * nowhere to go — the desktop app is optional and often absent, and `xdg-open` on a scheme nobody
 * claims exits quietly, which used to reach the page as "Opened". So there the scheme is checked
 * first; failing that, the harness's own CLI runs in a terminal, from the `command` the adapter
 * offered alongside the URL; failing that, the page is told so.
 */
export async function present(result, via = 'app') {
  // Only the reason reaches the page: a failure may still carry the adapter's command.
  if (!result || !result.ok) return { ok: false, error: result?.error || 'Nothing to open' }

  if (via === 'terminal') {
    if (!result.command) {
      return {
        ok: false,
        error:
          'That harness’s CLI was not found on this machine — install it, or set “Open threads in” back to the desktop app',
      }
    }
    return runInTerminal(result.command)
  }

  // A `pid` names a live process whose thread already has a window on this machine — a session
  // running in a terminal right now. Fronting that window is tried before the URL, because the
  // URL for exactly these threads is `resume`, which imports the transcript into the desktop app
  // as a second, untitled session: "open" would quietly fork the thread. Only when no window can
  // be found — the terminal is on another desktop, the process is detached, the walk reached the
  // desktop app itself — does the URL run as before.
  if (result.pid && (await focusWindowOfPid(result.pid))) return { ok: true, focused: true }

  if (process.platform !== 'linux') {
    if (!result.url) return { ok: false, error: 'That harness has no deep link to open on this platform' }
    launch(result.url)
    // A note is the adapter saying it opened *something* — the repo rather than the thread.
    return { ok: true, url: result.url, note: result.note }
  }

  if (result.url && (await schemeHasHandler(result.url))) {
    launch(result.url)
    return { ok: true, url: result.url }
  }
  if (result.command) return runInTerminal(result.command)
  const scheme = schemeOf(result.url)
  return {
    ok: false,
    error: scheme
      ? `Nothing on this machine opens ${scheme}:// links, and there is no CLI command to run instead`
      : 'Nothing on this machine can open that',
  }
}

const viaOf = (body) => (body?.via === 'terminal' ? 'terminal' : 'app')

/**
 * Mark the threads the colony has retired.
 *
 * Nothing is written anywhere. Agents of Empire used to set `isArchived` on the desktop app's own
 * session record, and it did land on disk — but the app serves from the copy it loaded at
 * launch, so the thread stayed put in its own list until the next restart, and the app would
 * rewrite the record from memory whenever it touched the thread. Papering over that took a
 * re-assert on every poll, a `ps` sweep to guess whether the app had re-read the file, and a
 * *pending* state for the gap between the two — a lot of machinery for something that still
 * looked broken to anyone with the app open.
 *
 * So the colony keeps its own list and that is all it does. Archiving in the harness's own UI
 * still sends the astronaut home, because the scan reads that flag; archiving here is the
 * colony's own business. Nothing outside `data/colony.json` is ever written.
 */
async function reconcileArchived(threads) {
  const state = await readState()
  if (!state.archived.length) return threads
  const wanted = new Set(state.archived)

  /**
   * An archive is remembered by the thread id the page saw, but that id is only the *canonical*
   * one. A thread the desktop app knows and the CLI has not written a transcript for is keyed on
   * its desktop record; the moment a transcript appears it re-keys to that session's UUID, and a
   * list keyed on the old string stops matching. The thread quietly comes back, which reads as
   * the archive having failed.
   *
   * So the ids inside `ref` count too. They are opaque to everything else here — this only ever
   * asks whether a string it already holds appears among them.
   */
  const archived = (thread) => {
    if (wanted.has(thread.id)) return true
    const ref = thread.ref
    if (!ref || typeof ref !== 'object') return false
    for (const value of Object.values(ref)) {
      if (typeof value === 'string') {
        if (value && wanted.has(value)) return true
      } else if (Array.isArray(value)) {
        for (const v of value) if (typeof v === 'string' && v && wanted.has(v)) return true
      }
    }
    return false
  }

  return threads.map((t) => (archived(t) ? { ...t, archived: true } : t))
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// The machine's own LAN addresses count as local too, so the colony can be
// served to the home network with AGENTS_OF_EMPIRE_HOST set. Harmless when bound
// to loopback (those hosts can't reach the server anyway), and the Host +
// Origin pairing still stops DNS rebinding and CSRF exactly as before.
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a && a.family === 'IPv4' && !a.internal && a.address) LOCAL_HOSTS.add(a.address)
  }
}

/** Hostname out of a `Host:` or `Origin:` value, with the port and any brackets stripped. */
function hostnameOf(value) {
  if (!value) return ''
  const raw = String(value).includes('://') ? value : `http://${value}`
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/**
 * Only a page this server itself served may drive it. Two checks, against two different
 * attacks, both of which a localhost server with an `open`-the-desktop-app button is a
 * genuinely attractive target for:
 *
 *   - **Host** stops DNS rebinding. Binding to 127.0.0.1 is not on its own enough: an
 *     attacker who points `evil.com` at 127.0.0.1 reaches us *as a same-origin page*, and
 *     can then read every response. The rebound request still carries `Host: evil.com`.
 *   - **Origin** stops CSRF. A cross-site `fetch` with a `text/plain` body is not
 *     preflighted, so without this check any page you happened to be visiting could POST
 *     here — spawning sessions, opening Finder windows, or wiping the colony layout —
 *     even though it could never read the reply.
 *
 * A state-changing request with no `Origin` at all is refused: browsers always send one on
 * POST/PUT, so its absence means the caller is not the page. That does mean a bare `curl`
 * POST is rejected; pass `-H 'Origin: http://localhost:5274'` if you are scripting this.
 */
function isLocalRequest(req) {
  if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) return false

  // A page on another local port (any dev server you run, or a page opened beside the chat)
  // is another site. The browser says so in Sec-Fetch-Site, and its Origin carries the port.
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (origin && origin !== 'null') return sameHost(origin, req.headers.host)
  return req.method === 'GET' || req.method === 'HEAD'
}

/** Whether an `Origin:` is this very server: host and port, not just a local hostname. */
function sameHost(origin, host) {
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

/**
 * A body the page sends is JSON. Requiring the type means a cross-site form or a `no-cors`
 * fetch, which can only send `text/plain` and friends, never reaches a handler: a JSON body
 * from another origin needs a preflight, and nothing here answers one.
 */
const isJsonBody = (req) => /^application\/json\b/i.test(req.headers['content-type'] || '')

function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const CHAT_MAX = 20_000
const TITLE_MAX = 200

/**
 * The calls that act on a Claude Code session through the SDK: starting one, reading it,
 * sending to it, answering its approvals, renaming it. Chat can run tools on this machine, so it answers this machine
 * only, even when `AGENTS_OF_EMPIRE_HOST` has put the rest of the colony on the network. The Host
 * and Origin checks have already run by the time a request gets here.
 */
/**
 * The ⌘P browser: list, read and search the files of the repos under its folder, and hand one
 * to VS Code. Code and whatever sits in it is private, so this machine's browser only.
 */
async function files(url, req, res) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return send(res, 403, { error: 'The file browser only answers a browser on this machine' })
  // An <img> asks with GET, so an image is the one thing read that way.
  if (url.pathname === '/api/files/image' && req.method === 'GET') {
    // Not for another site's <img>: browsers say where a request comes from.
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'Not from another site' })
    const img = await readImage({ repo: url.searchParams.get('repo'), path: url.searchParams.get('path') })
    if (!img) return send(res, 404, { error: 'No such image' })
    res.writeHead(200, { 'content-type': img.type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' })
    return res.end(img.body)
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'Unknown endpoint' })
  const body = await readJsonBody(req)
  if (url.pathname === '/api/files/list') return send(res, 200, await listFiles())
  if (url.pathname === '/api/files/read') {
    const file = await readFile(body)
    return send(res, file.ok ? 200 : 404, file)
  }
  if (url.pathname === '/api/files/grep') return send(res, 200, await grepFiles(body))
  if (url.pathname === '/api/files/open') {
    const done = await openInEditor(body)
    return send(res, done.ok ? 200 : 404, done)
  }
  return send(res, 404, { error: 'Unknown endpoint' })
}

async function chat(pathname, req, res) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) {
    return send(res, 403, { error: 'Chat only answers a browser on this machine' })
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'Unknown endpoint' })
  const body = await readJsonBody(req)

  /**
   * A thread's conversation, and the reply still running in it, if any. That reply's turn is cut
   * from the transcript's copy, because the page replays it whole from the run instead: showing
   * both would print every finished block of it twice.
   */
  if (pathname === '/api/chat/messages') {
    const before = typeof body.before === 'string' ? body.before : ''
    const [log, target] = await Promise.all([readMessages(body.harness, body.ref, { before }), chatTarget(body.harness, body.ref)])
    if (!log.ok) return send(res, 400, log)
    const run = activeRun(target.sessionId)
    let messages = log.messages
    // An older page is history only; the running reply is cut from the newest page alone.
    if (run && !before) {
      const at = messages.findLastIndex((m) => m.role === 'user' && m.text === run.prompt)
      if (at !== -1) messages = messages.slice(0, at)
    }
    return send(res, 200, {
      messages,
      more: Boolean(log.more),
      // While a reply of ours runs, the live process the registry finds is that reply's own
      // Claude Code: neither a window somewhere else nor somebody else's turn.
      live: Boolean(target.live) && !run,
      busy: Boolean(target.busy) && !run,
      where: target.where || '',
      run: run ? { id: run.id, prompt: run.prompt, crons: run.crons || [] } : null,
    })
  }

  /** Watch a run from event `from` on. Leaving, by closing this request, leaves the run alone. */
  if (pathname === '/api/chat/attach') {
    const run = getRun(String(body.runId || ''))
    if (!run) return send(res, 404, { ok: false, error: 'That reply has finished' })
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' })
    const write = (event) => res.destroyed || res.write(`${JSON.stringify(event)}\n`)
    const leave = attachRun(run, Number(body.from) || 0, write, () => res.end())
    res.on('close', leave)
    return
  }

  /** The `/` commands for a thread, or for the folder a new one will start in. */
  if (pathname === '/api/chat/commands') {
    const cwd = body.folder
      ? await resolveFolder(body.folder)
      : await resolveFolder((await chatTarget(body.harness, body.ref)).cwd)
    if (!cwd) return send(res, 400, { ok: false, error: 'That folder is not on this machine any more' })
    return send(res, 200, { commands: await listCommands(cwd) })
  }

  /** Change a running reply's permission mode; the next send carries the mode itself. */
  if (pathname === '/api/chat/mode') {
    const ok = await setRunMode(String(body.runId || ''), body.mode)
    return send(res, ok ? 200 : 404, ok ? { ok } : { ok, error: 'That reply has already finished' })
  }

  if (pathname === '/api/chat/model') {
    const ok = await setRunModel(String(body.runId || ''), body.model)
    return send(res, ok ? 200 : 404, ok ? { ok } : { ok, error: 'That reply has already finished' })
  }

  /** What the chat's link panel should show for a link a reply gave: a PR, an issue, or a page. */
  if (pathname === '/api/chat/link') {
    return send(res, 200, await previewLink(String(body.url || '')))
  }

  /** The PRs a thread opened, as its transcript records them. */
  if (pathname === '/api/chat/prs') {
    const prs = await readPrs(body.harness, body.ref)
    if (prs.ok) prs.prs = await withPrStatus(prs.prs)
    return send(res, prs.ok ? 200 : 404, prs)
  }

  /** A markdown file a chat names, read to show beside the chat. */
  if (pathname === '/api/chat/file') {
    const file = await readMarkdown(body.path, typeof body.cwd === 'string' ? body.cwd : '')
    return send(res, file.ok ? 200 : 404, file)
  }

  /** Which installed skills sit in the Fresh loop row. Only installed skills are kept. */
  if (pathname === '/api/chat/loops') {
    writeLoops(LOOPS_FILE, body.skills)
    return send(res, 200, { ok: true, ...loopStatus(LOOPS_FILE) })
  }

  /** Stop the session running a loop skill and start that skill afresh. */
  if (pathname === '/api/chat/loop') {
    const skill = String(body.skill || '')
    if (!loopStatus(LOOPS_FILE).skills.includes(skill)) return send(res, 400, { ok: false, error: 'Not a loop skill' })
    try {
      const fresh = await freshLoop({ skill, oldSessionId: String(body.oldSessionId || '') })
      return send(res, 200, { ok: true, ...fresh })
    } catch (err) {
      return send(res, 500, { ok: false, error: String(err?.message || err) })
    }
  }

  if (pathname === '/api/chat/stop') {
    const ok = stopRun(String(body.runId || ''))
    return send(res, ok ? 200 : 404, ok ? { ok } : { ok, error: 'That reply has already finished' })
  }

  if (pathname === '/api/chat/permission') {
    const ok = answerPermission(String(body.id || ''), body.choice, body.answers)
    return send(res, ok ? 200 : 404, ok ? { ok } : { ok, error: 'That request was already answered' })
  }

  if (pathname === '/api/chat/rename') {
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return send(res, 400, { ok: false, error: 'A thread needs a name' })
    if (title.length > TITLE_MAX) return send(res, 400, { ok: false, error: 'That name is too long' })
    const target = await chatTarget(body.harness, body.ref)
    if (!target.ok) return send(res, 400, target)
    await renameThread(target, title)
    return send(res, 200, { ok: true })
  }

  if (pathname === '/api/chat/send' || pathname === '/api/chat/new') {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return send(res, 400, { ok: false, error: 'Nothing to send' })
    if (text.length > CHAT_MAX) return send(res, 400, { ok: false, error: 'That message is too long' })

    // A new thread needs only a folder that is still there; its first message starts it.
    if (pathname === '/api/chat/new') {
      const cwd = await resolveFolder(body.folder)
      if (!cwd) return send(res, 400, { ok: false, error: 'That folder is not on this machine any more' })
      return send(res, 200, { runId: (await startChat(cwd, text, modeOf(body.mode), modelOf(body.model))).id })
    }

    const target = await chatTarget(body.harness, body.ref)
    if (!target.ok) return send(res, 400, target)
    const cwd = await resolveFolder(target.cwd)
    if (!cwd) return send(res, 400, { ok: false, error: 'The folder that thread ran in is not on this machine any more' })
    // Sent while a reply of ours is running: it waits, and goes as the next turn.
    const running = activeRun(target.sessionId)
    if (running) {
      if (!queueMessage(running, text)) {
        return send(res, 409, { ok: false, error: 'This reply started before Agents of Empire could queue messages. Wait for it to finish, then send' })
      }
      return send(res, 200, { runId: running.id, queued: true })
    }
    if (target.busy) return send(res, 409, { ok: false, error: `That thread is mid-turn in ${target.where}. Wait for it to finish` })
    const threadId = typeof body.threadId === 'string' ? body.threadId : ''
    return send(res, 200, { runId: startRun({ ...target, cwd, threadId, mode: modeOf(body.mode), model: modelOf(body.model) }, text).id })
  }

  return send(res, 404, { error: 'Unknown endpoint' })
}

/** Connect-style middleware: handles /api/*, passes everything else through. */
export async function apiMiddleware(req, res, next) {
  const url = new URL(req.url, 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return next ? next() : send(res, 404, { error: 'Not found' })

  if (!isLocalRequest(req)) {
    return send(res, 403, { error: 'Agents of Empire only answers its own page on this machine' })
  }
  const changes = req.method !== 'GET' && req.method !== 'HEAD'
  if (changes && !isJsonBody(req)) return send(res, 415, { error: 'Send JSON' })
  // With AGENTS_OF_EMPIRE_HOST on the network, other devices may look but never act.
  if (changes && !LOOPBACK.has(req.socket.remoteAddress)) {
    return send(res, 403, { error: 'Only this machine can change things here' })
  }

  try {
    if (url.pathname === '/api/threads' && req.method === 'GET') {
      // A thread whose reply is running from the page says so, and whether it waits on you.
      // And one in a shared run says which part it plays: orchestrator, or a repo session of it.
      const roles = shareRoles()
      const threads = (await reconcileArchived(await scanThreads())).map((t) => {
        const chat = chatStatus(t.id)
        const share = roles.get(t.ref?.cliSessionId)
        return { ...t, ...(chat && { chat }), ...(share && { share }) }
      })
      // A harness that is present but cannot read its own store says so here, rather than
      // appearing healthy in the list while quietly contributing nothing.
      const warnings = (await harnessStatus()).filter((h) => h.detected && h.error).map((h) => h.error)
      // Your plan's usage limits, as the last Claude Code session reported them (see limits.mjs).
      return send(res, 200, { threads, scannedAt: Date.now(), warnings, limits: await readLimits() })
    }

    if (url.pathname === '/api/loops' && req.method === 'GET') {
      return send(res, 200, loopStatus(LOOPS_FILE))
    }

    if (url.pathname === '/api/harnesses' && req.method === 'GET') {
      return send(res, 200, { harnesses: await harnessStatus() })
    }

    if (url.pathname === '/api/storage' && req.method === 'GET') {
      // The page's own settings, chat modes included: this machine only, even with HOST set.
      if (!LOOPBACK.has(req.socket.remoteAddress)) return send(res, 403, { error: 'This machine only' })
      const raw = await fsp.readFile(STORAGE_FILE, 'utf8').catch(() => '{}')
      return send(res, 200, cleanStorage(JSON.parse(raw || '{}')))
    }

    if (url.pathname === '/api/storage' && req.method === 'POST') {
      const clean = cleanStorage(await readJsonBody(req))
      await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
      const tmp = `${STORAGE_FILE}.${process.pid}.${++tmpSeq}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 })
      await fsp.rename(tmp, STORAGE_FILE)
      return send(res, 200, { ok: true })
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, await readState())
    }

    /**
     * Optimistic concurrency, so a second tab cannot paste over the first one's work.
     *
     * `baseUpdatedAt` is the version the caller last agreed with. If the file no longer carries
     * it, the caller's whole-file body describes a colony that no longer exists — so the disk
     * state comes back with a 409 and the page merges against it. Merging here was the other
     * option and it is the wrong place: the server has no idea which of two `plots` layouts a
     * person actually dragged.
     *
     * The test is inequality rather than "older than", because a colony file also moves
     * *backwards* — restored from a backup, edited by hand — and a page open across that holds
     * a base newer than disk, which sails through a greater-than check and pastes the
     * pre-restore colony straight back.
     *
     * A missing or zero base is a first write and is allowed: nothing to lose on a fresh
     * install, and it keeps the endpoint drivable from `curl`.
     */
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const body = await readJsonBody(req)
      const base = Number(body.baseUpdatedAt) || 0
      return serialise(async () => {
        const current = await readState()
        if (base && current.updatedAt !== base) return send(res, 409, current)
        return send(res, 200, await writeState(body))
      })
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const shown = await present(await harnessOpenThread(body.harness, body.ref), viaOf(body))
      return send(res, shown.ok ? 200 : 400, shown)
    }

    if ((url.pathname === '/api/new-session' || url.pathname === '/api/reveal') && req.method === 'POST') {
      const body = await readJsonBody(req)
      const dir = await resolveFolder(body.folder)
      if (!dir) return send(res, 400, { ok: false, error: 'That folder is not on this machine any more' })

      if (url.pathname === '/api/reveal') {
        // On macOS an .app bundle is a folder too, and `open` would run it: -R only shows it in
        // Finder. Elsewhere a folder cannot run anything, so the opener just opens it.
        if (process.platform === 'darwin') spawn('open', ['-R', dir], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
        else launch(dir)
        return send(res, 200, { ok: true })
      }
      const harness = body.harness || (await defaultHarness())
      const shown = await present(await harnessNewSession(harness, dir), viaOf(body))
      return send(res, shown.ok ? 200 : 400, shown)
    }

    if (url.pathname.startsWith('/api/chat/')) return await chat(url.pathname, req, res)
    if (url.pathname.startsWith('/api/files/')) return await files(url, req, res)

    // Shared sessions start Claude Code sessions that edit code, so, like chat, this machine only.
    if (url.pathname.startsWith('/api/share/') && req.method === 'POST') {
      if (!LOOPBACK.has(req.socket.remoteAddress)) return send(res, 403, { error: 'Shared sessions only answer a browser on this machine' })
      try {
        const { status, json } = await shareRoute(url.pathname, await readJsonBody(req))
        return send(res, status, json)
      } catch (err) {
        return send(res, 400, { error: String(err?.message || err) })
      }
    }

    return send(res, 404, { error: 'Unknown endpoint' })
  } catch (err) {
    return send(res, 500, { error: String(err && err.message ? err.message : err) })
  }
}
