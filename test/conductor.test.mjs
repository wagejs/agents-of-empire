/**
 * The orchestrator session: previewing a plan for the page, starting repo sessions on the right
 * models in their worktrees, telling the orchestrator as each settles, and keeping its tools on
 * every later turn. Fake `query` and fake chat starts; no model is called.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'conductor-'))
const reposDir = path.join(tmp, 'repos')
process.env.BOT_CROSSING_STORE = path.join(tmp, 'store')
process.env.BOT_CROSSING_REPOS = reposDir
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude')
await fsp.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

const { openStore } = await import('../server/store.mjs')
const { toolHandlers } = await import('../server/session-tools.mjs')
const { CONDUCTOR_HOME, conductorHandlers, reportToOrchestrator, shareRoles, shareRoute, startConductor } = await import('../server/conductor.mjs')
const { startRun } = await import('../server/chat.mjs')

async function makeRepo(name) {
  const repo = path.join(reposDir, name)
  await fsp.mkdir(path.join(repo, 'graphify-out'), { recursive: true })
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  await fsp.writeFile(path.join(repo, '.gitignore'), 'graphify-out/\n.claude/\n')
  await fsp.writeFile(path.join(repo, 'a.txt'), name)
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  const origin = path.join(tmp, 'origins', `${name}.git`)
  execFileSync('git', ['clone', '-q', '--bare', repo, origin])
  git('remote', 'add', 'origin', origin)
  git('fetch', '-q', 'origin')
  git('remote', 'set-head', 'origin', 'main')
  await fsp.writeFile(path.join(repo, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [], links: [], built_at_commit: git('rev-parse', 'HEAD') }))
}
await makeRepo('be-api')
await makeRepo('fe-web')

const plan = path.join(tmp, 'PROJ-7777-demo.md')
await fsp.writeFile(
  plan,
  `# PROJ-7777\n\n## Implementation steps\n\n### 1. \`be-api\`: param\n1. x\n\n### 2. \`fe-web\`: send it (depends on step 1)\n1. y\n\n### 3. Ops\n1. nobody\n`
)
const store = openStore()

/** A fake Sonnet: records what it was asked, answers with `reading`. */
const reader = (reading, asked = []) => ({ prompt, options }) =>
  (async function* () {
    asked.push({ prompt, options })
    yield { type: 'result', subtype: 'success', structured_output: reading }
  })()

test('preview: Sonnet reads the plan, sessions are on Opus 5.5 by default, and mismatches are said', async () => {
  const asked = []
  const reading = { summary: 'Adds a country param.', repos: [{ repo: 'be-api', changes: ['handler reads country'] }, { repo: 'infra', changes: ['new env var'] }] }
  const { status, json } = await shareRoute('/api/share/preview', { plan }, { store, query: reader(reading, asked) })
  assert.equal(asked[0].options.model, 'claude-sonnet-5')
  assert.deepEqual(asked[0].options.tools, [], 'it only reads')
  assert.equal(asked[0].options.persistSession, false)
  assert.match(asked[0].prompt, /### 3\. Ops/, 'the whole plan is sent')
  assert.match(asked[0].prompt, /be-api, fe-web/, 'with the repos on this machine')
  assert.equal(json.summary, 'Adds a country param.')
  assert.deepEqual(json.repos, reading.repos)
  assert.match(json.warnings.join('\n'), /infra: the plan changes it, but no step is assigned/)
  assert.match(json.warnings.join('\n'), /fe-web: a session starts for it, but the reading found no change/)
  const noSteps = path.join(tmp, 'PROJ-1-freeform.md')
  await fsp.writeFile(noSteps, '# PROJ-1\n\nJust prose about `be-api`.\n')
  const free = (await shareRoute('/api/share/preview', { plan: noSteps }, { store, query: reader(reading) })).json
  assert.deepEqual(free.sessions, [], 'a plan with no steps section still previews')
  assert.equal(free.summary, 'Adds a country param.')
  const failed = () => (async function* () { yield { type: 'result', subtype: 'error_max_structured_output_retries' } })()
  await assert.rejects(shareRoute('/api/share/preview', { plan }, { store, query: failed }), /Could not read the plan/)
  assert.equal(status, 200)
  assert.deepEqual(json.sessions.map((s) => [s.name, s.model, s.dependsOn]), [
    ['PROJ-7777-be-api', 'claude-opus-5-5', []],
    ['PROJ-7777-fe-web', 'claude-opus-5-5', ['be-api']],
  ])
  assert.equal(json.models[0].id, 'claude-opus-5-5')
  assert.equal(json.home, CONDUCTOR_HOME)
  assert.match(json.warnings.join('\n'), /step 3 "3. Ops" names no repo/)
  await assert.rejects(shareRoute('/api/share/preview', { plan: path.join(tmp, 'nope.md') }, { store, query: failed }), /No file/)
  await assert.rejects(shareRoute('/api/share/preview', { plan: path.join(tmp, 'x.txt') }, { store, query: failed }), /\.md/)
})

test('the orchestrator starts in ~/.claude, on Opus 5.5, with its tools, and an unknown model is refused', async () => {
  let started
  const start = (target, text) => ((started = { target, text }), { id: 'run-1', sessionId: '', events: [], listeners: new Set(), done: false })
  await startConductor(plan, { 'fe-web': 'sonnet' }, { store, start })
  assert.equal(started.target.cwd, CONDUCTOR_HOME)
  assert.equal(started.target.model, 'claude-opus-5-5')
  assert.ok(started.target.options.mcpServers.orchestrator)
  assert.ok(started.target.options.allowedTools.includes('mcp__orchestrator__run_plan'))
  assert.ok(!started.target.options.allowedTools.includes('mcp__orchestrator__approve_report'), 'approving always asks')
  assert.match(started.text, /"be-api":"claude-opus-5-5","fe-web":"sonnet"/)
  await assert.rejects(startConductor(plan, { 'fe-web': 'gpt-9' }, { store, start }), /Unknown model/)
})

test('run_plan starts repo sessions in their worktrees on their models, and tells the orchestrator as each settles', async () => {
  const seen = []
  const query = ({ prompt, options }) =>
    (async function* () {
      const name = /# Brief: (\S+)/.exec(prompt)[1]
      seen.push({ name, cwd: options.cwd, model: options.model })
      yield { type: 'system', subtype: 'init', session_id: `sid-${name}` }
      await toolHandlers(store, name).submit_report({ status: 'done', summary: `${name} done`, decisions: [], facts: [] })
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    })()
  const told = []
  const start = (target, text) => told.push({ sessionId: target.sessionId, cwd: target.cwd, text })
  const h = conductorHandlers({ id: 'conductor-1' }, { store, query, start, serveCheck: () => true, run: async () => {} })

  const out = JSON.parse((await h.run_plan({ plan_path: plan, models: { 'fe-web': 'sonnet' } })).content[0].text)
  assert.deepEqual(out.started.map((s) => [s.repo, s.model]), [['be-api', 'claude-opus-5-5'], ['fe-web', 'sonnet']])
  // Started in the background: wait for both to be told.
  for (let i = 0; i < 100 && told.length < 2; i++) await new Promise((r) => setTimeout(r, 20))

  assert.deepEqual(seen.map((s) => [s.name, s.model]), [['PROJ-7777-be-api', 'claude-opus-5-5'], ['PROJ-7777-fe-web', 'sonnet']])
  for (const s of seen) assert.match(s.cwd, new RegExp(`/repos/${s.name.slice(8)}/\\.claude/worktrees/share-${s.name}$`), 'opens in its own worktree')
  assert.deepEqual(told.map((t) => [t.sessionId, t.cwd]), [['conductor-1', CONDUCTOR_HOME], ['conductor-1', CONDUCTOR_HOME]])
  assert.match(told[0].text, /PROJ-7777-be-api ended reported/)
  assert.match((await h.read_report({ session: 'PROJ-7777-fe-web' })).content[0].text, /PROJ-7777-fe-web done/)
  const status = JSON.parse((await h.status({ prefix: 'PROJ-7777' })).content[0].text)
  assert.deepEqual(status.map((s) => s.status), ['reported', 'reported'])
})

test('a later turn of a known orchestrator, from the page, gets its tools again', async () => {
  await fsp.writeFile(path.join(store.paths.root, 'conductors.json'), JSON.stringify({ 'sid-known': { plan } }))
  const optionsFor = async (sessionId) => {
    let options
    const query = (q) => {
      options = q.options
      return (async function* () {})()
    }
    const run = startRun({ sessionId, cwd: CONDUCTOR_HOME }, 'hi', { query })
    for (let i = 0; i < 50 && !run.done; i++) await new Promise((r) => setTimeout(r, 10))
    return options
  }
  assert.ok((await optionsFor('sid-known')).mcpServers?.orchestrator, 'the orchestrator keeps its tools')
  assert.equal((await optionsFor('sid-other')).mcpServers, undefined, 'any other thread is untouched')
})

test.after(() => fsp.rm(tmp, { recursive: true, force: true }))

test('shareRoles tags the orchestrator and each repo session with the plan they belong to', async () => {
  const roleStore = openStore(path.join(tmp, 'roles-store'), { reposDir })
  await roleStore.init()
  await fsp.writeFile(path.join(roleStore.paths.root, 'conductors.json'), JSON.stringify({ 'sid-orch': { plan: '/p/PROJ-5-x.md' } }))
  for (const [name, sid, repo] of [['PROJ-5-be-api', 'sid-be', 'be-api'], ['PROJ-5-fe-web', '', 'fe-web']]) {
    await roleStore.createSession(name, 'brief')
    await roleStore.writeState(name, { session_id: sid || undefined, status: 'reported', repos: [{ name: repo }] })
  }
  const roles = shareRoles(roleStore)
  assert.deepEqual(roles.get('sid-orch'), { role: 'orchestrator', plan: 'PROJ-5', file: '/p/PROJ-5-x.md' })
  assert.deepEqual(roles.get('sid-be'), { role: 'child', plan: 'PROJ-5', name: 'PROJ-5-be-api', repo: 'be-api', status: 'reported' })
  assert.equal(roles.size, 2, 'a session that never got a session id is not on the map yet')
})

test('Report to orchestrator passes on what you said to a repo session since its last report, once', async () => {
  const st = openStore(path.join(tmp, 'report-store'), { reposDir })
  await st.init()
  await fsp.writeFile(path.join(st.paths.root, 'conductors.json'), JSON.stringify({ 'sid-old': { plan: '/p/PROJ-6-x.md', registered_at: '2026-01-01' }, 'sid-orch': { plan: '/p/PROJ-6-x.md', registered_at: '2026-02-01' } }))
  await st.createSession('PROJ-6-be-api', 'brief')
  await st.writeState('PROJ-6-be-api', { session_id: 'sid-c', status: 'reported', repos: [{ name: 'be-api' }] })
  let messages = [
    { role: 'user', text: 'Your brief', tools: [] },
    { role: 'assistant', text: '', tools: [{ name: 'mcp__store__submit_report' }] },
    { role: 'user', text: 'add a validation script', tools: [] },
    { role: 'assistant', text: '', tools: [{ name: 'Bash' }] },
    { role: 'assistant', text: 'Added scripts/validate.sh and opened PR #12.', tools: [{ name: 'Bash' }, { name: 'Bash' }] },
  ]
  const read = async () => ({ ok: true, messages })
  const told = []
  const start = (target, text) => told.push({ target, text })
  const r = await reportToOrchestrator({ cliSessionId: 'sid-c' }, { store: st, read, start })
  assert.deepEqual([r.sent, r.orchestrator, r.messages], [true, 'sid-orch', 3], 'the newest orchestrator of that plan')
  assert.equal(told[0].target.sessionId, 'sid-orch')
  assert.match(told[0].text, /talked to PROJ-6-be-api directly/)
  assert.match(told[0].text, /\*\*Me:\*\* add a validation script/)
  assert.match(told[0].text, /\*\*be-api:\*\* Added scripts\/validate\.sh and opened PR #12\. _\(tools: Bash\)_/)
  assert.doesNotMatch(told[0].text, /Your brief/, 'nothing from before the report')

  const again = await reportToOrchestrator({ cliSessionId: 'sid-c' }, { store: st, read, start })
  assert.deepEqual([again.sent, told.length], [false, 1], 'pressing twice sends nothing new')
  messages = [...messages, { role: 'user', text: 'also bump the version', tools: [] }]
  await reportToOrchestrator({ cliSessionId: 'sid-c' }, { store: st, read, start })
  assert.match(told[1].text, /also bump the version/)
  assert.doesNotMatch(told[1].text, /validation script/, 'only what came since the last press')
  await assert.rejects(reportToOrchestrator({ cliSessionId: 'sid-orch' }, { store: st, read, start }), /not a repo session/)
})
