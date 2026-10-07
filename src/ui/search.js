/**
 * Every thread on this machine, findable: the ones on the map, the ones archived, and the ones
 * in repos hidden or folded away. From a result you can fly to its bot, chat with it, archive
 * it, or revive it.
 *
 * It searches what the scan already knows: title, first prompt, repo, path, branch, worktree,
 * harness, model and status. Every word typed has to match somewhere, in any order.
 * ponytail: no transcript full-text. That means reading every transcript on each keystroke,
 * a server-side index, which is worth building only if titles stop being enough.
 */
import { ICON } from './hud.js'
import { matches } from '../game/thread-search.js'

/** Enough rows to scroll through, few enough that typing never waits on the DOM. */
const LIMIT = 200

const FILTERS = [
  ['all', 'All'],
  ['active', 'On the map'],
  ['archived', 'Archived'],
]

const TEMPLATE = `
<div class="sheet panel">
  <div class="chat-head">
    <input class="search-box" type="search" placeholder="Search every thread: title, prompt, repo, branch…" aria-label="Search threads" />
    <button class="btn icon ghost" data-close title="Close (Esc)">${ICON.close}</button>
  </div>
  <div class="search-bar">
    <div class="search-filters"></div>
    <button class="btn" data-archive-idle type="button"></button>
  </div>
  <div class="search-results"></div>
</div>`

const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const el = (tag, className, text) => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text) e.textContent = text
  return e
}

export class Search {
  /**
   * `rows()` returns `{ thread, statusLabel, idle, archived, revivable, onMap }` for every thread.
   * `actions` carries `go`, `chat`, `archive(ids)` and `revive(ids)`.
   */
  constructor(parent, { rows, actions }) {
    this.rows = rows
    this.actions = actions
    this.filter = 'all'

    this.el = el('div', 'chat search')
    this.el.innerHTML = TEMPLATE
    parent.appendChild(this.el)
    this.$ = (sel) => this.el.querySelector(sel)
    this.box = this.$('.search-box')
    this.results = this.$('.search-results')

    for (const [key, label] of FILTERS) {
      const b = el('button', 'btn', label)
      b.type = 'button'
      b.dataset.filter = key
      b.addEventListener('click', () => {
        this.filter = key
        this.render()
      })
      this.$('.search-filters').append(b)
    }
    this.el.addEventListener('click', (e) => e.target === this.el && this.close())
    this.$('[data-close]').addEventListener('click', () => this.close())
    this.box.addEventListener('input', () => {
      // New words, new list: the highlight starts again at the top.
      this.selectedId = null
      this.render()
    })
    this.box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close()
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        this.move(e.key === 'ArrowDown' ? 1 : -1)
      }
      else if (e.key === 'Enter') this.enter()
    })
    this.$('[data-archive-idle]').addEventListener('click', () => {
      const idle = this.rows().filter((r) => r.idle && !r.archived)
      if (!idle.length) return
      if (!confirm(`Archive ${idle.length} idle thread${idle.length === 1 ? '' : 's'}? You can revive any of them from here.`)) return
      this.actions.archive(idle.map((r) => r.thread.id))
    })
  }

  get isOpen() {
    return this.el.classList.contains('open')
  }

  open() {
    this.el.classList.add('open')
    this.render()
    this.box.focus()
    this.box.select()
  }

  close() {
    this.el.classList.remove('open')
  }

  /** Called after every scan too, so an open panel never shows a stale status. */
  render() {
    if (!this.isOpen) return
    const all = this.rows()
    const idleCount = all.filter((r) => r.idle && !r.archived).length
    const idleButton = this.$('[data-archive-idle]')
    idleButton.textContent = `Archive idle (${idleCount})`
    idleButton.disabled = !idleCount
    for (const b of this.$('.search-filters').children) b.classList.toggle('primary', b.dataset.filter === this.filter)

    const query = this.box.value
    const found = all
      .filter((r) => (this.filter === 'archived' ? r.archived : this.filter === 'active' ? !r.archived : true))
      .filter((r) => matches(r, query))
      .sort((a, b) => b.thread.lastActivityAt - a.thread.lastActivityAt)

    const shown = found.slice(0, LIMIT)
    this.shown = new Map(shown.map((r) => [r.thread.id, r]))
    this.results.replaceChildren(...shown.map((r) => this.row(r)))
    // A scan re-renders this panel every few seconds; the highlight stays on the same thread.
    if (!shown.some((r) => r.thread.id === this.selectedId)) this.selectedId = shown[0]?.thread.id ?? null
    this.mark()
    const note = found.length > LIMIT ? `Showing ${LIMIT} of ${found.length}. Type more to narrow it down.` : ''
    if (!found.length) this.results.append(el('div', 'search-empty', query ? 'Nothing matches that.' : 'No threads here.'))
    else if (note) this.results.append(el('div', 'search-empty', note))
  }

  /**
   * Enter on the highlighted result: open its chat, and fly to its bot as well when it is on
   * the map, so you land beside it already talking. A thread with no chat just gets the flight.
   */
  enter() {
    const r = this.shown?.get(this.selectedId)
    if (!r) return
    const t = r.thread
    if (!t.canChat && !r.onMap) return
    this.close()
    if (r.onMap) this.actions.go(t)
    if (t.canChat) this.actions.chat(t)
  }

  /** ↑ / ↓ through the results, wrapping at either end. */
  move(step) {
    const rows = [...this.results.querySelectorAll('.search-row')]
    if (!rows.length) return
    const at = rows.findIndex((row) => row.dataset.id === this.selectedId)
    this.selectedId = rows[(at + step + rows.length) % rows.length].dataset.id
    this.mark()
  }

  selectedRow() {
    return [...this.results.querySelectorAll('.search-row')].find((row) => row.dataset.id === this.selectedId) || null
  }

  mark() {
    for (const row of this.results.querySelectorAll('.search-row')) {
      row.setAttribute('aria-selected', String(row.dataset.id === this.selectedId))
    }
    this.selectedRow()?.scrollIntoView({ block: 'nearest' })
  }

  row(r) {
    const { thread: t } = r
    const item = el('div', `search-row${r.archived ? ' archived' : ''}`)
    item.dataset.id = t.id
    // Pointing at a row highlights it too, so Enter and the mouse agree on which one is meant.
    item.addEventListener('mousemove', () => {
      if (this.selectedId === t.id) return
      this.selectedId = t.id
      this.mark()
    })
    const info = el('div', 'info')
    info.append(el('div', 'title', t.title || 'Untitled thread'))
    const where = [t.project, t.gitBranch, t.harnessName, r.archived ? (r.revivable ? 'Archived' : `Archived in ${t.harnessName || 'its harness'}`) : r.statusLabel, ago(t.lastActivityAt)]
    info.append(el('div', 'meta', where.filter(Boolean).join(' · ')))
    if (t.preview && t.preview !== t.title) info.append(el('div', 'preview', t.preview))

    const buttons = el('div', 'pair')
    const button = (label, cls, fn, primary) => {
      const b = el('button', cls, label)
      b.type = 'button'
      if (primary) b.dataset.primary = ''
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        fn()
      })
      buttons.append(b)
    }
    if (r.onMap) button('Go', 'btn', () => (this.close(), this.actions.go(t)), true)
    if (t.canChat) button('Chat', 'btn primary', () => (this.close(), this.actions.chat(t)), !r.onMap)
    if (r.revivable) button('Revive', 'btn', () => this.actions.revive([t.id]))
    else if (!r.archived) button('Archive', 'btn', () => this.actions.archive([t.id]))
    item.append(info, buttons)
    return item
  }
}
