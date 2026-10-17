/**
 * ⌘P: find any file in the repos under the browser's folder and open it, as VS Code's quick
 * open does.
 *
 *   handler          files whose path fuzzy-matches, best first
 *   handler.go:120   …and open it at line 120
 *   @api-server x   only that repo (Tab completes the name)
 *   /utm_campaign    lines containing the text, across the repos (or the one picked)
 *   (nothing)        the files you opened lately
 *
 * The whole file list comes over once and is matched here as you type, so a keystroke never
 * waits on the server; it is fetched again in the background each time the palette opens.
 */
import { filesGrep, filesList, filesRead } from '../game/api.js'
import { ICON } from './hud.js'
import { rememberSize } from './resizable.js'
import { fuzzy, splitLine } from '../game/fuzzy.js'

const LIMIT = 60
const RECENT_KEY = 'bot-crossing.files.recent'
const SCOPE_KEY = 'bot-crossing.files.scope'

const el = (tag, className, text) => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text != null) e.textContent = text
  return e
}

const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback
  } catch {
    return fallback
  }
}
const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private window: nothing remembered, nothing broken */
  }
}

/** The text with the letters at `at` in <b>, built as nodes. */
function marked(text, at, offset = 0) {
  const frag = document.createDocumentFragment()
  let last = 0
  for (const raw of at) {
    const i = raw - offset
    if (i < 0 || i >= text.length) continue
    if (i > last) frag.append(text.slice(last, i))
    frag.append(el('b', '', text[i]))
    last = i + 1
  }
  frag.append(text.slice(last))
  return frag
}

const TEMPLATE = `
<div class="sheet panel">
  <div class="chat-head">
    <input class="search-box" type="text" spellcheck="false" autocomplete="off"
      placeholder="Go to file…  @repo to narrow, /text to search inside, :line to jump" aria-label="Go to file" />
    <button class="btn icon ghost" data-close title="Close (Esc)">${ICON.close}</button>
  </div>
  <div class="search-bar">
    <select class="select palette-scope" aria-label="Repo"></select>
    <span class="palette-note"></span>
  </div>
  <div class="search-results"></div>
</div>`

export class Palette {
  /**
   * `open(where, line)` shows a file (`where` is `{ repo, path }`); `repoOf(name)` gives a repo's
   * `{ name, color }`; `currentRepo()` the repo of the open chat, if any, for the scope to start on.
   */
  constructor(parent, { open, repoOf = () => null, currentRepo = () => '' }) {
    this.openFile = open
    this.repoOf = repoOf
    this.currentRepo = currentRepo
    this.data = null
    this.scope = load(SCOPE_KEY, '')
    this.selected = 0
    this.grepSeq = 0

    this.el = el('div', 'chat search palette')
    this.el.innerHTML = TEMPLATE
    parent.append(this.el)
    this.$ = (s) => this.el.querySelector(s)
    rememberSize(this.$('.sheet'), 'bot-crossing.palette-size')
    this.box = this.$('.search-box')
    this.results = this.$('.search-results')
    this.scopeEl = this.$('.palette-scope')

    this.el.addEventListener('click', (e) => e.target === this.el && this.close())
    this.$('[data-close]').addEventListener('click', () => this.close())
    this.scopeEl.addEventListener('change', () => {
      this.scope = this.scopeEl.value
      save(SCOPE_KEY, this.scope)
      this.render()
      this.box.focus()
    })
    this.box.addEventListener('input', () => {
      this.selected = 0
      this.render()
    })
    this.box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Only the palette: the chat it was opened over stays.
        e.preventDefault()
        e.stopPropagation()
        this.close()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        this.move(e.key === 'ArrowDown' ? 1 : -1)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        this.enter()
      } else if (e.key === 'Tab' && this.completeRepo()) e.preventDefault()
    })
  }

  get isOpen() {
    return this.el.classList.contains('open')
  }

  toggle() {
    this.isOpen ? this.close() : this.open()
  }

  open() {
    this.el.classList.add('open')
    this.box.value = ''
    this.selected = 0
    this.box.focus()
    this.render()
    this.refresh()
  }

  close() {
    this.el.classList.remove('open')
  }

  async refresh() {
    try {
      this.data = await filesList()
      // Each file as `repo/path`, lower-cased once, so matching is all that typing costs.
      this.index = this.data.repos.flatMap((r) =>
        r.files.map((f) => {
          const full = `${r.name}/${f}`
          return { repo: r.name, path: f, full, lower: full.toLowerCase(), nameFrom: full.lastIndexOf('/') + 1 }
        })
      )
      this.fillScope()
      if (this.isOpen) this.render()
    } catch (err) {
      this.note(err.message)
    }
  }

  fillScope() {
    const names = this.data.repos.map((r) => r.name)
    if (this.scope && !names.includes(this.scope)) this.scope = ''
    this.scopeEl.replaceChildren(
      Object.assign(el('option', '', `All repos (${names.length})`), { value: '' }),
      ...names.map((n) => Object.assign(el('option', '', n), { value: n }))
    )
    this.scopeEl.value = this.scope
  }

  note(text) {
    this.$('.palette-note').textContent = text
  }

  /** What was typed, taken apart: the repo it names, the text search or the file query, the line. */
  parse() {
    let q = this.box.value.trimStart()
    let repo = this.scope
    const at = /^@(\S*)\s*/.exec(q)
    if (at) {
      const names = this.data?.repos.map((r) => r.name) || []
      repo = names.find((n) => n === at[1]) || names.find((n) => n.startsWith(at[1])) || ''
      q = q.slice(at[0].length)
    }
    if (q.startsWith('/')) return { repo, grep: q.slice(1) }
    return { repo, ...splitLine(q.trim()) }
  }

  /** Tab on `@go-ord` fills in `@api-server `. */
  completeRepo() {
    const m = /^@(\S*)$/.exec(this.box.value)
    if (!m || !this.data) return false
    const name = this.data.repos.map((r) => r.name).find((n) => n.startsWith(m[1]))
    if (!name) return false
    this.box.value = `@${name} `
    this.render()
    return true
  }

  render() {
    if (!this.isOpen) return
    if (!this.data) {
      this.note('Listing files…')
      return this.results.replaceChildren(el('div', 'search-empty', 'Listing the files of every repo…'))
    }
    const p = this.parse()
    if (p.grep != null) return this.grep(p)
    const rows = p.query ? this.match(p) : this.recent(p.repo)
    this.rows = rows.map((r) => ({ ...r, line: p.line }))
    const total = p.repo ? this.data.repos.find((r) => r.name === p.repo)?.files.length || 0 : this.index.length
    this.note(`${p.repo || 'All repos'} · ${total.toLocaleString()} files`)
    this.draw(p.query ? 'No file matches that.' : 'Type to find a file. Files you open show here next time.')
  }

  match({ query, repo }) {
    const q = query.toLowerCase()
    const found = []
    for (const f of this.index) {
      if (repo && f.repo !== repo) continue
      const m = fuzzy(q, f.lower, f.nameFrom)
      if (m) found.push({ ...f, score: m.score, at: m.at })
    }
    found.sort((a, b) => b.score - a.score)
    return found.slice(0, LIMIT)
  }

  recent(repo) {
    return load(RECENT_KEY, [])
      .filter((r) => !repo || r.repo === repo)
      .map((r) => ({ ...r, full: `${r.repo}/${r.path}`, at: [] }))
  }

  /** `/text`: lines containing it, asked of the server a moment after typing stops. */
  grep({ grep, repo }) {
    clearTimeout(this.grepTimer)
    if (grep.trim().length < 2) {
      this.rows = []
      this.note('')
      return this.draw('Type at least two characters to search inside files.')
    }
    this.note('Searching…')
    const seq = ++this.grepSeq
    this.grepTimer = setTimeout(async () => {
      let res
      try {
        res = await filesGrep(grep, repo || undefined)
      } catch (err) {
        return this.note(err.message)
      }
      if (seq !== this.grepSeq || !this.isOpen) return
      const lower = grep.toLowerCase()
      this.rows = res.hits.map((h) => {
        const i = h.text.toLowerCase().indexOf(lower)
        return { ...h, full: `${h.repo}/${h.path}`, at: [], text: h.text.trim(), hit: i }
      })
      this.note(`${res.hits.length}${res.more ? '+' : ''} lines in ${repo || 'all repos'}`)
      this.draw('Nothing contains that.')
    }, 250)
  }

  draw(empty) {
    const rows = this.rows || []
    this.selected = Math.min(this.selected, Math.max(0, rows.length - 1))
    this.results.replaceChildren(...rows.map((r, i) => this.row(r, i)))
    if (!rows.length) this.results.append(el('div', 'search-empty', empty))
    this.mark()
  }

  row(r, i) {
    const item = el('div', 'search-row palette-row')
    item.dataset.i = i
    const dot = el('span', 'palette-dot')
    const color = this.repoOf(r.repo)?.color
    if (color) dot.style.background = color
    const info = el('div', 'info')
    const name = r.full.slice(r.full.lastIndexOf('/') + 1)
    const nameAt = r.full.lastIndexOf('/') + 1
    const title = el('div', 'title')
    title.append(marked(name, r.at, nameAt))
    if (r.line) title.append(el('span', 'palette-line', `:${r.line}`))
    const dir = r.full.slice(0, nameAt - 1)
    const meta = el('div', 'meta')
    meta.append(marked(dir, r.at))
    info.append(title, meta)
    if (r.text != null) {
      const pre = el('div', 'palette-hit')
      if (r.hit >= 0) {
        const start = Math.max(0, r.hit - 40)
        pre.append(start ? '…' : '', r.text.slice(start, r.hit), el('b', '', r.text.slice(r.hit, r.hit + this.parse().grep.length)), r.text.slice(r.hit + this.parse().grep.length))
      } else pre.textContent = r.text
      info.append(pre)
    }
    item.append(dot, info)
    item.addEventListener('mousemove', () => {
      if (this.selected === i) return
      this.selected = i
      this.mark()
    })
    item.addEventListener('click', () => {
      this.selected = i
      this.enter()
    })
    return item
  }

  move(step) {
    const n = this.rows?.length || 0
    if (!n) return
    this.selected = (this.selected + step + n) % n
    this.mark()
  }

  mark() {
    for (const row of this.results.querySelectorAll('.palette-row')) {
      row.setAttribute('aria-selected', String(Number(row.dataset.i) === this.selected))
    }
    this.results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  async enter() {
    const r = this.rows?.[this.selected]
    if (!r) return
    const where = { repo: r.repo, path: r.path }
    let file
    try {
      file = await filesRead(where)
    } catch (err) {
      return this.note(err.message)
    }
    this.close()
    save(RECENT_KEY, [where, ...load(RECENT_KEY, []).filter((x) => x.repo !== r.repo || x.path !== r.path)].slice(0, 20))
    this.openFile(file, r.line || 0)
  }
}
