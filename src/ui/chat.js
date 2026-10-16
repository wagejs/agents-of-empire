/**
 * The chat popup: a thread's recent conversation, a box to continue it, and Allow / Deny for
 * whatever tool Claude asks to use along the way. The other half is `server/chat.mjs`.
 *
 * It also starts threads: opened on a folder instead, its first message begins a new one there.
 *
 * A reply runs on the server, not in this popup, which only watches it. Opening another thread,
 * closing the popup or reloading the page stops the watching and nothing else: the reply goes on,
 * and opening its thread again picks it up with everything it said in the meantime. Only Stop
 * ends one early. Which chat was open is remembered for the tab, so a reload brings it back.
 */
import { chatAttach, chatCommands, chatFile, chatMessages, chatMode, chatModel, chatPermission, chatSend, chatStart, chatStop, shareReport } from '../game/api.js'
import { ICON, shortModel } from './hud.js'
import { renderMarkdown } from './markdown.js'
import { LinkPanel } from './link-panel.js'

const TEMPLATE = `
<div class="sheet panel">
  <div class="chat-head">
    <div class="info"><div class="repo-tag" hidden></div><div class="title"></div><div class="sub"></div><select class="select repo-pick" aria-label="Repo" hidden></select></div>
    <button class="btn ghost" data-report title="You talked to this repo session yourself: pass that conversation on to its orchestrator" hidden>Report to orchestrator</button>
    <button class="btn ghost" data-next title="Next thread that needs you (⌥N)" hidden></button>
    <button class="btn icon ghost" data-close title="Close (Esc)">${ICON.close}</button>
  </div>
  <div class="chat-note" hidden></div>
  <div class="chat-schedule" hidden></div>
  <div class="chat-log"></div>
  <form class="chat-form">
    <div class="slash-menu" role="listbox" hidden></div>
    <textarea rows="2" placeholder="Message this thread. Enter sends, Shift+Enter adds a line"></textarea>
    <select class="select model-pick" aria-label="Model" title="Which model replies">
      <option value="">Default</option>
      <option value="opus">Opus</option>
      <option value="sonnet">Sonnet</option>
      <option value="haiku">Haiku</option>
    </select>
    <select class="select mode-pick" aria-label="Permission mode" title="What Claude may do without asking you">
      <option value="default">Ask</option>
      <option value="plan">Plan</option>
      <option value="acceptEdits">Auto-edit</option>
      <option value="bypassPermissions">Allow all</option>
      <option value="dontAsk">Deny</option>
    </select>
    <button class="btn primary" type="submit">Send</button>
    <button class="btn" type="button" data-stop hidden>Stop</button>
  </form>
</div>`

const MESSAGE_PLACEHOLDER = 'Message this thread. Enter sends, Shift+Enter adds a line'

/** A watch that keeps losing its stream gives up after this many tries, about twenty seconds. */
const RECONNECTS = 20

const div = (className, text) => {
  const el = document.createElement('div')
  el.className = className
  if (text) el.textContent = text
  return el
}

/** A path to a markdown file, as Claude writes one: `docs/plan.md`, `~/notes.md`, `/abs/x.md`. */
const MD_PATH = /^[~./\w@-][^\s`'"<>]*\.(md|markdown)$/i

/**
 * Make every markdown path in `el` that Claude wrote as inline code open beside the chat. Code
 * blocks are left alone: a path in the middle of a script is not an invitation to read it.
 */
function markMdPaths(el) {
  for (const code of el.querySelectorAll('code')) {
    if (code.closest('pre')) continue
    const text = code.textContent.trim()
    if (!MD_PATH.test(text)) continue
    code.dataset.md = text
    code.classList.add('md-file')
    code.title = 'Open beside the chat'
  }
  return el
}

const markdown = (text) => {
  const el = div('md')
  el.append(renderMarkdown(text))
  return markMdPaths(el)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One tool call, on one line: `Bash · git status`. A command longer than the line is cut with
 * an ellipsis and opens out in full, wrapped, on a click; a second click folds it back. Only a
 * line that is actually cut offers to open, and selecting text inside it does not toggle it.
 */
function toolLine(name, summary) {
  const el = div('tool', `${name} · ${summary}`)
  // A markdown file Claude wrote, edited or read opens beside the chat instead.
  if (/^(Write|Edit|MultiEdit|Read)$/.test(name) && MD_PATH.test(String(summary).trim())) {
    el.dataset.md = String(summary).trim()
    el.classList.add('md-file')
    el.title = 'Open beside the chat'
    return el
  }
  el.title = 'Click to show the whole command'
  el.addEventListener('click', () => {
    if (getSelection()?.toString()) return
    if (!el.classList.contains('open') && el.scrollWidth <= el.clientWidth) return
    el.classList.toggle('open')
  })
  return el
}

const STORE_KEY = 'bot-crossing.chat'

/** Which thread's chat this tab had open. Storage can be missing or refuse; then nothing is kept. */
function remember(id) {
  try {
    if (id) sessionStorage.setItem(STORE_KEY, id)
    else sessionStorage.removeItem(STORE_KEY)
  } catch {
    /* a reload just comes back without the chat open */
  }
}

/** The thread whose chat was open before this page loaded, if any. */
export function lastChat() {
  try {
    return sessionStorage.getItem(STORE_KEY)
  } catch {
    return null
  }
}

const MODES_KEY = 'bot-crossing.chat-modes'

/**
 * Each thread's permission mode, kept in this browser like its size. What each one means:
 *   Ask        anything your settings don't already allow comes up as Allow / Deny
 *   Plan       Claude only reads and plans; it changes nothing
 *   Auto-edit  file edits go through without asking; everything else still asks
 *   Allow all  nothing asks at all
 *   Deny       anything that would ask is refused instead
 */
function loadModes(key = MODES_KEY) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {}
  } catch {
    return {}
  }
}

function saveModes(modes, key = MODES_KEY) {
  try {
    localStorage.setItem(key, JSON.stringify(modes))
  } catch {
    /* modes just last until the reload */
  }
}

/** Each thread's model pick, kept the same way; '' is whatever the thread runs by default. */
const MODELS_KEY = 'bot-crossing.chat-models'

const SIZES_KEY = 'bot-crossing.chat-sizes'

/**
 * How big you made each thread's chat, kept in this browser. Keyed by thread id, or by folder
 * for a new thread not yet started. A size is a preference, not colony state, so it stays out
 * of `data/colony.json`.
 */
function loadSizes() {
  try {
    return JSON.parse(localStorage.getItem(SIZES_KEY)) || {}
  } catch {
    return {}
  }
}

function saveSizes(sizes) {
  try {
    localStorage.setItem(SIZES_KEY, JSON.stringify(sizes))
  } catch {
    /* sizes just last until the reload */
  }
}

export class Chat {
  /**
   * `needYou` lists the chattable threads asking for you, most pressing first; `go` takes the
   * popup, and the map, to one of them.
   */
  constructor(parent, { onDone, needYou = () => [], go, repoOf = () => null } = {}) {
    this.repoOf = repoOf
    this.onDone = onDone
    this.needYou = needYou
    this.go = go
    this.thread = null
    /** Where a new thread will start, while the popup is waiting for its first message. */
    this.folder = null
    /** The run this popup is watching, and the way to stop watching it. */
    this.runId = null
    this.view = null
    /** Between sending and the server naming the run. */
    this.starting = false
    this.blocked = false
    /** The block streaming in right now: its element, and its markdown so far. */
    this.live = null

    this.el = div('chat')
    this.el.innerHTML = TEMPLATE
    parent.appendChild(this.el)
    this.$ = (sel) => this.el.querySelector(sel)
    this.log = this.$('.chat-log')
    // Scrolled up to the top of what is loaded: fetch the turns before it.
    this.log.addEventListener('scroll', () => {
      if (this.log.scrollTop < 80 && this.history?.more && !this.history.loading) this.loadEarlier()
    })
    // A markdown file Claude wrote or named opens beside the chat, rendered.
    this.log.addEventListener('click', (e) => {
      const file = e.target.closest?.('[data-md]')
      if (!file || getSelection()?.toString()) return
      e.preventDefault()
      this.openFile(file.dataset.md)
    })
    // A link Claude gives, a PR say, opens in a panel beside the chat rather than a tab.
    this.log.addEventListener('click', (e) => {
      const link = e.target.closest?.('a[href^="http"]')
      if (!link || e.metaKey || e.ctrlKey || e.shiftKey) return
      e.preventDefault()
      this.linkPanel.open(link.href)
    })
    this.input = this.$('textarea')

    // Each thread's chat remembers the size you dragged it to. Only the inline size counts:
    // dragging the corner sets it, whereas the window squeezing the popup does not, so a small
    // window never overwrites the size you chose.
    this.modes = loadModes()
    this.$('.mode-pick').addEventListener('change', (e) => this.pickMode(e.target.value))
    this.models = loadModes(MODELS_KEY)
    this.$('.model-pick').addEventListener('change', (e) => this.pickModel(e.target.value))

    this.sheet = this.$('.sheet')
    this.linkPanel = new LinkPanel(this.el)
    this.wireQuote()
    // The panel is the chat's size, whatever you have dragged the chat to.
    new ResizeObserver(() => {
      this.linkPanel.el.style.width = `${this.sheet.offsetWidth}px`
      this.linkPanel.el.style.height = `${this.sheet.offsetHeight}px`
    }).observe(this.sheet)
    this.sizes = loadSizes()
    this.sizeKey = ''
    new ResizeObserver(() => {
      const { width, height } = this.sheet.style
      if (!this.sizeKey || !width || !height) return
      const was = this.sizes[this.sizeKey]
      if (was?.width === width && was?.height === height) return
      this.sizes[this.sizeKey] = { width, height }
      saveSizes(this.sizes)
    }).observe(this.sheet)

    // Only a click that starts on the backdrop closes it. A text selection dragged past the
    // sheet's edge ends there too, and lands its click on the backdrop.
    let downOnBackdrop = false
    this.el.addEventListener('pointerdown', (e) => (downOnBackdrop = e.target === this.el))
    this.el.addEventListener('click', (e) => downOnBackdrop && e.target === this.el && this.close())
    this.$('[data-close]').addEventListener('click', () => this.close())
    this.$('[data-report]').addEventListener('click', () => this.reportToOrchestrator())
    this.$('[data-stop]').addEventListener('click', () => this.runId && chatStop(this.runId).catch(() => {}))
    this.$('form').addEventListener('submit', (e) => {
      e.preventDefault()
      this.send()
    })
    this.$('[data-next]').addEventListener('click', () => this.next())
    this.$('.repo-pick').addEventListener('change', (e) => this.pickRepo(e.target))
    // ⌥N from anywhere in the popup, the typing box included. `code`, because on a Mac the
    // Option key turns the N into a different character.
    this.el.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyN') {
        e.preventDefault()
        this.next()
      }
    })
    // The page's own key handler already ignores a textarea, so only these two need handling.
    this.input.addEventListener('keydown', (e) => {
      if (this.slashKey(e)) return
      // Escape closes the link panel first, then the chat.
      if (e.key === 'Escape') this.linkPanel.isOpen ? this.linkPanel.close() : this.close()
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        this.send()
      }
    })
    this.input.addEventListener('input', () => this.slashMenu())
    this.input.addEventListener('blur', () => setTimeout(() => this.hideSlash(), 150))
  }

  /**
   * The `/` menu: what Claude Code offers here, built-ins, skills, plugins and project commands,
   * filtered by what you have typed after the slash. Fetched once per thread, the first time
   * you type a slash; the server keeps the list for a while, so it is quick after that.
   */
  async slashMenu() {
    const value = this.input.value
    const match = /^\/(\S*)$/.exec(value)
    if (!match) return this.hideSlash()
    const key = this.sizeKey
    if (this.commandsFor !== key) {
      this.commandsFor = key
      this.commands = null
      this.renderSlash([], 'Loading commands…')
      try {
        const { commands } = await chatCommands({ thread: this.thread, folder: this.folder })
        if (this.commandsFor === key) this.commands = commands
      } catch (err) {
        if (this.commandsFor === key) this.commandsFor = null
        return this.renderSlash([], err.message)
      }
      if (this.input.value !== value) return this.slashMenu()
    }
    if (!this.commands) return
    const typed = match[1].toLowerCase()
    const found = this.commands
      .filter((c) => c.name.toLowerCase().includes(typed))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(typed)) - Number(!b.name.toLowerCase().startsWith(typed)))
      .slice(0, 50)
    this.renderSlash(found, found.length ? '' : 'No command matches')
  }

  renderSlash(found, message) {
    const menu = this.$('.slash-menu')
    this.slashFound = found
    this.slashAt = 0
    menu.replaceChildren(
      ...found.map((c, i) => {
        const row = div('slash-item')
        row.setAttribute('role', 'option')
        row.append(div('slash-name', `/${c.name}${c.hint ? ` ${c.hint}` : ''}`), div('slash-desc', c.description))
        row.addEventListener('mousedown', (e) => {
          e.preventDefault()
          this.pickSlash(i)
        })
        return row
      }),
      ...(message ? [div('slash-empty', message)] : [])
    )
    menu.hidden = false
    this.markSlash()
  }

  markSlash() {
    const rows = this.$('.slash-menu').querySelectorAll('.slash-item')
    rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === this.slashAt)))
    rows[this.slashAt]?.scrollIntoView({ block: 'nearest' })
  }

  hideSlash() {
    this.$('.slash-menu').hidden = true
    this.slashFound = []
  }

  pickSlash(i) {
    const c = this.slashFound?.[i]
    if (!c) return
    this.input.value = `/${c.name} `
    this.hideSlash()
    this.input.focus()
  }

  /** Keys the menu takes while it is open: arrows move, Tab or Enter picks, Escape closes it. */
  slashKey(e) {
    if (this.$('.slash-menu').hidden) return false
    const n = this.slashFound?.length || 0
    if (e.key === 'Escape') this.hideSlash()
    else if (e.key === 'ArrowDown' && n) this.slashAt = (this.slashAt + 1) % n
    else if (e.key === 'ArrowUp' && n) this.slashAt = (this.slashAt - 1 + n) % n
    else if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && n) this.pickSlash(this.slashAt)
    else return false
    e.preventDefault()
    this.markSlash()
    return true
  }

  get isOpen() {
    return this.el.classList.contains('open')
  }

  close() {
    this.linkPanel.close()
    this.el.classList.remove('open')
    remember(null)
  }

  /** The threads needing you other than this one. Opening one marks it seen, so it drops out. */
  others() {
    return this.needYou().filter((t) => t.id !== this.thread?.id)
  }

  /** Keep the header's count current: on every scan, and whenever the popup changes thread. */
  refreshNeedYou() {
    const n = this.others().length
    const button = this.$('[data-next]')
    button.hidden = !n
    button.textContent = `${n} need you ›`
  }

  next() {
    const [thread] = this.others()
    if (thread) this.go?.(thread)
  }

  /** This thread's permission mode: what it was last set to here, or Ask. */
  mode() {
    return this.modes[this.sizeKey] || 'default'
  }

  syncMode() {
    const pick = this.$('.mode-pick')
    pick.value = this.mode()
    pick.classList.toggle('risky', pick.value === 'bypassPermissions')
  }

  /** Remember the mode for this thread, and switch a reply that is running to it now. */
  async pickMode(mode) {
    if (!this.sizeKey) return
    this.modes[this.sizeKey] = mode
    saveModes(this.modes)
    this.syncMode()
    if (this.runId) {
      try {
        await chatMode(this.runId, mode)
      } catch (err) {
        this.note(err.message, true)
      }
    }
  }

  model() {
    return this.models[this.sizeKey] || ''
  }

  /** A thread that takes over from another keeps the permission mode it was started in. */
  carryMode(fromId, toId, mode) {
    if (!toId) return
    this.modes[toId] = mode || (fromId && this.modes[fromId]) || 'default'
    saveModes(this.modes)
  }

  /** Remember the model for this thread, and switch a reply that is running to it now. */
  async pickModel(model) {
    if (!this.sizeKey) return
    this.models[this.sizeKey] = model
    saveModes(this.models, MODELS_KEY)
    if (this.runId) {
      try {
        await chatModel(this.runId, model)
      } catch (err) {
        this.note(err.message, true)
      }
    }
  }

  /** Which repo this chat is in, as a coloured tag above its title. */
  showRepo(thread) {
    const tag = this.$('.repo-tag')
    const repo = thread && this.repoOf(thread)
    tag.hidden = !repo
    if (!repo) return
    tag.textContent = repo.name
    tag.style.setProperty('--repo', repo.color)
  }

  /** The header's second line: the harness, and the model replying, as far as it is known. */
  showModel(model) {
    this.$('.sub').textContent = [this.harness, model && shortModel(model)].filter(Boolean).join(' · ')
  }

  /**
   * What the session has scheduled, each with Run now: it sends the schedule's own prompt, the
   * very `/skill tick` a timer would, so a tick you ask for is the same as one that fires. A
   * plain "tick" typed into the chat is only a message, and Claude may read it as "carry on".
   */
  showSchedule(crons = []) {
    const bar = this.$('.chat-schedule')
    bar.hidden = !crons.length
    bar.replaceChildren(
      ...crons.map((c) => {
        const row = div('sched')
        const run = document.createElement('button')
        run.type = 'button'
        run.className = 'btn'
        run.textContent = 'Run now'
        run.title = `Send ${c.prompt} now; the schedule carries on as before`
        run.addEventListener('click', () => {
          this.input.value = c.prompt
          this.send()
        })
        row.append(div('sched-text', `⏰ ${c.schedule}  ${c.prompt}`), run)
        return row
      })
    )
  }

  /**
   * Quote: select text in a reply, or in whatever is open beside the chat (a plan, a markdown
   * file, a PR), and a Quote button appears by it. It puts the selection into the message box
   * as a markdown quote with the cursor under it, so a question can point at exactly that part.
   * Quote several bits and they stack up in the one message.
   */
  wireQuote() {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn quote-btn'
    button.textContent = '❝ Quote'
    button.hidden = true
    this.el.append(button)
    const quotable = (node) => {
      const el = node?.nodeType === 1 ? node : node?.parentElement
      return el?.closest?.('.chat-log, .link-body') || null
    }
    const place = () => {
      const sel = getSelection()
      const text = sel?.toString().trim()
      if (!text || !sel.rangeCount || !quotable(sel.anchorNode) || !quotable(sel.focusNode)) return (button.hidden = true)
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      const host = this.el.getBoundingClientRect()
      button.hidden = false
      button.style.left = `${Math.max(8, rect.right - host.left - button.offsetWidth)}px`
      button.style.top = `${Math.max(8, rect.top - host.top - button.offsetHeight - 6)}px`
      button.quote = text
    }
    this.el.addEventListener('mouseup', () => setTimeout(place, 0))
    this.el.addEventListener('keyup', (e) => e.shiftKey && place())
    document.addEventListener('selectionchange', () => {
      if (!getSelection()?.toString().trim()) button.hidden = true
    })
    // Pressed before the selection goes: keep it, so the click still has something to quote.
    button.addEventListener('mousedown', (e) => e.preventDefault())
    button.addEventListener('click', () => {
      if (button.quote) this.quote(button.quote)
      button.hidden = true
      getSelection()?.removeAllRanges()
    })
  }

  /** Add `text` to the message box as a markdown quote and leave the cursor ready under it. */
  quote(text) {
    const quoted = text
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((line) => (line.trim() ? `> ${line}` : '>'))
      .join('\n')
    const before = this.input.value.replace(/\s+$/, '')
    this.input.value = `${before ? `${before}\n\n` : ''}${quoted}\n\n`
    this.input.focus()
    this.input.setSelectionRange(this.input.value.length, this.input.value.length)
    this.input.dispatchEvent(new Event('input'))
  }

  /** Show a markdown file from this chat beside it: read fresh, so an edit since shows too. */
  async openFile(file) {
    const cwd = this.thread?.ref?.cwd || this.thread?.cwd || this.folder || ''
    try {
      const doc = await chatFile(file, cwd)
      // HTML comments are notes for whoever edits the file, not for reading it.
      const text = doc.text.replace(/<!--[\s\S]*?-->\s*/g, '')
      this.linkPanel.showDoc({ title: doc.path.split('/').pop(), sub: doc.path, markdown: text, key: `file:${doc.path}` })
    } catch (err) {
      this.note(err.message, true)
    }
  }

  /** A rename made while this thread's chat is up shows in its header at once. */
  retitle(id, title) {
    if (this.thread?.id === id) this.$('.title').textContent = title
  }

  /**
   * Point the popup at a thread, or at a folder for a new one. Whatever reply it was watching
   * carries on without it.
   */
  reset({ thread = null, folder = null, title, sub, placeholder }) {
    this.hideSlash?.()
    this.el.classList.add('open')
    this.view?.abort()
    this.view = null
    this.runId = null
    this.starting = false
    this.thread = thread
    this.folder = folder
    this.blocked = false
    this.$('.title').textContent = title
    this.showRepo(thread)
    this.harness = sub
    this.showModel(thread?.model)
    this.$('.sub').hidden = false
    this.$('.repo-pick').hidden = true
    // Only a repo session of a shared run has an orchestrator to tell.
    this.$('[data-report]').hidden = thread?.share?.role !== 'child'
    this.input.placeholder = placeholder
    this.log.replaceChildren()
    this.history = null
    this.showSchedule([])
    remember(thread?.id)
    this.refreshNeedYou()
    this.sizeKey = thread ? thread.id : `new:${folder}`
    this.syncMode()
    this.$('.model-pick').value = this.model()
    const size = this.sizes[this.sizeKey]
    this.sheet.style.width = size?.width || ''
    this.sheet.style.height = size?.height || ''
  }

  /**
   * A reply started somewhere else, watched here from its first event: the orchestrator of a
   * plan. Once its session names itself it is a thread like any other.
   */
  openRun({ runId, folder, title, sub = 'Orchestrator · Claude Code' }) {
    this.reset({ folder, title, sub, placeholder: MESSAGE_PLACEHOLDER })
    this.watch(runId, this.add('assistant'), null, title)
  }

  /**
   * An empty popup for a new Claude Code thread in `folder`. Its first message starts the
   * thread, and from then on it is a chat like any other.
   */
  openNew({ folder, name, repos = [] }) {
    if ((this.runId || this.starting) && !this.thread && this.folder === folder) {
      this.el.classList.add('open')
      return this.input.focus()
    }
    this.reset({
      folder,
      title: 'New conversation',
      sub: `${name} · Claude Code`,
      placeholder: 'What should this thread do? Enter starts it, Shift+Enter adds a line',
    })
    // Until its first message the thread can still go anywhere: every repo the colony knows,
    // or any folder at all.
    const pick = this.$('.repo-pick')
    const list = repos.some((r) => r.path === folder) ? repos : [{ name, path: folder }, ...repos]
    pick.replaceChildren(
      ...list.map((r) => new Option(r.name, r.path, false, r.path === folder)),
      new Option('Other folder…', '')
    )
    pick.title = folder
    pick.hidden = false
    this.$('.sub').hidden = true
    this.note('')
    this.sync()
    this.input.focus()
  }

  /** Where the new thread will start. "Other folder" asks for a path; the server checks it. */
  pickRepo(pick) {
    let path = pick.value
    if (!path) {
      path = (window.prompt('Start the thread in which folder? An absolute path.', this.folder || '') || '').trim()
      if (!path) {
        pick.value = this.folder
        return
      }
      if (![...pick.options].some((o) => o.value === path)) {
        pick.insertBefore(new Option(path.split('/').filter(Boolean).pop() || path, path), pick.lastElementChild)
      }
      pick.value = path
    }
    this.folder = path
    pick.title = path
    this.input.focus()
  }

  async open(thread) {
    this.el.classList.add('open')
    if (this.runId && this.thread?.id === thread.id) {
      remember(thread.id)
      return this.input.focus()
    }
    this.reset({
      thread,
      title: thread.title || 'Untitled thread',
      sub: thread.harnessName || '',
      placeholder: MESSAGE_PLACEHOLDER,
    })
    this.note('Loading…')
    this.sync()
    try {
      const { messages, live, busy, where, run, more } = await chatMessages(thread)
      if (this.thread !== thread) return
      for (const m of messages) this.log.append(this.historyEl(m))
      this.scroll()
      this.history = { thread, oldest: messages[0]?.id || '', more: Boolean(more && messages[0]?.id), loading: false }
      this.showEarlier()
      this.blocked = busy
      this.note(
        busy
          ? `Mid-turn in ${where}. Wait for it to finish, then reopen this.`
          : live
            ? `Also open in ${where}, which won't see these messages until you reopen the thread there.`
            : ''
      )
      // A reply still going from earlier, from before a reload or another thread's chat: pick
      // it up from its first word, since the history above stops short of it.
      if (run) {
        this.showSchedule(run.crons)
        this.add('user', run.prompt)
        this.watch(run.id, this.add('assistant'), thread, run.prompt)
      }
    } catch (err) {
      if (this.thread === thread) this.note(err.message || 'Could not read that thread', true)
    }
    this.sync()
    this.input.focus()
  }

  /** Send what you and this repo session said since its last report to its orchestrator. */
  async reportToOrchestrator() {
    const button = this.$('[data-report]')
    if (!this.thread || button.disabled) return
    button.disabled = true
    this.note('Telling the orchestrator…')
    try {
      const r = await shareReport(this.thread.ref)
      this.note(r.sent ? `Sent ${r.messages} message${r.messages === 1 ? '' : 's'} to the orchestrator. Its reply is in its own chat (Orchestrations tab).` : r.reason)
    } catch (err) {
      this.note(err.message, true)
    } finally {
      button.disabled = false
    }
  }

  note(text, isError = false) {
    const el = this.$('.chat-note')
    el.textContent = text
    el.hidden = !text
    el.classList.toggle('err', isError)
  }

  /** What you typed stays as typed; what Claude wrote is markdown. */
  /** One message from the transcript, not yet placed. */
  historyEl(m) {
    const el = div(`msg ${m.role}`)
    if (m.text) el.append(m.role === 'assistant' ? markdown(m.text) : div('text', m.text))
    for (const t of m.tools) el.append(toolLine(t.name, t.summary))
    return el
  }

  /** The "Load earlier" row at the top of the chat, there only while there is more to load. */
  showEarlier() {
    let row = this.log.querySelector(':scope > .load-earlier')
    const h = this.history
    if (!h?.more) return row?.remove()
    if (!row) {
      row = document.createElement('button')
      row.type = 'button'
      row.className = 'btn ghost load-earlier'
      row.addEventListener('click', () => this.loadEarlier())
      this.log.prepend(row)
    }
    row.disabled = h.loading
    row.textContent = h.loading ? 'Loading…' : 'Load earlier messages'
  }

  /**
   * The ten turns ahead of the oldest one shown, put in above it without moving what you are
   * reading: the view is shifted down by exactly what was added.
   */
  async loadEarlier() {
    const h = this.history
    if (!h?.more || h.loading || this.thread !== h.thread) return
    h.loading = true
    this.showEarlier()
    try {
      const { messages, more } = await chatMessages(h.thread, h.oldest)
      if (this.history !== h) return
      const anchor = this.log.querySelector(':scope > .load-earlier')?.nextSibling || this.log.firstChild
      const height = this.log.scrollHeight
      const top = this.log.scrollTop
      const block = document.createDocumentFragment()
      for (const m of messages) block.append(this.historyEl(m))
      this.log.insertBefore(block, anchor)
      this.log.scrollTop = top + (this.log.scrollHeight - height)
      h.oldest = messages[0]?.id || h.oldest
      h.more = Boolean(more && messages.length && messages[0]?.id)
    } catch (err) {
      this.note(err.message, true)
    } finally {
      h.loading = false
      this.showEarlier()
    }
  }

  add(role, text) {
    const el = div(`msg ${role}`)
    if (text) el.append(role === 'assistant' ? markdown(text) : div('text', text))
    this.log.append(el)
    this.scroll()
    return el
  }

  scroll() {
    this.log.scrollTop = this.log.scrollHeight
  }

  /** Follow the reply down only if you were already at the bottom, not while you scroll back. */
  atBottom() {
    const log = this.log
    return log.scrollHeight - log.scrollTop - log.clientHeight < 40
  }

  sync() {
    const running = Boolean(this.runId || this.starting)
    // Send stays while Claude works: what you send then waits its turn. Stop sits beside it.
    this.$('[data-stop]').hidden = !running
    this.input.disabled = this.blocked
    this.$('.repo-pick').disabled = running
  }

  async send() {
    const text = this.input.value.trim()
    const { thread, folder } = this
    if (!text || !(thread || folder) || this.starting || this.blocked) return
    // While a reply runs, the message joins its queue. The run records it, so it shows up here
    // (and for anyone reopening the thread) through the same events as everything else.
    if (this.runId) {
      // A brand new thread has nowhere to queue until its session has started and named it.
      if (!thread) return
      this.input.value = ''
      try {
        await chatSend(thread, text, this.mode(), this.model())
      } catch (err) {
        this.input.value = text
        this.note(err.message, true)
      }
      return
    }
    this.input.value = ''
    this.add('user', text)
    const reply = this.add('assistant')
    this.starting = true
    this.sync()
    try {
      const { runId } = await (thread ? chatSend(thread, text, this.mode(), this.model()) : chatStart(folder, text, this.mode(), this.model()))
      // Moved on while it was starting: it runs anyway, and is there when its thread is opened.
      if (this.thread !== thread || this.folder !== folder) return
      this.starting = false
      this.watch(runId, reply, thread, text)
    } catch (err) {
      if (this.thread === thread && this.folder === folder) {
        this.starting = false
        reply.append(div('err', err.message))
        this.sync()
      }
    }
  }

  /**
   * Watch a run until it finishes. A stream that drops without the run having finished is the
   * dev server restarting or a flaky moment, so it is picked up again from the last event seen.
   */
  async watch(runId, reply, thread, prompt) {
    this.view?.abort()
    const view = (this.view = new AbortController())
    this.runId = runId
    this.live = null
    this.sync()
    // A new thread becomes a real one the moment its session says what it is called; every
    // message after this goes to it, and its title is what you asked it, as the scan will say.
    let current = thread
    let seen = 0
    let finished = false
    let next = null
    const onEvent = (event) => {
      seen++
      if (event.type === 'done') finished = true
      if (event.type === 'next') next = event.runId
      if (event.type === 'queued') {
        // What you typed goes under everything so far, and what Claude does next goes under
        // that: without a fresh block the rest of the run kept filling the one above your
        // message, and the chat looked stuck on it.
        if (!reply.childElementCount) reply.remove()
        this.onEvent(event, reply)
        reply = this.add('assistant')
        return
      }
      if (event.type !== 'session') return this.onEvent(event, reply)
      current = { ...event.thread, title: prompt.split('\n')[0].slice(0, 120) }
      if (this.view !== view) return
      this.thread = current
      this.folder = null
      // Started: its folder is settled now.
      this.$('.repo-pick').hidden = true
      this.$('.sub').hidden = false
      this.$('.title').textContent = current.title
      this.showRepo(current)
      this.input.placeholder = MESSAGE_PLACEHOLDER
      remember(current.id)
      // The new thread keeps the size its empty popup had.
      if (this.sizes[this.sizeKey]) {
        this.sizes[current.id] = this.sizes[this.sizeKey]
        saveSizes(this.sizes)
      }
      // And the mode it was started in.
      this.modes[current.id] = this.$('.mode-pick').value
      saveModes(this.modes)
      this.models[current.id] = this.$('.model-pick').value
      saveModes(this.models, MODELS_KEY)
      this.sizeKey = current.id
    }
    for (let tries = 0; !finished && !view.signal.aborted && tries < RECONNECTS; tries++) {
      try {
        await chatAttach(runId, seen, onEvent, view.signal)
      } catch (err) {
        if (view.signal.aborted) break
        if (err.status === 404) {
          if (!seen) reply.append(div('err', 'That reply finished while this page was away. Reopen the thread to see it'))
          break
        }
      }
      if (!finished && !view.signal.aborted) await sleep(1000)
    }
    if (this.view !== view) return
    this.view = null
    this.runId = null
    // An approval nobody gave died with the run; its buttons would only answer into the void.
    for (const card of this.log.querySelectorAll('.perm:not(.answered)')) card.settle(null)
    if (!reply.childElementCount) reply.remove()
    // The queue went on as the next turn: watch that, under the messages that started it.
    if (next) {
      for (const el of this.log.querySelectorAll('.msg.user.queued')) el.classList.remove('queued')
      return this.watch(next, this.add('assistant'), current, prompt)
    }
    this.sync()
    this.scroll()
    this.onDone?.(current)
  }

  onEvent(event, reply) {
    const following = this.atBottom()
    if (event.type === 'delta') {
      if (event.fresh || !this.live) {
        this.live = { el: div('md'), text: '', queued: false }
        reply.append(this.live.el)
      }
      this.stream(this.live, event.text)
      return
    }
    if (event.type === 'model') return this.showModel(event.model)
    if (event.type === 'schedule') return this.showSchedule(event.crons)
    this.live = null
    if (event.type === 'queued') this.add('user', event.text).classList.add('queued')
    // Claude Code has it now: the oldest message still waiting is no longer waiting.
    else if (event.type === 'taken') this.log.querySelector('.msg.user.queued')?.classList.remove('queued')
    // A turn that ended has taken in everything typed before it, whatever said so or did not.
    else if (event.type === 'idle') for (const el of this.log.querySelectorAll('.msg.user.queued')) el.classList.remove('queued')
    else if (event.type === 'text') reply.append(markdown(event.text))
    else if (event.type === 'tool') reply.append(toolLine(event.name, event.summary))
    else if (event.type === 'note') reply.append(div('tool', event.text))
    else if (event.type === 'permission') reply.append(this.permission(event))
    else if (event.type === 'question') reply.append(this.question(event))
    else if (event.type === 'plan') reply.append(this.planCard(event))
    // Looked for across the whole chat: the card may sit in a block above a message you sent.
    else if (event.type === 'answered') [...this.log.querySelectorAll('.perm')].find((c) => c.dataset.id === event.id)?.settle(event.choice, event.answers ?? event.feedback)
    else if (event.type === 'done' && !event.ok) reply.append(div('err', event.error || 'Something went wrong'))
    if (following) this.scroll()
  }

  /**
   * A streaming paragraph is re-rendered whole, because one more token can close a `**` or a
   * fence that changes everything before it. Once a frame at most: tokens land faster than
   * the screen redraws.
   */
  stream(live, text) {
    live.text += text
    if (live.queued) return
    live.queued = true
    requestAnimationFrame(() => {
      live.queued = false
      const following = this.atBottom()
      live.el.replaceChildren(renderMarkdown(live.text))
      markMdPaths(live.el)
      if (following) this.scroll()
    })
  }

  /**
   * Claude asking you something: each question with its options, a free-text "Other", and one
   * button to send the lot. A multi-select question takes several options, sent comma-joined,
   * which is how Claude Code's own picker answers it. Skip tells Claude you passed.
   */
  question({ id, questions }) {
    const card = div('perm question')
    card.dataset.id = id
    const status = div('perm-q', questions.length > 1 ? 'Claude has questions' : 'Claude has a question')
    card.append(status)
    const picks = questions.map((q) => {
      const box = div('ask')
      box.append(div('ask-head', q.header || ''), div('ask-q', q.question))
      const chosen = new Set()
      const options = div('ask-options')
      for (const o of q.options || []) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'btn ask-option'
        b.append(div('ask-label', o.label))
        if (o.description) b.append(div('ask-desc', o.description))
        b.addEventListener('click', () => {
          if (!q.multiSelect) {
            chosen.clear()
            for (const other of options.children) other.setAttribute('aria-pressed', 'false')
          }
          const on = !chosen.has(o.label)
          on ? chosen.add(o.label) : chosen.delete(o.label)
          b.setAttribute('aria-pressed', String(on))
          other.value = ''
        })
        options.append(b)
      }
      const other = document.createElement('input')
      other.className = 'ask-other'
      other.placeholder = 'Other: type your own answer'
      other.addEventListener('input', () => {
        if (!other.value) return
        chosen.clear()
        for (const b of options.children) b.setAttribute('aria-pressed', 'false')
      })
      box.append(options, other)
      card.append(box)
      return { q, box, options, answer: () => other.value.trim() || [...chosen].join(', ') }
    })
    // One question at a time, however many came: Prev and Next between them, and the answers
    // all go together from the last one.
    let at = 0
    const nav = div('ask-nav')
    const prev = document.createElement('button')
    prev.type = 'button'
    prev.className = 'btn'
    prev.textContent = '‹ Prev'
    const count = div('ask-count')
    const next = document.createElement('button')
    next.type = 'button'
    next.className = 'btn'
    next.textContent = 'Next ›'
    nav.append(prev, count, next)
    const show = (i) => {
      at = Math.max(0, Math.min(picks.length - 1, i))
      picks.forEach((p, n) => (p.box.hidden = n !== at))
      count.textContent = `${at + 1} of ${picks.length}${picks.map((p) => p.answer()).filter(Boolean).length ? ` · ${picks.filter((p) => p.answer()).length} answered` : ''}`
      prev.disabled = at === 0
      next.hidden = at === picks.length - 1
      answer.hidden = at !== picks.length - 1
    }
    prev.addEventListener('click', () => show(at - 1))
    next.addEventListener('click', () => show(at + 1))
    // Picking the one answer a question takes moves on to the next.
    picks.forEach((p, n) => {
      p.options.addEventListener('click', (e) => {
        if (!e.target.closest('.ask-option')) return
        if (!p.q.multiSelect && n < picks.length - 1) setTimeout(() => show(n + 1), 180)
        else show(n)
      })
      p.box.querySelector('.ask-other').addEventListener('input', () => show(n))
    })
    const buttons = div('pair')
    const send = (answers) => async () => {
      for (const b of card.querySelectorAll('button, input')) b.disabled = true
      try {
        await chatPermission(id, answers ? 'answer' : 'deny', answers)
        card.settle(answers ? 'answer' : 'deny', answers)
      } catch (err) {
        status.textContent = err.message
      }
    }
    const answer = document.createElement('button')
    answer.type = 'button'
    answer.className = 'btn primary'
    answer.textContent = picks.length > 1 ? 'Submit all' : 'Answer'
    answer.addEventListener('click', () => {
      const answers = Object.fromEntries(picks.map((p) => [p.q.question, p.answer()]).filter(([, a]) => a))
      if (Object.keys(answers).length < picks.length) {
        status.textContent = 'Pick or type an answer for each question'
        show(picks.findIndex((p) => !p.answer()))
        return
      }
      send(answers)()
    })
    const skip = document.createElement('button')
    skip.type = 'button'
    skip.className = 'btn'
    skip.textContent = 'Skip'
    skip.addEventListener('click', send(null))
    buttons.append(answer, skip)
    if (picks.length > 1) card.append(nav)
    card.append(buttons)
    show(0)
    card.settle = (choice, answers) => {
      card.classList.add('answered')
      nav.hidden = true
      status.textContent =
        choice === 'answer' && answers
          ? Object.entries(answers).map(([q, a]) => `${q} → ${a}`).join('\n')
          : choice === 'deny' ? 'Skipped' : 'Not answered: the reply ended first'
    }
    return card
  }

  /**
   * Claude's plan, waiting for you. The plan itself opens beside the chat as a document, at once
   * and whenever this chat is opened while it still waits; the card and the panel both carry the
   * three answers Claude Code's own plan prompt has, and Keep planning takes what to change.
   */
  planCard({ id, plan }) {
    const threadId = this.thread?.id
    const card = div('perm plan')
    card.dataset.id = id
    const status = div('perm-q', 'Claude has a plan for you to approve')
    const view = document.createElement('button')
    view.type = 'button'
    view.className = 'btn'
    view.textContent = 'Read the plan'
    const title = (plan.match(/^#\s+(.+)$/m) || [])[1] || 'Plan'
    const answering = { done: false }
    const buttons = () => {
      const row = div('pair plan-actions')
      const feedback = document.createElement('textarea')
      feedback.className = 'ask-other'
      feedback.rows = 2
      feedback.placeholder = 'Keep planning: what should change? (optional)'
      const btn = (label, cls, choice) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = `btn ${cls}`
        b.textContent = label
        b.addEventListener('click', async () => {
          if (answering.done) return
          for (const x of row.querySelectorAll('button, textarea')) x.disabled = true
          try {
            await chatPermission(id, choice, choice === 'keep' ? feedback.value : undefined)
            card.settle(choice, feedback.value)
          } catch (err) {
            status.textContent = err.message
            for (const x of row.querySelectorAll('button, textarea')) x.disabled = false
          }
        })
        return b
      }
      row.append(
        btn('Approve, auto-accept edits', 'primary', 'acceptEdits'),
        btn('Approve, ask before edits', '', 'default'),
        btn('Keep planning', '', 'keep'),
        feedback
      )
      return row
    }
    const show = () => this.linkPanel.showDoc({ title, sub: answering.done ? answering.note : 'Waiting for your approval', markdown: plan, actions: answering.done ? null : buttons(), key: id })
    view.addEventListener('click', show)
    const own = buttons()
    card.append(status, view, own)
    card.settle = (choice, feedback) => {
      answering.done = true
      answering.note =
        choice === 'acceptEdits' ? 'Approved: edits go ahead without asking'
        : choice === 'default' ? 'Approved: edits ask first'
        : choice === 'keep' ? `Sent back${feedback ? `: ${feedback}` : ''}`
        : 'Not answered: the reply ended first'
      status.textContent = answering.note
      card.classList.add('answered')
      own.remove()
      this.linkPanel.noteDoc(id, answering.note)
    }
    // Open it now: live, or replayed while it still waits. A later `answered` in the same
    // replay settles it straight after, which leaves the panel showing it as decided.
    // Not a microtask: a replay's `answered` can arrive a moment later, and a plan decided long
    // ago should not pop open every time this chat does.
    setTimeout(() => !answering.done && this.thread?.id === threadId && show(), 400)
    return card
  }

  /**
   * Allow / Deny for one tool call, showing everything the tool was asked to do. "Always allow"
   * is offered only when Claude Code suggested a rule, and the card says which rule it saves.
   * `settle` closes the card: from a click here, from an answer recorded on the server (given
   * in another tab, or before a reload), or with `null` when the run ended first.
   */
  permission({ id, name, input, always, reason }) {
    const card = div('perm')
    card.dataset.id = id
    const question = div('perm-q', `Allow ${name}?`)
    // Why Claude Code asked, when it says: the clue when a mode should have let it through.
    if (reason) question.title = reason
    const detail = document.createElement('pre')
    detail.textContent = reason ? `Asked because: ${reason}\n\n${input}` : input
    const buttons = div('pair')
    const done = { allow: `Allowed ${name}`, always: `Always allowed ${always}`, deny: `Denied ${name}` }
    card.settle = (choice) => {
      question.textContent = done[choice] || 'Not run: the reply ended first'
      card.classList.add('answered')
    }
    const answer = async (choice) => {
      for (const b of buttons.children) b.disabled = true
      try {
        await chatPermission(id, choice)
        card.settle(choice)
      } catch (err) {
        question.textContent = err.message
      }
    }
    const choices = [['Allow', 'allow', 'btn primary']]
    if (always) choices.push(['Always allow', 'always', 'btn'])
    choices.push(['Deny', 'deny', 'btn'])
    for (const [label, choice, cls] of choices) {
      const b = document.createElement('button')
      b.className = cls
      b.type = 'button'
      b.textContent = label
      b.addEventListener('click', () => answer(choice))
      buttons.append(b)
    }
    card.append(question, detail, buttons)
    if (always) card.append(div('perm-rule', `Always allow saves ${always} to this project's .claude/settings.local.json`))
    return card
  }
}
