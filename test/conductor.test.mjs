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
process.env.AGENTS_OF_EMPIRE_STORE = path.join(tmp, 'store')
process.env.AGENTS_OF_EMPIRE_REPOS = reposDir
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

/** What the fake Opus reads out of a whole plan: be-api first, then fe-web; a task for the user. */
const READING = {
  sessions: [
    { repo: 'be-api', steps: [{ title: 'Accept country_code', detail: 'handler reads it' }], depends_on: [] },
    { repo: 'fe-web', steps: [{ title: 'Send country_code', detail: 'api client adds it' }], depends_on: ['be-api'] },
    { repo: 'other', steps: [{ title: 'Edit a repo that is not here', detail: '' }], depends_on: [] },
  ],
  human: ['The user runs the ALTER on prod'],
  notes: ['Never touch shared-lib'],
}

/** A fake Opus: records what it was asked; reads a whole plan into READING, exercises each repo. */
const exerciser = (asked = [], reading = READING) => ({ prompt, options }) =>
  (async function* () {
    asked.push({ prompt, options })
    if (/split the agent work/.test(prompt)) {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.3, structured_output: reading }
      return
    }
    const repo = /^Repo: (\S+)\./m.exec(prompt)[1]
    yield { type: 'result', subtype: 'success', total_cost_usd: 0.5, structured_output: { summary: `${repo} takes country_code.`, changes: [{ file: 'a.txt', change: 'read the param (a.txt:1)' }], tests: ['a_test: reads it'], risks: [], questions: [`${repo}: default country?`] } }
  })()

const exerciseDone = async (job) => {
  for (let i = 0; i < 200; i++) {
    const { json } = await shareRoute('/api/share/exercise', { job }, { store })
    if (json.done) return json
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('exercise never finished')
}

test('preview exercises the plan with Opus against each repo worktree, read-only; sessions default to Sonnet', async () => {
  const asked = []
  const { status, json } = await shareRoute('/api/share/preview', { plan }, { store, query: exerciser(asked), serveCheck: () => false, run: async () => {} })
  assert.equal(status, 200)
  assert.equal(json.phase, 'reading', 'Opus reads the whole plan first')
  assert.equal(json.models[0].id, 'sonnet')
  assert.equal(json.home, CONDUCTOR_HOME)

  const done = await exerciseDone(json.job)
  const read = asked.find((a) => /split the agent work/.test(a.prompt))
  assert.equal(read.options.model, 'claude-opus-5-5')
  assert.deepEqual(read.options.tools, [], 'reading the plan needs no tools')
  assert.match(read.prompt, /### 3\. Ops/, 'the whole plan, every section')
  assert.deepEqual(read.options.outputFormat.schema.properties.sessions.items.properties.repo.enum, ['be-api', 'fe-web', 'other'], 'only repos on this machine')
  assert.deepEqual(done.sessions.map((s) => [s.name, s.model, s.dependsOn, s.steps]), [
    ['PROJ-7777-be-api', 'sonnet', [], ['Accept country_code']],
    ['PROJ-7777-fe-web', 'sonnet', ['be-api'], ['Send country_code']],
  ])
  assert.match(done.warnings.join('\n'), /For you, not a session: The user runs the ALTER on prod/)
  assert.match(done.warnings.join('\n'), /is for other, which is not a repo on this machine/)
  assert.deepEqual(Object.values(done.repos).map((r) => r.status), ['done', 'done'])
  assert.equal(done.repos['be-api'].exercise.summary, 'be-api takes country_code.')
  const be = asked.find((a) => /Repo: be-api/.test(a.prompt))
  assert.equal(be.options.model, 'claude-opus-5-5')
  assert.match(be.options.cwd, /repos\/be-api\/\.claude\/worktrees\/share-PROJ-7777-be-api$/, 'in the worktree the session will use')
  assert.match(be.prompt, /branched from origin\/main/)
  assert.match(be.prompt, /### 3\. Ops/, 'the whole plan is sent')
  assert.equal(be.options.persistSession, false)
  assert.equal((await be.options.canUseTool('Bash', { command: 'grep -rn country .' })).behavior, 'allow')
  for (const command of ['go test ./...', 'git commit -m x', 'git push']) assert.equal((await be.options.canUseTool('Bash', { command })).behavior, 'deny', command)
  assert.ok(!be.options.tools.includes('Edit') && !be.options.tools.includes('Write'), 'it cannot edit')

  // Unchanged plan: the kept exercise is used, Opus is not asked again.
  const again = await shareRoute('/api/share/preview', { plan }, { store, query: exerciser(asked), serveCheck: () => false, run: async () => {} })
  const reused = await exerciseDone(again.json.job)
  assert.equal(asked.length, 3, 'reading and both exercises kept: Opus is not asked again')
  assert.ok(Object.values(reused.repos).every((r) => r.reused))

  const failed = () => (async function* () { yield { type: 'result', subtype: 'error_max_turns' } })()
  const original = await fsp.readFile(plan, 'utf8')
  await fsp.appendFile(plan, '\n<!-- edited -->\n')
  const broken = await shareRoute('/api/share/preview', { plan }, { store, query: failed, serveCheck: () => false, run: async () => {} })
  const after = await exerciseDone(broken.json.job)
  assert.match(after.error, /Opus could not read the plan \(error_max_turns\)/, 'an edited plan is read again, and a failed reading says so')
  const { readExercise, exerciseHash } = await import('../server/plan.mjs')
  assert.equal(readExercise(store, 'PROJ-7777-be-api', exerciseHash(await fsp.readFile(plan, 'utf8'), 'be-api', ['1. `be-api`: param'])), null, 'an exercise of the old plan does not count for the edited one')
  await fsp.writeFile(plan, original)
  assert.equal((await shareRoute('/api/share/exercise', { job: 'nope' }, { store })).status, 404)
  await assert.rejects(shareRoute('/api/share/preview', { plan: path.join(tmp, 'nope.md') }, { store }), /No file/)
  await assert.rejects(shareRoute('/api/share/preview', { plan: path.join(tmp, 'x.txt') }, { store }), /\.md/)
})

test('the orchestrator starts in ~/.claude, on Opus 5.5, with its tools; repo models as picked; an unknown model is refused', async () => {
  let started
  const start = (target, text) => ((started = { target, text }), { id: 'run-1', sessionId: '', events: [], listeners: new Set(), done: false })
  await startConductor(plan, { 'fe-web': 'claude-opus-5-5' }, { store, start })
  assert.equal(started.target.cwd, CONDUCTOR_HOME)
  assert.equal(started.target.model, 'claude-opus-5-5')
  assert.ok(started.target.options.mcpServers.orchestrator)
  assert.ok(started.target.options.allowedTools.includes('mcp__orchestrator__run_plan'))
  assert.ok(!started.target.options.allowedTools.includes('mcp__orchestrator__approve_report'), 'approving always asks')
  assert.match(started.text, /"be-api":"sonnet","fe-web":"claude-opus-5-5"/)
  await assert.rejects(startConductor(plan, { 'fe-web': 'gpt-9' }, { store, start }), /Unknown model/)
})

test('run_plan starts repo sessions in their worktrees on their models, and tells the orchestrator as each settles', async () => {
  const seen = []
  const query = ({ prompt, options }) =>
    (async function* () {
      const name = /# Brief: (\S+)/.exec(prompt)[1]
      seen.push({ name, cwd: options.cwd, model: options.model, prompt })
      yield { type: 'system', subtype: 'init', session_id: `sid-${name}` }
      await toolHandlers(store, name).submit_report({ status: 'done', summary: `${name} done`, decisions: [], facts: [] })
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    })()
  const told = []
  const start = (target, text) => told.push({ sessionId: target.sessionId, cwd: target.cwd, text })
  const h = conductorHandlers({ id: 'conductor-1' }, { store, query, start, serveCheck: () => true, run: async () => {} })

  const out = JSON.parse((await h.run_plan({ plan_path: plan, models: { 'fe-web': 'claude-opus-5-5' } })).content[0].text)
  assert.deepEqual(out.started.map((s) => [s.repo, s.model]), [['be-api', 'sonnet'], ['fe-web', 'claude-opus-5-5']])
  // Started in the background: wait for both to be told.
  for (let i = 0; i < 100 && told.length < 2; i++) await new Promise((r) => setTimeout(r, 20))

  assert.deepEqual(seen.map((s) => [s.name, s.model]), [['PROJ-7777-be-api', 'sonnet'], ['PROJ-7777-fe-web', 'claude-opus-5-5']])
  // The exercise from the preview is in the brief Sonnet starts from.
  assert.match(seen[0].prompt, /## Exercise\nOpus read the plan against this code/)
  assert.match(seen[0].prompt, /- `a\.txt`: read the param \(a\.txt:1\)/)
  assert.match(seen[0].prompt, /- be-api: default country\?/)
  assert.match(seen[0].prompt, /## Rules from the plan, for every session\n- Never touch shared-lib/, "the plan's rules, as Opus read them")
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
  assert.deepEqual(roles.get('sid-be'), { role: 'child', plan: 'PROJ-5', name: 'PROJ-5-be-api', repo: 'be-api', status: 'reported', asks: [], push_approved: 0 })
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

test('a plan in any layout is read whole: an EPIC with tasks, human steps and no repo headings', async () => {
  const epic = path.join(tmp, 'EPIC-auto-maintenance.md')
  await fsp.writeFile(epic, '# Auto-maintenance\n\n## Order\nT1 then T2.\n\n## T1. Add a column\nThe user runs it.\n\n# Implementation steps\n\n## T2 steps (be-api, repository)\n1. write the flag\n')
  const reading = { sessions: [{ repo: 'be-api', steps: [{ title: 'T2: write the flag', detail: 'repository write with history row' }], depends_on: [] }], human: ['T1: The user runs the column migration'], notes: [] }
  const { json } = await shareRoute('/api/share/preview', { plan: epic }, { store, query: exerciser([], reading), serveCheck: () => false, run: async () => {} })
  const done = await exerciseDone(json.job)
  assert.equal(done.error, null)
  assert.deepEqual(done.sessions.map((s) => [s.name, s.steps]), [['EPIC-auto-be-api', ['T2: write the flag']]])
  assert.equal(done.repos['be-api'].status, 'done')
  // Start reads the same split: run_plan dry gives the session Opus decided, with its detail in the brief.
  const { runPlan } = await import('../server/plan.mjs')
  const dry = await runPlan(epic, { store, dry: true, say: () => {} })
  assert.deepEqual(dry.map((s) => s.repo), ['be-api'])
})
