/**
 * A peek at a quiet thread: point at an idle bot and a small card by the cursor shows what
 * was said last, without opening its chat.
 *
 * Only once the pointer has rested on the bot for a moment, so sweeping across the map loads
 * nothing; and each thread's last message is kept until the thread moves on, so pointing at
 * the same bot again is instant. A working bot gets no card: what it said last is about to be
 * out of date, and its badge already says it is busy.
 */
import { chatMessages, threadPrs } from '../game/api.js'

const REST_MS = 350
const MAX_CHARS = 320

/** Markdown down to something that reads as a sentence on one small card. */
export function plain(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The last thing anyone said in a list of chat messages: Claude's reply, or else yours. */
export function lastSaid(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.text?.trim()) return { who: m.role === 'user' ? 'You' : 'Claude', text: plain(m.text) }
  }
  return null
}

const prCache = new Map()

/** A thread's PRs, asked once per thread and change, and shared by the hover card and the bot card. */
export async function prsFor(thread) {
  // Also every two minutes: a PR gets merged or approved without the thread moving.
  const key = `${thread.id}@${thread.lastActivityAt}@${Math.floor(Date.now() / 120_000)}`
  if (!prCache.has(key)) {
    prCache.set(key, threadPrs(thread).then((r) => r.prs || [], () => []))
    if (prCache.size > 80) prCache.delete(prCache.keys().next().value)
  }
  return prCache.get(key)
}

const STATUS_TEXT = { draft: 'Draft', open: 'Open', approved: 'Approved', changes: 'Changes requested', merged: 'Merged', closed: 'Closed' }

/** A PR as a pill, coloured by where it stands. `label` defaults to "#12 repo". */
export function prPill(pr, label = `#${pr.number} ${pr.repo.split('/').pop()}`) {
  const a = document.createElement('a')
  a.className = `pr-pill${pr.status ? ` is-${pr.status}` : ''}`
  a.href = pr.url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.textContent = label
  a.title = [STATUS_TEXT[pr.status], pr.url].filter(Boolean).join(' · ')
  return a
}

export class HoverCard {
  constructor(parent) {
    this.el = document.createElement('div')
    this.el.className = 'hover-card panel'
    this.el.hidden = true
    parent.append(this.el)
    this.cache = new Map()
    this.timer = 0
    this.threadId = ''
  }

  /** Point at `thread` (or nothing) with the pointer at `x`, `y` in page pixels. */
  show(thread, x, y, label) {
    this.place(x, y)
    if (!thread) return this.hide()
    if (thread.id === this.threadId) return
    this.hide()
    this.threadId = thread.id
    // Errands and other harnesses have no transcript the page can read.
    if (!thread.canChat || !thread.ref) return
    this.timer = setTimeout(() => this.load(thread, label), REST_MS)
  }

  hide() {
    clearTimeout(this.timer)
    this.threadId = ''
    this.el.hidden = true
  }

  place(x, y) {
    // Beside the pointer, kept on screen.
    const w = this.el.offsetWidth || 300
    const h = this.el.offsetHeight || 120
    this.el.style.left = `${Math.min(x + 16, innerWidth - w - 8)}px`
    this.el.style.top = `${Math.min(y + 16, innerHeight - h - 8)}px`
  }

  async load(thread, label) {
    const key = `${thread.id}@${thread.lastActivityAt}`
    const prsPending = prsFor(thread)
    let said = this.cache.get(key)
    if (said === undefined) {
      try {
        said = lastSaid((await chatMessages(thread)).messages)
      } catch {
        said = null
      }
      this.cache.set(key, said)
      if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value)
    }
    if (this.threadId !== thread.id) return
    this.el.replaceChildren()
    const head = document.createElement('div')
    head.className = 'hc-title'
    head.textContent = thread.title || 'Untitled thread'
    const sub = document.createElement('div')
    sub.className = 'hc-sub'
    sub.textContent = label || ''
    const body = document.createElement('div')
    body.className = 'hc-body'
    if (said) {
      const who = document.createElement('b')
      who.textContent = `${said.who}: `
      body.append(who, said.text.length > MAX_CHARS ? `${said.text.slice(0, MAX_CHARS)}…` : said.text)
    } else body.textContent = 'Nothing said yet.'
    const prs = await prsPending
    if (this.threadId !== thread.id) return
    // Where its work went: the branch it is on, and the PRs it opened.
    if (thread.gitBranch || prs.length) {
      const line = document.createElement('div')
      line.className = 'hc-where'
      if (thread.gitBranch) line.append(Object.assign(document.createElement('span'), { textContent: `⎇ ${thread.gitBranch}` }))
      line.append(...prs.map((p) => prPill(p)))
      this.el.append(head, sub, line, body)
    } else this.el.append(head, sub, body)
    this.el.hidden = false
  }
}
