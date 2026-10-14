/**
 * Running a plan.md as shared sessions: how a plan splits into per-repo sessions, the order they
 * start in, and what an implementing session may run. A fake `query` plays each session.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../server/store.mjs'
import { bashAllowed, sessionHooks, sessionPermissions, toolHandlers } from '../server/session-tools.mjs'
import { answerPermit, classify, dropAsks, onAsk, pendingAsks, readPermits, TRUST_AFTER } from '../server/permit.mjs'
import { parsePlan, planKey, runPlan } from '../server/plan.mjs'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'share-plan-'))
const reposDir = path.join(tmp, 'repos')

async function makeRepo(name) {
  const repo = path.join(reposDir, name)
  await fsp.mkdir(path.join(repo, 'graphify-out'), { recursive: true })
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  await fsp.writeFile(path.join(repo, '.gitignore'), 'graphify-out/\n.claude/\n')
  await fsp.writeFile(path.join(repo, 'main.txt'), name)
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
const isRepo = (n) => ['be-api', 'fe-web'].includes(n)

const PLAN = `# PROJ-9999 — demo

## Context
\`fe-web\` and \`be-api\` both change.

## Implementation steps

### 1. \`be-api\`: add the param
1. handler reads country_code

### 2. \`be-api\`: tests
1. table test

### 3. Frontend sends it (depends on step 1)
1. \`fe-web\` api client adds the param

### 4. Ops note
1. tell \`be-api\` and \`fe-web\` owners

## PR split
| 1 | \`be-api\` |
`

test('a plan splits into one session per repo, with cross-repo parents', () => {
  const { repos, unassigned } = parsePlan(PLAN, { isRepo })
  assert.deepEqual(
    repos.map((r) => [r.repo, r.steps.map((s) => s.n), r.dependsOn]),
    [
      ['be-api', [1, 2], []],
      ['fe-web', [3], ['be-api']],
    ]
  )
  // Step 3 names its repo only in the body; step 4 names two, so it is not guessed.
  assert.deepEqual(unassigned, [{ n: 4, title: '4. Ops note', why: 'names several repos (be-api, fe-web)' }])
  assert.equal(planKey('/x/PROJ-9999-demo-plan.md'), 'PROJ-9999')
  assert.equal(planKey('/x/TBD-cf-waf-move.md'), 'TBD-cf')
})

test('a plan with no steps section, or a dependency cycle, is refused', () => {
  assert.throws(() => parsePlan('# x\n## Context\n', { isRepo }), /no "## Files to Change" or "## Implementation steps"/)
  const design = parsePlan('## Design\n### 1. `be-api`: a\n## Risks\n', { isRepo })
  assert.equal(design.repos[0].repo, 'be-api')
  const cycle = '## Implementation steps\n### 1. `be-api` (after step 2)\n### 2. `fe-web` (depends on step 1)\n'
  assert.throws(() => parsePlan(cycle, { isRepo }), /cycle/)
})

test('"Files to Change" decides the repos when step headings name none', () => {
  const plan = `# LGST-1
## Design
### 1. Override the country in the handler
x
### 2. FE sends the param (after step 1)
y
## Files to Change
| Repo | Change |
| --- | --- |
| \`be-api\` | New \`pkg/utils/country.go\` and its test |
| \`be-api\` | Handlers call the helper |
| \`fe-web\` | \`api/catalogue.js\` sends country_code |
| \`not-a-repo\` | ignored |

Nothing else changes.
## Tests
- \`fe-web\`: not a file to change
`
  const { repos, unassigned } = parsePlan(plan, { isRepo })
  assert.deepEqual(repos.map((r) => [r.repo, r.steps.map((s) => s.title)]), [
    ['be-api', ['New `pkg/utils/country.go` and its test', 'Handlers call the helper']],
    ['fe-web', ['`api/catalogue.js` sends country_code']],
  ])
  assert.deepEqual(unassigned, [], 'design steps are context once files say where the work is')
  // Bullets under a repo heading read the same; with no design section at all.
  const bullets = parsePlan('## Files to Change\n### `fe-web`\n- `a.js`: send it\n- be-api handler: `be-api` reads it\n', { isRepo })
  assert.deepEqual(bullets.repos.map((r) => [r.repo, r.steps.length]), [['fe-web', 1], ['be-api', 1]])
})

/** A fake session: reports `status` after `delay` ms, recording when it started. */
function fakeQuery(store, events, { fail = [] } = {}) {
  return ({ prompt, options }) =>
    (async function* () {
      const name = /# Brief: (\S+)/.exec(prompt)[1]
      events.push({ name, at: 'start', prompt })
      yield { type: 'system', subtype: 'init', session_id: `sid-${name}` }
      await new Promise((r) => setTimeout(r, 60))
      if (fail.some((f) => name.endsWith(f))) {
        await toolHandlers(store, name).ask_orchestrator({ question: 'Which country is default?' })
      } else {
        await toolHandlers(store, name).submit_report({ status: 'done', summary: `${name} added country_code`, decisions: [], facts: [] })
      }
      events.push({ name, at: 'end' })
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()
}

const planFile = path.join(tmp, 'PROJ-9999-demo.md')
await fsp.writeFile(planFile, PLAN)
let n = 0
const freshStore = () => openStore(path.join(tmp, `store-${++n}`), { reposDir }).init()
const quiet = () => {}

test('a dependent repo starts after its parent reports, with the parent summary in its brief', async () => {
  const store = await freshStore()
  const events = []
  const out = await runPlan(planFile, { store, say: quiet, query: fakeQuery(store, events), serveCheck: () => true, run: async () => {} })
  assert.deepEqual(out.map((r) => [r.name, r.status]), [
    ['PROJ-9999-be-api', 'reported'],
    ['PROJ-9999-fe-web', 'reported'],
  ])
  const order = events.map((e) => `${e.name}:${e.at}`)
  assert.ok(order.indexOf('PROJ-9999-fe-web:start') > order.indexOf('PROJ-9999-be-api:end'), order.join(' '))
  const brief = await fsp.readFile(path.join(store.sessionDir('PROJ-9999-fe-web'), 'brief.md'), 'utf8')
  assert.match(brief, /PROJ-9999-be-api \(be-api, branch share\/PROJ-9999-be-api\): PROJ-9999-be-api added country_code/)
  assert.match(brief, /### 3\. Frontend sends it/)
  assert.doesNotMatch(brief, /### 1\. `be-api`/, 'only its own steps')
  assert.match(brief, /Never rebase, never force-push/)
  assert.equal((await store.readState('PROJ-9999-be-api')).mode, 'implement')

  // Running the plan again restarts nothing.
  const again = await runPlan(planFile, { store, say: quiet, query: fakeQuery(store, events), serveCheck: () => true, run: async () => {} })
  assert.deepEqual(again.map((r) => r.status), ['reported', 'reported'])
  assert.equal(events.filter((e) => e.at === 'start').length, 2)
})

test('a parent that blocks leaves its children unstarted', async () => {
  const store = await freshStore()
  const events = []
  const out = await runPlan(planFile, { store, say: quiet, query: fakeQuery(store, events, { fail: ['be-api'] }), serveCheck: () => true, run: async () => {} })
  assert.deepEqual(out.map((r) => r.status), ['blocked', 'waiting'])
  assert.equal(await store.readState('PROJ-9999-fe-web'), null)
  assert.ok(!events.some((e) => e.name === 'PROJ-9999-fe-web'))
})

test('--dry starts nothing; --only starts just that repo', async () => {
  const store = await freshStore()
  const dry = await runPlan(planFile, { store, dry: true, say: quiet })
  assert.deepEqual(dry.map((r) => r.status), ['planned', 'planned'])
  assert.equal((await fsp.readdir(store.paths.sessions)).length, 0)
  const events = []
  const out = await runPlan(planFile, { store, only: ['be-api'], say: quiet, query: fakeQuery(store, events), serveCheck: () => true, run: async () => {} })
  assert.deepEqual(out.map((r) => [r.repo, r.status]), [['be-api', 'reported']])
})

const until = async (fn) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(fn(), 'timed out')
}

test('an implementing session runs allow-all; pushes, risky commands and your ask rules wait for you', async () => {
  const store = openStore(path.join(tmp, 'permit-store'), { reposDir })
  await store.init()
  const wt = path.join(reposDir, 'be-api', '.claude', 'worktrees', 'share-x')
  const writable = [store.sessionDir('x'), wt]
  const gate = { repo: 'be-api', rules: ['Bash(gh api * -X *)', 'mcp__acme-dev'] }
  const asked = []
  onAsk((a) => asked.push(a))
  const can = sessionPermissions(store, 'x', writable, { gate })
  const run = (command) => can('Bash', { command })
  const PR = ['gh', 'pr', 'create', '--fill'].join(' ')

  // Runs: builds, tests, scripts, anything inside the worktree.
  for (const cmd of [`cd ${wt} && go test ./...`, 'python3 x.py', 'curl https://example.com', 'npm run lint', 'git commit -m x']) {
    assert.equal((await run(cmd)).behavior, 'allow', cmd)
  }
  assert.equal((await can('Edit', { file_path: path.join(wt, 'a.go') })).behavior, 'allow')
  assert.equal((await can('Edit', { file_path: '/etc/hosts' })).behavior, 'deny', 'writes stay in the worktree')
  for (const cmd of ['git rebase main', 'git push --force origin x', 'git push -f']) assert.equal((await run(cmd)).behavior, 'deny', cmd)

  // Waits: each kind is held until answered, then recorded.
  assert.equal(classify('Bash', { command: 'kubectl apply -f x.yaml' }).kind, 'danger')
  assert.equal(classify('Bash', { command: 'make deploy-dev' }, ['Bash(make deploy*)']).kind, 'rule')
  assert.equal(classify('mcp__acme-dev__create_order', {}, gate.rules).kind, 'rule')
  assert.equal(classify('Bash', { command: 'go test ./...' }, gate.rules), null)
  const held = run('kubectl apply -f x.yaml')
  await until(() => asked.length === 1)
  assert.deepEqual([asked[0].kind, asked[0].repo, asked[0].session], ['danger', 'be-api', 'x'])
  await answerPermit(store, pendingAsks()[0].id, 'deny')
  assert.equal((await held).behavior, 'deny')

  // Five approved pushes, and that repo's sessions push without asking; another repo still asks.
  for (let i = 1; i <= TRUST_AFTER; i++) {
    const push = run('git push -u origin share/x')
    await until(() => pendingAsks().length === 1)
    const r = await answerPermit(store, pendingAsks()[0].id, 'allow')
    assert.equal((await push).behavior, 'allow')
    assert.equal(r.push_approved, i)
  }
  assert.equal((await run(PR)).behavior, 'allow', 'trusted: no ask')
  assert.equal(pendingAsks().length, 0)
  const rec = readPermits(store).repos['be-api']
  assert.equal(rec.push_approved, TRUST_AFTER)
  assert.equal(rec.decisions.at(-1).auto, true, 'an automatic allow is still written down')
  const other = sessionPermissions(store, 'y', [store.sessionDir('y')], { gate: { repo: 'fe-web', rules: [] } })
  const otherPush = other('Bash', { command: 'git push' })
  await until(() => pendingAsks().length === 1)
  dropAsks('y')
  assert.equal((await otherPush).behavior, 'deny', 'a session that ends drops its asks')

  // The hook sends what waits to the prompt even when a settings rule would allow it.
  const hooks = sessionHooks(store, 'x', writable, undefined, { gate })
  const out = await hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command: 'kubectl delete pod x' }, cwd: wt })
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask')
  assert.deepEqual(await hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command: 'go test ./...' }, cwd: wt }), {})

  // A research session still runs only read-only commands, and never pushes.
  assert.ok(!bashAllowed('go test ./...'))
  assert.equal((await sessionPermissions(store, 'r', writable)('Bash', { command: 'git push' })).behavior, 'deny')
})

test.after(() => fsp.rm(tmp, { recursive: true, force: true }))
