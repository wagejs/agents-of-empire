/**
 * Running a plan.md as shared sessions: one session per repo, each implementing that repo's
 * steps in its own worktree and committing on `share/<session>`.
 *
 * The steps are the `###` headings under `## Implementation steps` (or `## Design`). A step
 * belongs to the repo named in backticks in its heading, or, when the heading names none, to
 * the one repo its body names. A step that still names no repo, or several, is reported as
 * unassigned and never silently run.
 *
 * "depends on step 1", "after step 2", "stacked on step 1" make the repo of that step a parent.
 * A repo session starts once every parent has reported, with their summaries in its brief. A
 * parent that ends any other way (blocked, failed) leaves its children unstarted.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { collectReport, startSession } from './orchestrator.mjs'
import { openStore } from './store.mjs'

const STEP_SECTIONS = [/^##\s+implementation steps\b/i, /^##\s+implementation\b/i, /^##\s+design\b/i]

/** The ticket key a plan file is named after: `PROJ-2880-…md` → `PROJ-2880`. */
export const planKey = (file) => {
  const base = path.basename(file, '.md')
  return (/^([A-Z][A-Z0-9]*-\d+)/.exec(base) || /^([A-Za-z]+-[^-]+)/.exec(base) || [base])[1].slice(0, 40)
}

/** Repos are folders under `reposDir` that are git checkouts. */
export const repoChecker = (reposDir) => (name) => fs.existsSync(path.join(reposDir, name, '.git'))

const ticks = (text) => [...text.matchAll(/`([\w.-]+)`/g)].map((m) => m[1])

/**
 * The plan's steps grouped by repo, with each repo's parents. Throws when the plan has no
 * steps section or its dependencies form a cycle.
 */
export function parsePlan(text, { isRepo }) {
  const lines = text.split('\n')
  let start = -1
  for (const re of STEP_SECTIONS) {
    start = lines.findIndex((l) => re.test(l))
    if (start >= 0) break
  }
  if (start < 0) throw new Error('The plan has no "## Implementation steps" (or "## Design") section')
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  const section = lines.slice(start + 1, end < 0 ? undefined : end)

  const steps = []
  for (const line of section) {
    if (/^###\s/.test(line)) steps.push({ title: line.replace(/^###\s+/, '').trim(), lines: [] })
    else steps.at(-1)?.lines.push(line)
  }
  for (const [i, s] of steps.entries()) {
    s.body = s.lines.join('\n').trim()
    delete s.lines
    s.n = Number((/^(\d+)\./.exec(s.title) || /PR\s*#(\d+)/i.exec(s.title) || [, i + 1])[1])
    const inTitle = [...new Set(ticks(s.title).filter(isRepo))]
    const inBody = [...new Set(ticks(s.body).filter(isRepo))]
    s.repo = inTitle[0] || (inBody.length === 1 ? inBody[0] : '')
    s.why = s.repo ? '' : inBody.length > 1 ? `names several repos (${inBody.join(', ')})` : 'names no repo'
    s.after = [...`${s.title}\n${s.body}`.matchAll(/\b(?:depends on|after|stacked on|needs)\s+(?:step\s+)?#?(\d+)\b/gi)].map((m) => Number(m[1]))
  }

  const byN = new Map(steps.map((s) => [s.n, s]))
  const repos = new Map()
  for (const s of steps.filter((x) => x.repo)) {
    const r = repos.get(s.repo) || { repo: s.repo, steps: [], dependsOn: new Set() }
    r.steps.push(s)
    for (const n of s.after) {
      const parent = byN.get(n)?.repo
      if (parent && parent !== s.repo) r.dependsOn.add(parent)
    }
    repos.set(s.repo, r)
  }
  const out = [...repos.values()].map((r) => ({ ...r, dependsOn: [...r.dependsOn] }))
  // A cycle would leave sessions waiting on each other forever.
  const seen = new Set()
  const visit = (name, trail) => {
    if (trail.includes(name)) throw new Error(`Steps depend on each other in a cycle: ${[...trail, name].join(' -> ')}`)
    if (seen.has(name)) return
    for (const p of repos.get(name)?.dependsOn || []) visit(p, [...trail, name])
    seen.add(name)
  }
  for (const r of out) visit(r.repo, [])
  return { repos: out, unassigned: steps.filter((s) => !s.repo).map((s) => ({ n: s.n, title: s.title, why: s.why })) }
}

/** The rules from "Implementing a ticket" every plan session works under. */
export const IMPLEMENT_LIMITS = [
  'The plan is the scope. Do only your steps; anything else goes in open_questions.',
  'Commit on your branch in your worktree, in small commits. Never push, never rebase, never force.',
  'Stop and report (submit_report with status "partial") on: the same test or build error twice after a fix attempt; 15 minutes with no progress; a change to a high-risk area the plan did not name (database migrations, payments, authentication, shared configuration, public APIs, shared libraries, routing); or a migration turning out to be needed.',
  'A stop report has: what was tried, the exact error, the current diff, and one suggested next step.',
  'Keep each pull request to one or two concerns: if your steps span more, say how to split them in decisions.',
]

const REPORT_FORMAT = `submit_report with:
- status: done, or partial when a stop rule fired
- summary: what changed and why, in a few sentences
- decisions: choices you made that the plan left open, each with its reason
- facts: what you verified in code, with code_refs (use the brief's git_sha)
- artifacts: one per commit, path "<repo>@<short sha>", description = the commit subject
- open_questions, needs_from_orchestrator`

function goalFor(planFile, r, name, parents) {
  const steps = r.steps.map((s) => `### ${s.title}\n${s.body}`).join('\n\n')
  const upstream = parents.length
    ? `\n\nUpstream sessions this depends on have reported:\n${parents.map((p) => `- ${p.name} (${p.repo}, branch share/${p.name}): ${p.summary}`).join('\n')}`
    : ''
  return `Implement the \`${r.repo}\` part of the plan ${planFile}.
Read the whole plan for context; only the steps below are yours. Work in your ${r.repo} worktree and commit on share/${name}.

${steps}${upstream}`
}

/** Session name for a repo's part of a plan. */
export const sessionName = (key, repo) => `${key}-${repo}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)

/**
 * Run a plan: every repo's session, parents first, independent ones at once. Sessions that
 * already exist are not restarted: a reported one counts as done for its children, any other
 * is left for you to resume or close. Resolves with one line per repo.
 */
export async function runPlan(planFile, { store = openStore(), only = [], dry = false, say = console.log, ...sessionOpts } = {}) {
  const file = path.resolve(planFile)
  const plan = parsePlan(await fsp.readFile(file, 'utf8'), { isRepo: repoChecker(store.reposDir) })
  const key = planKey(file)
  for (const u of plan.unassigned) say(`! step ${u.n} "${u.title}" ${u.why}: not run. Name its repo in backticks in the heading to include it.`)
  const wanted = only.length ? plan.repos.filter((r) => only.includes(r.repo)) : plan.repos
  if (dry) return wanted.map((r) => ({ name: sessionName(key, r.repo), repo: r.repo, steps: r.steps.map((s) => s.title), dependsOn: r.dependsOn, status: 'planned' }))

  await store.init()
  const runs = new Map()
  const runRepo = (r) => {
    if (runs.has(r.repo)) return runs.get(r.repo)
    const name = sessionName(key, r.repo)
    const p = (async () => {
      const parents = []
      for (const parentRepo of r.dependsOn) {
        const parentPlan = plan.repos.find((x) => x.repo === parentRepo)
        const parent = await runRepo(parentPlan)
        if (parent.status !== 'reported' && parent.status !== 'closed') {
          say(`- ${name}: not started, ${parent.name} ended ${parent.status}`)
          return { name, repo: r.repo, status: 'waiting', reason: `${parent.name} is ${parent.status}` }
        }
        const report = await collectReport(parent.name, { store })
        parents.push({ name: parent.name, repo: parentRepo, summary: (report?.summary || '').slice(0, 1500) })
      }
      const existing = await store.readState(name)
      if (existing) {
        say(`- ${name}: already ${existing.status}, not restarted`)
        return { name, repo: r.repo, status: existing.status }
      }
      // `only` narrows what starts, never what a wanted session waits for.
      if (!wanted.includes(r)) return { name, repo: r.repo, status: 'not-run' }
      say(`- ${name}: starting (${r.steps.length} step${r.steps.length === 1 ? '' : 's'})`)
      const state = await startSession(
        name,
        { goal: goalFor(file, r, name, parents), limits: IMPLEMENT_LIMITS, repos: [r.repo], reportFormat: REPORT_FORMAT, mode: 'implement' },
        { store, ...sessionOpts }
      )
      say(`- ${name}: ${state.status}`)
      return { name, repo: r.repo, status: state.status }
    })()
    runs.set(r.repo, p)
    return p
  }
  return Promise.all(wanted.map(runRepo))
}
