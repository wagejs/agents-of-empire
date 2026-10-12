/**
 * Run a plan as shared sessions: give a plan.md path, see which repo sessions it makes and in
 * what order, pick each one's model (Opus 5.5 unless you say otherwise), and start.
 *
 * Starting opens the orchestrator's chat: a Claude Code session in ~/.claude that runs the plan
 * and reads each repo session's report back to you. Each repo session is a thread of its repo,
 * working in its own worktree, so it walks onto the map in that repo's zone.
 */
import { sharePreview, shareStart } from '../game/api.js'
import { ICON } from './hud.js'
import { renderMarkdown } from './markdown.js'

const LAST_PLAN = 'bot-crossing.last-plan'

const TEMPLATE = `
<div class="sheet panel">
  <div class="chat-head">
    <input class="search-box" type="text" spellcheck="false" placeholder="Plan file, e.g. ~/projects/plans/plans/PROJ-2880-….md" aria-label="Plan file path" />
    <button class="btn" data-preview type="button">Preview</button>
    <button class="btn icon ghost" data-close title="Close (Esc)">${ICON.close}</button>
  </div>
  <div class="plan-body">
    <p class="plan-hint">One session per repo, each in its own worktree. A repo that depends on another starts once that one has reported. Nothing is pushed.</p>
  </div>
  <div class="plan-foot">
    <span class="plan-note"></span>
    <button class="btn primary" data-start type="button" disabled>Start</button>
  </div>
</div>`

const el = (tag, className, text) => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text != null) e.textContent = text
  return e
}

export class PlanPanel {
  /** `onStarted({ runId, folder, title })` opens the orchestrator's chat. */
  constructor(parent, { onStarted }) {
    this.onStarted = onStarted
    this.preview = null
    this.el = el('div', 'chat search plan-run')
    this.el.innerHTML = TEMPLATE
    parent.appendChild(this.el)
    this.$ = (s) => this.el.querySelector(s)
    this.input = this.$('.search-box')
    this.input.value = localStorage.getItem(LAST_PLAN) || ''
    this.el.addEventListener('click', (e) => e.target === this.el && this.close())
    this.$('[data-close]').addEventListener('click', () => this.close())
    this.$('[data-preview]').addEventListener('click', () => this.load())
    this.$('[data-start]').addEventListener('click', () => this.start())
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close()
      else if (e.key === 'Enter') this.load()
    })
    // A new path is a new plan: what was previewed no longer applies.
    this.input.addEventListener('input', () => this.show(null))
  }

  get isOpen() {
    return this.el.classList.contains('open')
  }

  open() {
    this.el.classList.add('open')
    this.input.focus()
    this.input.select()
  }

  close() {
    this.el.classList.remove('open')
  }

  note(text, err = false) {
    const n = this.$('.plan-note')
    n.textContent = text
    n.classList.toggle('err', err)
  }

  async load() {
    const plan = this.input.value.trim()
    if (!plan) return this.note('Give the path of a plan.md', true)
    this.note('Sonnet is reading the plan…')
    try {
      this.show(await sharePreview(plan))
      localStorage.setItem(LAST_PLAN, plan)
      this.note('')
    } catch (err) {
      this.show(null)
      this.note(err.message, true)
    }
  }

  /**
   * What the plan changes, as Sonnet read it, one row per repo; a repo that gets a session has
   * its model picker. Or the hint when there is no preview.
   */
  show(preview) {
    this.preview = preview
    this.$('[data-start]').disabled = !preview?.sessions.length
    const body = this.$('.plan-body')
    if (!preview) {
      body.replaceChildren(this.$('.plan-hint') || el('p', 'plan-hint'))
      return
    }
    const sessions = new Map(preview.sessions.map((s) => [s.repo, s]))
    const changes = new Map(preview.repos.map((r) => [r.repo, r.changes]))
    const rows = [...new Set([...changes.keys(), ...sessions.keys()])].map((repo) => {
      const s = sessions.get(repo)
      const row = el('div', 'plan-row')
      const info = el('div', 'info')
      info.append(el('div', 'title', repo), el('div', 'sub', s ? `${s.steps.length} step${s.steps.length === 1 ? '' : 's'}${s.dependsOn.length ? ` · after ${s.dependsOn.join(', ')}` : ''}` : 'no session'))
      const list = el('ul', 'plan-steps')
      for (const t of changes.get(repo) || s.steps) list.append(el('li', '', t.replace(/`/g, '')))
      info.append(list)
      row.append(info)
      if (s) {
        const pick = el('select', 'select')
        pick.dataset.repo = repo
        pick.setAttribute('aria-label', `Model for ${repo}`)
        for (const m of preview.models) pick.append(new Option(m.label, m.id, false, m.id === s.model))
        row.append(pick)
      }
      return row
    })
    const head = el('div', 'plan-file', preview.file)
    const summary = el('div', 'plan-summary')
    summary.append(renderMarkdown(preview.summary))
    const warn = preview.warnings.map((w) => el('div', 'plan-warn', w.replace(/^! /, '')))
    const where = el('p', 'plan-hint', `The orchestrator opens as a chat in ${preview.home}.`)
    body.replaceChildren(head, summary, ...warn, ...rows, where)
  }

  async start() {
    if (!this.preview) return
    const models = Object.fromEntries([...this.el.querySelectorAll('.plan-row select')].map((s) => [s.dataset.repo, s.value]))
    const names = this.preview.sessions.map((s) => s.repo).join(', ')
    if (!confirm(`Start ${this.preview.sessions.length} session${this.preview.sessions.length === 1 ? '' : 's'} (${names})? They edit and commit in their own worktrees.`)) return
    this.$('[data-start]').disabled = true
    this.note('Starting the orchestrator…')
    try {
      const { runId, folder } = await shareStart(this.preview.file, models)
      const key = this.preview.sessions[0]?.name.replace(/-[^-]*$/, '') || 'plan'
      this.close()
      this.note('')
      this.onStarted({ runId, folder, title: `Orchestrator · ${this.preview.file.split('/').pop()}`, key })
    } catch (err) {
      this.$('[data-start]').disabled = false
      this.note(err.message, true)
    }
  }
}
