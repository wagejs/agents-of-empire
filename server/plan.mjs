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
import { createHash } from 'node:crypto'
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

/** The lines of the first `## ` section whose heading matches one of `res`, or null. */
function sectionOf(lines, res) {
  for (const re of res) {
    const start = lines.findIndex((l) => re.test(l))
    if (start < 0) continue
    const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
    return lines.slice(start + 1, end < 0 ? undefined : end)
  }
  return null
}

/**
 * The "## Files to Change" section: one entry per change, with its repo. Reads a table whose
 * first column is the repo, or bullets under a `### repo` heading or naming the repo in backticks.
 */
function filesToChange(lines, isRepo) {
  const out = []
  let current = ''
  for (const line of sectionOf(lines, [/^##\s+Files to change\b/i]) || []) {
    if (/^###\s/.test(line)) {
      current = ticks(line).find(isRepo) || line.replace(/^###\s+/, '').trim()
      if (!isRepo(current)) current = ''
      continue
    }
    const cells = line.trim().startsWith('|') ? line.split('|').slice(1, -1).map((c) => c.trim()) : null
    if (cells) {
      const repo = ticks(cells[0])[0] || cells[0]
      if (cells.length > 1 && isRepo(repo)) out.push({ repo, change: cells.slice(1).join(' · ') })
      continue
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)/.exec(line)?.[1]
    const repo = item && (ticks(item).find(isRepo) || current)
    if (repo) out.push({ repo, change: item })
  }
  return out
}

/**
 * The plan's steps grouped by repo, with each repo's parents. When the plan has a "Files to
 * Change" section, its repos are the ones that get sessions and its rows are their scope; steps
 * that name a repo add to it, and "after step N" still orders them. Throws when the plan has
 * neither, or its dependencies form a cycle.
 */
export function parsePlan(text, { isRepo }) {
  const lines = text.split('\n')
  const files = filesToChange(lines, isRepo)
  const section = sectionOf(lines, STEP_SECTIONS)
  if (!section && !files.length) throw new Error('The plan has no "## Files to Change" or "## Implementation steps" (or "## Design") section')

  const steps = []
  for (const line of section || []) {
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
  for (const f of files) {
    const r = repos.get(f.repo) || { repo: f.repo, steps: [], dependsOn: new Set() }
    r.steps.push({ title: f.change, body: '', file: true })
    repos.set(f.repo, r)
  }
  const out = [...repos.values()].map((r) => ({ ...r, dependsOn: [...r.dependsOn] }))
  noCycles(out)
  // With a Files to Change list, a design step that names no repo is context, not lost work.
  const unassigned = files.length ? [] : steps.filter((s) => !s.repo).map((s) => ({ n: s.n, title: s.title, why: s.why }))
  return { repos: out, unassigned }
}

/** A cycle would leave sessions waiting on each other forever. */
function noCycles(repos) {
  const byRepo = new Map(repos.map((r) => [r.repo, r]))
  const seen = new Set()
  const visit = (name, trail) => {
    if (trail.includes(name)) throw new Error(`Steps depend on each other in a cycle: ${[...trail, name].join(' -> ')}`)
    if (seen.has(name)) return
    for (const p of byRepo.get(name)?.dependsOn || []) visit(p, [...trail, name])
    seen.add(name)
  }
  for (const r of repos) visit(r.repo, [])
}

/** Where Opus's reading of a whole plan is kept: which repo sessions it makes, and in what order. */
export const readingFile = (store, key) => path.join(store.paths.root, 'exercises', `${key}.reading.json`)

/**
 * The repo sessions Opus read out of a plan, in the shape `parsePlan` gives, if a reading of
 * this exact plan text is kept. Repos not on this machine are dropped, and said so.
 */
export function planFromReading(store, key, planText, isRepo) {
  let reading
  try {
    reading = JSON.parse(fs.readFileSync(readingFile(store, key), 'utf8'))
  } catch {
    return null
  }
  if (reading.plan_hash !== exerciseHash(planText, '', [])) return null
  const known = reading.sessions.filter((s) => isRepo(s.repo))
  const repos = known.map((s) => ({
    repo: s.repo,
    steps: s.steps.map((x) => ({ title: x.title, body: x.detail || '' })),
    dependsOn: s.depends_on.filter((d) => d !== s.repo && known.some((k) => k.repo === d)),
  }))
  noCycles(repos)
  const unassigned = reading.sessions.filter((s) => !isRepo(s.repo)).map((s) => ({ n: 0, title: s.steps.map((x) => x.title).join('; '), why: `is for ${s.repo}, which is not a repo on this machine` }))
  return { repos, unassigned, human: reading.human || [], notes: reading.notes || [] }
}

/** The rules from "Implementing a ticket" every plan session works under. */
export const IMPLEMENT_LIMITS = [
  'The plan is the scope. Do only your steps; anything else goes in open_questions.',
  'Commit on your branch in your worktree, in small commits. Never rebase, never force-push. Pushing and opening a PR wait for the user to allow them, so do them last, once tests pass.',
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

function goalFor(planFile, r, name, parents, exercise, notes = []) {
  const files = r.steps.filter((s) => s.file).map((s) => `- ${s.title}`)
  const steps = [...r.steps.filter((s) => !s.file).map((s) => `### ${s.title}\n${s.body}`), ...(files.length ? [`### Files to Change (${r.repo})\n${files.join('\n')}`] : [])].join('\n\n')
  const upstream = parents.length
    ? `\n\nUpstream sessions this depends on have reported:\n${parents.map((p) => `- ${p.name} (${p.repo}, branch share/${p.name}): ${p.summary}`).join('\n')}`
    : ''
  return `Implement the \`${r.repo}\` part of the plan ${planFile}.
Read the whole plan for context; only the steps and files below are yours. Work in your ${r.repo} worktree (branched from the remote base in the brief, not the local checkout) and commit on share/${name}.

${steps}${upstream}${notes.length ? `\n\n## Rules from the plan, for every session\n${notes.map((n) => `- ${n}`).join('\n')}` : ''}${exercise ? `\n\n${renderExercise(exercise)}` : ''}`
}

/** What a repo session implements on: the latest Sonnet. Opus already exercised the plan. */
export const IMPLEMENT_MODEL = 'sonnet'

/** Where a repo session's exercise is kept: Opus's reading of the plan against that repo's code. */
export const exerciseFile = (store, name) => path.join(store.paths.root, 'exercises', `${name}.json`)

/** The plan an exercise was made from: an edited plan, or other steps, needs a new one. */
export const exerciseHash = (planText, repo, stepTitles) => createHash('sha1').update(`${planText}\n${repo}\n${stepTitles.join('\n')}`).digest('hex')

/** The kept exercise for a session, if there is one for this exact plan (`hash`, when given). */
export function readExercise(store, name, hash) {
  try {
    const ex = JSON.parse(fs.readFileSync(exerciseFile(store, name), 'utf8'))
    return !hash || ex.plan_hash === hash ? ex : null
  } catch {
    return null
  }
}

/** An exercise as the brief gives it to the session that implements it. */
export function renderExercise(ex) {
  const list = (items) => (items?.length ? items.map((x) => `- ${x}`).join('\n') : '- (none)')
  return `## Exercise
Opus read the plan against this code before you started. Follow it; where the code does not match it, say so in open_questions rather than improvise.

${ex.summary}

### Changes
${ex.changes?.length ? ex.changes.map((c) => `- \`${c.file}\`: ${c.change}`).join('\n') : '- (none)'}

### Tests
${list(ex.tests)}

### Risks
${list(ex.risks)}

### Open questions
${list(ex.questions)}`
}

/** Session name for a repo's part of a plan. */
export const sessionName = (key, repo) => `${key}-${repo}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)

/**
 * Run a plan: every repo's session, parents first, independent ones at once. Sessions that
 * already exist are not restarted: a reported one counts as done for its children, any other
 * is left for you to resume or close. Resolves with one line per repo.
 *
 * Each session runs on `models[repo]`, else `model`, else Opus 5.5. `onSettled` hears about
 * each repo as it ends (reported, blocked, failed, or left waiting on a parent).
 */
export async function runPlan(
  planFile,
  { store = openStore(), only = [], dry = false, say = console.log, models = {}, model = IMPLEMENT_MODEL, onSettled = () => {}, ...sessionOpts } = {}
) {
  const file = path.resolve(planFile)
  const planText = await fsp.readFile(file, 'utf8')
  const key = planKey(file)
  const isRepo = repoChecker(store.reposDir)
  // Opus's reading of the whole plan when there is one; the heading parser only as a fallback.
  const plan = planFromReading(store, key, planText, isRepo) || parsePlan(planText, { isRepo })
  for (const u of plan.unassigned) say(u.n ? `! step ${u.n} "${u.title}" ${u.why}: not run. Name its repo in backticks in the heading to include it.` : `! "${u.title}" ${u.why}: not run.`)
  for (const h of plan.human || []) say(`For you, not a session: ${h}`)
  const wanted = only.length ? plan.repos.filter((r) => only.includes(r.repo)) : plan.repos
  const modelOf = (repo) => models[repo] || model || IMPLEMENT_MODEL
  if (dry) {
    return wanted.map((r) => ({ name: sessionName(key, r.repo), repo: r.repo, steps: r.steps.map((s) => s.title), dependsOn: r.dependsOn, model: modelOf(r.repo), status: 'planned' }))
  }

  await store.init()
  const runs = new Map()
  const runRepo = (r) => {
    if (runs.has(r.repo)) return runs.get(r.repo)
    const name = sessionName(key, r.repo)
    const p = (async () => {
      const result = await settle()
      if (result.status !== 'not-run') await Promise.resolve(onSettled(result)).catch(() => {})
      return result
    })()
    async function settle() {
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
        { goal: goalFor(file, r, name, parents, readExercise(store, name, exerciseHash(planText, r.repo, r.steps.map((x) => x.title))), plan.notes), limits: IMPLEMENT_LIMITS, repos: [r.repo], reportFormat: REPORT_FORMAT, mode: 'implement' },
        { store, ...sessionOpts, model: modelOf(r.repo) }
      )
      say(`- ${name}: ${state.status}`)
      return { name, repo: r.repo, status: state.status }
    }
    runs.set(r.repo, p)
    return p
  }
  return Promise.all(wanted.map(runRepo))
}
