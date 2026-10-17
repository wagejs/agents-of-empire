/**
 * The panel a chat link opens in: beside the chat, the chat's size, inside the page.
 *
 * Not a browser window: Arc, among others, ignores where a page asks a popup to go. And not
 * github.com framed: GitHub refuses that. So a GitHub PR or issue is read on the server through
 * your `gh` login and drawn here; any other page is framed when it allows it, and otherwise
 * offered to the browser.
 *
 * In the desktop app every web link opens in a real browser view instead, laid over the panel's
 * body: nothing there refuses to be shown, and you stay signed in to what you sign in to.
 */
import { chatLink } from '../game/api.js'
import { ICON } from './hud.js'
import { renderMarkdown } from './markdown.js'
import { rememberSize } from './resizable.js'
import { fileActions, renderFile, scrollToLine } from './file-view.js'

const el = (tag, className, text) => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text != null) e.textContent = text
  return e
}

const md = (text) => {
  const box = el('div', 'md')
  box.append(renderMarkdown(text || ''))
  return box
}

const who = (a) => a?.login || a?.name || 'someone'
const day = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '')

/** A PR's checks, counted: "12 passed · 1 failed · 2 running". */
function checks(rollup = []) {
  const n = { passed: 0, failed: 0, running: 0 }
  for (const c of rollup) {
    const v = String(c.conclusion || c.state || c.status || '').toUpperCase()
    if (/SUCCESS|NEUTRAL|SKIPPED/.test(v)) n.passed++
    else if (/FAIL|ERROR|CANCEL|TIMED_OUT|ACTION_REQUIRED/.test(v)) n.failed++
    else n.running++
  }
  return Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(' · ')
}

const svg = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`
const FULL_ICON = {
  enter: svg('M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5'),
  exit: svg('M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5'),
}

/** The desktop shell's browser view, when the page runs in it. */
const shell = window.agentsOfEmpireApp?.browser

export class LinkPanel {
  /**
   * `onClose` runs whenever the panel closes, for a host that should close with it; `sizeKey` is
   * where the size you drag it to is kept, one per place the panel lives.
   */
  constructor(parent, { onClose = () => {}, sizeKey = 'agents-of-empire.link-size' } = {}) {
    this.onClose = onClose
    this.el = el('div', 'link-panel panel')
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="link-head">
        <div class="info"><div class="repo-tag" hidden></div><div class="title"></div><div class="sub"></div></div>
        <span class="link-nav" hidden>
          <button class="btn icon ghost" data-nav="back" title="Back">‹</button>
          <button class="btn icon ghost" data-nav="forward" title="Forward">›</button>
          <button class="btn icon ghost" data-nav="reload" title="Reload">↻</button>
        </span>
        <a class="btn ghost" data-out target="_blank" rel="noopener noreferrer" title="Open in the browser">Open ↗</a>
        <button class="btn icon ghost" data-full title="Fullscreen">${FULL_ICON.enter}</button>
        <button class="btn icon ghost" data-close title="Close">${ICON.close}</button>
      </div>
      <div class="link-body"></div>`
    parent.append(this.el)
    rememberSize(this.el, sizeKey)
    this.$ = (s) => this.el.querySelector(s)
    this.$('[data-close]').addEventListener('click', () => this.close())
    this.$('[data-full]').addEventListener('click', () => this.fullscreen(!this.el.classList.contains('full')))
    // Links inside the panel open in the panel too.
    this.el.addEventListener('click', (e) => {
      const a = e.target.closest?.('.link-body a[href^="http"]')
      if (!a || e.metaKey || e.ctrlKey) return
      e.preventDefault()
      this.open(a.href)
    })
    if (shell) {
      this.el.addEventListener('click', (e) => {
        const nav = e.target.closest?.('[data-nav]')
        if (nav) shell[nav.dataset.nav]()
      })
      shell.onEscape(() => this.isOpen && this.close())
      shell.onState((s) => {
        if (!this.browsing) return
        this.$('.title').textContent = s.title || new URL(s.url).host
        this.$('.sub').textContent = s.loading ? `Loading… ${s.url}` : s.url
        this.$('[data-out]').href = s.url
        this.$('[data-nav="back"]').disabled = !s.back
        this.$('[data-nav="forward"]').disabled = !s.forward
      })
    }
  }

  /** Put the browser view over the panel's body, and keep it there as the chat moves or resizes. */
  browse(url) {
    this.browsing = true
    this.$('.link-nav').hidden = false
    this.$('.title').textContent = new URL(url).host
    this.$('.sub').textContent = url
    shell.open(url)
    // ponytail: one rect read a frame while the panel is open; a ResizeObserver misses moves.
    let last = ''
    const follow = () => {
      if (!this.browsing) return
      const r = this.$('.link-body').getBoundingClientRect()
      const key = `${r.x},${r.y},${r.width},${r.height}`
      if (key !== last) shell.bounds({ x: r.x, y: r.y, width: r.width, height: r.height })
      last = key
      this.follow = requestAnimationFrame(follow)
    }
    cancelAnimationFrame(this.follow)
    follow()
  }

  stopBrowsing() {
    if (!this.browsing) return
    this.browsing = false
    cancelAnimationFrame(this.follow)
    this.$('.link-nav').hidden = true
    shell.hide()
  }

  get isOpen() {
    return !this.el.hidden
  }

  fullscreen(on) {
    this.el.classList.toggle('full', on)
    const b = this.$('[data-full]')
    b.innerHTML = on ? FULL_ICON.exit : FULL_ICON.enter
    b.title = on ? 'Exit fullscreen' : 'Fullscreen'
  }

  close() {
    this.fullscreen(false)
    this.stopBrowsing()
    this.el.hidden = true
    this.el.parentElement?.classList.remove('with-link')
    this.$('.link-body').replaceChildren()
    this.url = null
    this.onClose()
  }

  /**
   * A file from the ⌘P browser. `repo` is `{ name, color }` for the coloured tag over the title,
   * as the chat header wears it.
   */
  showFile(file, line = 0, repo = null) {
    this.stopBrowsing()
    this.url = null
    this.docKey = `file:${file.abs}`
    this.el.hidden = false
    this.el.parentElement?.classList.add('with-link')
    this.$('[data-out]').hidden = true
    const tag = this.$('.repo-tag')
    tag.hidden = !repo
    if (repo) {
      tag.textContent = repo.name
      tag.style.setProperty('--repo', repo.color)
    }
    this.$('.title').textContent = file.path.split('/').pop() + (line ? `:${line}` : '')
    this.$('.sub').textContent = [file.path, file.branch && `⎇ ${file.branch}`].filter(Boolean).join(' · ')
    const body = this.$('.link-body')
    body.replaceChildren(renderFile(file, { line }))
    this.$('.link-foot')?.remove()
    const foot = fileActions(file, line)
    foot.classList.add('link-foot')
    this.el.append(foot)
    body.scrollTop = 0
    scrollToLine(body, line)
  }

  /**
   * A document rather than a link: Claude's plan, say. `actions` is an element of buttons for
   * the panel's foot, or nothing. Returns the body, for whoever wants to update it.
   */
  showDoc({ title, sub = '', markdown, actions = null, key = '' }) {
    this.stopBrowsing()
    this.$('.repo-tag').hidden = true
    this.url = null
    this.docKey = key
    this.el.hidden = false
    this.el.parentElement?.classList.add('with-link')
    this.$('[data-out]').hidden = true
    this.$('.title').textContent = title
    this.$('.sub').textContent = sub
    const body = this.$('.link-body')
    body.replaceChildren(md(markdown))
    this.$('.link-foot')?.remove()
    if (actions) {
      actions.classList.add('link-foot')
      this.el.append(actions)
    }
    body.scrollTop = 0
  }

  /** Change the second line of a document still showing, as a plan gets approved. */
  noteDoc(key, sub) {
    if (this.isOpen && this.docKey === key) {
      this.$('.sub').textContent = sub
      this.$('.link-foot')?.remove()
    }
  }

  async open(url) {
    this.docKey = ''
    this.$('.repo-tag').hidden = true
    this.$('.link-foot')?.remove()
    this.$('[data-out]').hidden = false
    this.url = url
    this.el.hidden = false
    this.el.parentElement?.classList.add('with-link')
    this.$('[data-out]').href = url
    this.$('.title').textContent = url
    this.$('.sub').textContent = 'Loading…'
    const body = this.$('.link-body')
    body.replaceChildren()
    if (shell) return this.browse(url)
    let link
    try {
      link = await chatLink(url)
    } catch (err) {
      link = { kind: 'blocked', error: err.message }
    }
    if (this.url !== url) return
    if (link.kind === 'pr' || link.kind === 'issue') return this.github(link)
    if (link.kind === 'frame') {
      this.$('.title').textContent = new URL(url).host
      this.$('.sub').textContent = url
      const frame = el('iframe')
      frame.src = url
      frame.referrerPolicy = 'no-referrer'
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups')
      return body.append(frame)
    }
    this.$('.title').textContent = new URL(url).host
    this.$('.sub').textContent = url
    const note = el('div', 'link-blocked')
    note.append(
      el('p', '', link.error || 'This site does not allow itself to be shown inside another page.'),
      Object.assign(el('a', 'btn primary', 'Open in browser'), { href: url, target: '_blank', rel: 'noopener noreferrer' })
    )
    body.append(note)
  }

  github({ kind, repo, data: d }) {
    const pr = kind === 'pr'
    this.$('.title').textContent = `#${d.number} ${d.title}`
    const state = d.isDraft ? 'Draft' : String(d.state || '').toLowerCase()
    this.$('.sub').textContent = [
      repo,
      state,
      pr && `+${d.additions} −${d.deletions} · ${d.changedFiles} file${d.changedFiles === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · ')

    const body = this.$('.link-body')
    const meta = el('div', 'gh-meta')
    const line = (label, value) => value && meta.append(el('div', '', `${label}: ${value}`))
    line('By', `${who(d.author)} · ${day(d.createdAt)}`)
    if (pr) {
      line('Branch', `${d.headRefName} → ${d.baseRefName}`)
      line('Review', String(d.reviewDecision || 'none yet').toLowerCase().replace(/_/g, ' '))
      line('Checks', checks(d.statusCheckRollup))
      line('Merge', String(d.mergeStateStatus || '').toLowerCase())
    } else {
      line('Labels', (d.labels || []).map((l) => l.name).join(', '))
    }
    body.append(meta, md(d.body || '*No description.*'))

    if (pr && d.files?.length) {
      const files = el('div', 'gh-section')
      files.append(el('h4', '', `Files (${d.files.length})`))
      for (const f of d.files) {
        const row = el('div', 'gh-file')
        row.append(el('span', 'path', f.path), el('span', 'add', `+${f.additions}`), el('span', 'del', `−${f.deletions}`))
        files.append(row)
      }
      body.append(files)
    }

    // Reviews and comments together, oldest first, as the PR page reads.
    const talk = [
      ...(d.reviews || []).map((r) => ({ at: r.submittedAt, head: `${who(r.author)} · ${String(r.state).toLowerCase().replace(/_/g, ' ')}`, text: r.body })),
      ...(d.comments || []).map((c) => ({ at: c.createdAt, head: who(c.author), text: c.body })),
    ]
      .filter((t) => t.text || /approved|changes/.test(t.head))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    if (talk.length) {
      const section = el('div', 'gh-section')
      section.append(el('h4', '', `Conversation (${talk.length})`))
      for (const t of talk) {
        const item = el('div', 'gh-comment')
        item.append(el('div', 'gh-who', `${t.head} · ${day(t.at)}`))
        if (t.text) item.append(md(t.text))
        section.append(item)
      }
      body.append(section)
    }
    body.scrollTop = 0
  }
}
