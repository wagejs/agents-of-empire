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
import { bashAllowed, IMPLEMENT_BASH, toolHandlers } from '../server/session-tools.mjs'
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
  assert.throws(() => parsePlan('# x\n## Context\n', { isRepo }), /no "## Implementation steps"/)
  const design = parsePlan('## Design\n### 1. `be-api`: a\n## Risks\n', { isRepo })
  assert.equal(design.repos[0].repo, 'be-api')
  const cycle = '## Implementation steps\n### 1. `be-api` (after step 2)\n### 2. `fe-web` (depends on step 1)\n'
  assert.throws(() => parsePlan(cycle, { isRepo }), /cycle/)
})

/** A fake session: reports `status` after `delay` ms, recording when it started. */
function fakeQuery(store, events, { fail = [] } = {}) {
  return ({ prompt, options }) =>
    (async function* () {
      const name = path.basename(options.cwd)
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
  assert.match(brief, /Never push/)
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

test('implementing sessions may build, test and commit, but not push or script freely', () => {
  const wt = '/w/be-api/.claude/worktrees/share-x'
  for (const cmd of [`cd ${wt} && go test ./...`, 'go vet ./... | head', `git -C ${wt} commit -m "feat: country_code"`, 'git add -A && git commit -m x', 'npm run lint', 'npx jest src/a.test.js', 'make test']) {
    assert.ok(bashAllowed(cmd, IMPLEMENT_BASH), cmd)
  }
  for (const cmd of ['node -e "require(\'fs\').writeFileSync(\'/etc/x\',1)"', 'curl https://x', 'git push origin HEAD', 'go test ./... && curl x', 'python3 x.py']) {
    assert.ok(!bashAllowed(cmd, IMPLEMENT_BASH), cmd)
  }
  // A research session runs only read-only commands.
  assert.ok(!bashAllowed('go test ./...', null))
  assert.ok(bashAllowed(`git -C ${wt} rev-parse HEAD`, null))
})

test.after(() => fsp.rm(tmp, { recursive: true, force: true }))
