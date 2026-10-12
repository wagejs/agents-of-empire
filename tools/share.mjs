/**
 * Shared sessions from the command line. Every command reads and writes the store at
 * ~/.claude/.store (BOT_CROSSING_STORE moves it); repos are looked up in ~/projects
 * (BOT_CROSSING_REPOS).
 *
 *   npm run share -- run <plan.md> [--dry] [--only repo,repo] [--model opus|sonnet] [--max-turns N]
 *   npm run share -- status [KEY]
 *   npm run share -- report <session>
 *   npm run share -- resume <session> "<answer or instruction>"
 *   npm run share -- approve <session>
 *   npm run share -- close <session> ["reason"]
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { approveReport, closeSession, collectReport, resumeSession } from '../server/orchestrator.mjs'
import { runPlan } from '../server/plan.mjs'
import { openStore } from '../server/store.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const flag = (name) => {
  const i = rest.indexOf(`--${name}`)
  if (i < 0) return undefined
  const value = rest[i + 1]
  rest.splice(i, value === undefined || value.startsWith('--') ? 1 : 2)
  return value === undefined || value.startsWith('--') ? true : value
}
const store = await openStore().init()
const USAGE = `usage:
  npm run share -- run <plan.md> [--dry] [--only repo,repo] [--model opus|sonnet] [--max-turns N]
  npm run share -- status [KEY]
  npm run share -- report <session>
  npm run share -- resume <session> "<answer or instruction>"
  npm run share -- approve <session>
  npm run share -- close <session> ["reason"]`
const usage = (code = 1) => {
  console.log(USAGE)
  process.exit(code)
}

async function status(prefix = '') {
  const names = (await fsp.readdir(store.paths.sessions).catch(() => [])).filter((n) => n.startsWith(prefix)).sort()
  if (!names.length) return console.log('no sessions')
  for (const name of names) {
    const s = (await store.readState(name)) || {}
    const repos = (s.repos || []).map((r) => r.name).join(',')
    const kept = s.kept_worktrees?.length ? ` · kept ${s.kept_worktrees.join(', ')}` : ''
    console.log(`${name.padEnd(40)} ${String(s.status).padEnd(9)} ${repos}${s.cost_usd != null ? ` · $${s.cost_usd.toFixed(2)}` : ''}${kept}`)
  }
}

switch (cmd) {
  case 'run': {
    const dry = Boolean(flag('dry'))
    const only = String(flag('only') || '').split(',').filter(Boolean)
    const model = flag('model')
    const maxTurns = Number(flag('max-turns')) || undefined
    const plan = rest[0]
    if (!plan) usage()
    const out = await runPlan(plan, { store, dry, only, model: typeof model === 'string' ? model : undefined, options: maxTurns ? { maxTurns } : {} })
    if (dry) {
      for (const r of out) console.log(`${r.name}\n  steps: ${r.steps.join(' | ')}\n  after: ${r.dependsOn.join(', ') || '-'}`)
    } else {
      console.log('')
      for (const r of out) console.log(`${r.name.padEnd(40)} ${r.status}${r.reason ? ` (${r.reason})` : ''}`)
      console.log(`\nNext: npm run share -- report <session>, then approve or resume it.`)
    }
    break
  }
  case 'status':
    await status(rest[0])
    break
  case 'report': {
    const r = rest[0] && (await collectReport(rest[0], { store }))
    if (!r) {
      const q = rest[0] && (await fsp.readFile(path.join(store.sessionDir(rest[0]), 'question.md'), 'utf8').catch(() => ''))
      console.log(q ? `No report; the session asked:\n\n${q}` : `No report from ${rest[0]}`)
    } else console.log(r.body)
    break
  }
  case 'resume': {
    if (!rest[0] || !rest[1]) usage()
    const s = await resumeSession(rest[0], rest.slice(1).join(' '), { store })
    console.log(`${rest[0]}: ${s.status}`)
    break
  }
  case 'approve': {
    if (!rest[0]) usage()
    const { notes, keptWorktrees } = await approveReport(rest[0], { store })
    console.log(`notes: ${notes.join(', ') || '(none)'}`)
    if (keptWorktrees.length) console.log(`kept worktrees with work in them:\n  ${keptWorktrees.join('\n  ')}`)
    break
  }
  case 'close': {
    if (!rest[0]) usage()
    const { keptWorktrees } = await closeSession(rest[0], { store, reason: rest.slice(1).join(' ') })
    console.log(`closed${keptWorktrees.length ? `; kept ${keptWorktrees.join(', ')}` : ''}`)
    break
  }
  default:
    usage(cmd ? 1 : 0)
}
