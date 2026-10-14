/**
 * Run a plan as shared sessions: give a plan.md path, see which repo sessions it makes and in
 * what order, pick each one's model (Opus 5.5 unless you say otherwise), and start.
 *
 * Starting opens the orchestrator's chat: a Claude Code session in ~/.claude that runs the plan
 * and reads each repo session's report back to you. Each repo session is a thread of its repo,
 * working in its own worktree, so it walks onto the map in that repo's zone.
 */
import { shareExercise, sharePreview, shareStart } from '../game/api.js'
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
    <p class="plan-hint">Preview has Opus 5.5 exercise the plan against each repo's code, in a fresh worktree. Start then runs one session per repo on the model you pick, with that exercise as its brief. A repo that depends on another starts once that one has reported. Pushes, PRs and risky commands wait for your Allow.</p>
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
    this.input.addEventListener('input', () => (clearTimeout(this.polling), this.show(null)))
  }

  get isOpen() {
    return this.el.classList.contains('open')
  }

  open() {
    this.el.classList.add('open')
    if (this.preview?.job) this.follow()
    this.input.focus()
    this.input.select()
  }

  close() {
    // The exercise keeps going on the server; reopening and pressing Preview picks it up again.
    clearTimeout(this.polling)
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
    this.note('Reading the plan…')
    clearTimeout(this.polling)
    try {
      this.show(await sharePreview(plan))
      localStorage.setItem(LAST_PLAN, plan)
      this.follow()
    } catch (err) {
      this.show(null)
      this.note(err.message, true)
    }
  }

  /** Poll the exercise until every repo is done or failed; Start waits for it. */
  async follow() {
    const preview = this.preview
    if (!preview?.job) return this.note(preview?.sessions.length ? '' : 'No repo session to exercise')
    try {
      const { repos, done } = await shareExercise(preview.job)
      if (this.preview !== preview) return
      preview.exercise = repos
      this.show(preview)
      if (!done) {
        const busy = Object.entries(repos).filter(([, r]) => r.status !== 'done' && r.status !== 'failed').map(([repo]) => repo)
        this.note(`Opus is exercising the plan against the code: ${busy.join(', ')}…`)
        this.polling = setTimeout(() => this.follow(), 2500)
      } else {
        const failed = Object.values(repos).filter((r) => r.status === 'failed').length
        const cost = Object.values(repos).reduce((sum, r) => sum + (r.reused ? 0 : r.exercise?.cost_usd || 0), 0)
        this.note(`${failed ? `${failed} exercise${failed === 1 ? '' : 's'} failed; those sessions start from the plan alone. ` : 'Exercised. '}${cost ? `Opus cost $${cost.toFixed(2)}.` : ''}`, Boolean(failed))
      }
    } catch (err) {
      if (this.preview === preview) this.note(err.message, true)
    }
  }

  /**
   * One row per repo session: its exercise as it comes in (what changes where, tests, open
   * questions), and the model it implements on. Or the hint when there is no preview.
   */
  show(preview) {
    this.preview = preview
    const exercising = Object.values(preview?.exercise || {}).some((r) => r.status !== 'done' && r.status !== 'failed')
    this.$('[data-start]').disabled = !preview?.sessions.length || exercising
    const body = this.$('.plan-body')
    if (!preview) {
      body.replaceChildren(this.$('.plan-hint') || el('p', 'plan-hint'))
      return
    }
    const picked = Object.fromEntries([...this.el.querySelectorAll('.plan-row select')].map((s) => [s.dataset.repo, s.value]))
    const rows = preview.sessions.map((s) => {
      const ex = preview.exercise?.[s.repo] || {}
      const row = el('div', 'plan-row')
      const info = el('div', 'info')
      const state = { queued: 'waiting to start', reading: 'Opus is reading the code…', done: ex.reused ? 'exercised (kept from last time)' : 'exercised', failed: `exercise failed: ${ex.error || ''}` }[ex.status] || ''
      info.append(el('div', 'title', s.repo), el('div', 'sub', `${s.steps.length} item${s.steps.length === 1 ? '' : 's'}${s.dependsOn.length ? ` · after ${s.dependsOn.join(', ')}` : ''}${state ? ` · ${state}` : ''}`))
      const e = ex.exercise
      if (e) {
        const summary = el('div', 'plan-summary')
        summary.append(renderMarkdown(e.summary))
        const list = el('ul', 'plan-steps')
        for (const c of e.changes) list.append(el('li', '', `${c.file}: ${c.change}`))
        info.append(summary, list)
        if (e.tests.length) info.append(el('div', 'plan-sub', `Tests: ${e.tests.join(' · ')}`))
        for (const q of e.questions) info.append(el('div', 'plan-warn', `? ${q}`))
        for (const r of e.risks) info.append(el('div', 'plan-risk', `Risk: ${r}`))
      } else {
        const list = el('ul', 'plan-steps')
        for (const t of s.steps) list.append(el('li', '', t.replace(/`/g, '')))
        info.append(list)
      }
      const pick = el('select', 'select')
      pick.dataset.repo = s.repo
      pick.setAttribute('aria-label', `Model ${s.repo} implements on`)
      pick.title = 'The model that implements this repo'
      for (const m of preview.models) pick.append(new Option(m.label, m.id, false, m.id === (picked[s.repo] || s.model)))
      row.append(info, pick)
      return row
    })
    const head = el('div', 'plan-file', preview.file)
    const warn = preview.warnings.map((w) => el('div', 'plan-warn', w.replace(/^! /, '')))
    const where = el('p', 'plan-hint', `Opus 5.5 exercises each repo; the sessions implement on the model picked. Pushes, PRs and risky commands wait for your Allow. The orchestrator opens as a chat in ${preview.home}.`)
    body.replaceChildren(head, ...warn, ...rows, where)
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
