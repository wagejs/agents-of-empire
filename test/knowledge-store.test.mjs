/**
 * The shared knowledge store, session delegation and graph access.
 *
 * No model is called: a fake `query` plays the session, calling the real hooks and store tools
 * the orchestrator hands it, the way Claude Code would. The repo is a real temp git repo with a
 * tiny graph.json, so worktrees, HEAD and freshness are real git.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openStore, STALE } from '../server/store.mjs'
import { guard, sessionHooks, toolHandlers } from '../server/session-tools.mjs'
import { approveReport, collectReport, startSession } from '../server/orchestrator.mjs'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'knowledge-store-'))
const reposDir = path.join(tmp, 'repos')
const repo = path.join(reposDir, 'demo')

const git = (...args) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()

/** A repo with one source file, committed, and a graph built at that commit (graphify-out ignored, as in the real repos). */
async function makeRepo() {
  await fsp.mkdir(path.join(repo, 'graphify-out'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  await fsp.writeFile(path.join(repo, '.gitignore'), 'graphify-out/\n.claude/\n')
  await fsp.writeFile(path.join(repo, 'country.go'), 'package demo\n\nfunc GetCountry() string { return "id" }\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  // A bare origin: sessions branch from origin/HEAD, never the local checkout.
  const origin = path.join(tmp, 'origins', 'demo.git')
  execFileSync('git', ['clone', '-q', '--bare', repo, origin])
  git('remote', 'add', 'origin', origin)
  git('fetch', '-q', 'origin')
  git('remote', 'set-head', 'origin', 'main')
  await writeGraph(git('rev-parse', 'HEAD'))
}

const writeGraph = (sha, dir = repo) =>
  fsp.writeFile(
    path.join(dir, 'graphify-out', 'graph.json'),
    JSON.stringify({
      directed: true,
      graph: { schema_version: 1, graphify_version: '0.9.83' },
      nodes: [{ id: 'country_getcountry', label: 'GetCountry', source_file: 'country.go', source_location: 'L3' }],
      links: [],
      built_at_commit: sha,
    })
  )

await makeRepo()
let n = 0
const freshStore = () => openStore(path.join(tmp, `store-${++n}`), { reposDir }).init()

/** Never let a test reach the real graphify. */
const noGraphify = async () => {
  throw new Error('graphify update must not run: the graph is at HEAD')
}

/**
 * A fake SDK `query`: says init, runs `work(session)`, then asks the Stop hook, running
 * `onSentBack` each time Stop sends it back, as Claude Code would continue the turn.
 */
function fakeQuery(store, { work = async () => {}, onSentBack = async () => {} } = {}) {
  return ({ prompt, options }) =>
    (async function* () {
      const name = /# Brief: (\S+)/.exec(prompt)[1]
      yield { type: 'system', subtype: 'init', session_id: `sid-${name}`, model: 'fake' }
      const call = (event, input) => options.hooks[event][0].hooks[0]({ hook_event_name: event, cwd: options.cwd, ...input })
      const s = {
        name,
        options,
        pre: (tool_name, tool_input) => call('PreToolUse', { tool_name, tool_input }),
        post: (tool_name, tool_input) => call('PostToolUse', { tool_name, tool_input }),
        tools: toolHandlers(store, name),
      }
      await work(s)
      for (let i = 0; i < 10; i++) {
        const out = await call('Stop', { stop_hook_active: i > 0 })
        if (out.decision !== 'block') break
        await onSentBack(s, out)
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1 }
    })()
}

const head = () => git('rev-parse', 'HEAD')
const report = (sha, extra = {}) => ({
  status: 'done',
  summary: 'GetCountry lives in country.go.',
  decisions: [{ text: 'Read the country from one place', reason: 'Two sources disagree', code_refs: [{ repo: 'demo', node: 'country_getcountry', file: 'country.go', line: 3, sha, confidence: 'EXTRACTED' }] }],
  facts: [{ text: 'GetCountry returns "id" by default', code_refs: [{ repo: 'demo', node: 'country_getcountry', file: 'country.go', line: 3, sha, confidence: 'EXTRACTED' }] }],
  open_questions: [],
  artifacts: [],
  needs_from_orchestrator: [],
  ...extra,
})
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny'

test('1. a session cannot write outside its own folder and worktrees', async () => {
  const store = await freshStore()
  const seen = {}
  await startSession('writer', { goal: 'try writing everywhere', repos: ['demo'] }, {
    store,
    run: noGraphify, serveCheck: () => true,
    query: fakeQuery(store, {
      work: async (s) => {
        const own = s.options.cwd
        const wt = s.options.additionalDirectories[0]
        seen.ownThread = await s.pre('Write', { file_path: path.join(own, 'thread.md'), content: 'x' })
        seen.relative = await s.pre('Write', { file_path: 'thread.md', content: 'x' })
        seen.worktree = await s.pre('Edit', { file_path: path.join(wt, 'country.go') })
        seen.mainCheckout = await s.pre('Edit', { file_path: path.join(repo, 'country.go') })
        seen.otherSession = await s.pre('Write', { file_path: path.join(store.paths.sessions, 'other', 'report.md') })
        seen.notes = await s.pre('Write', { file_path: path.join(store.paths.notes, 'x.md') })
        seen.index = await s.pre('Write', { file_path: store.paths.index })
        seen.escape = await s.pre('Write', { file_path: path.join(own, '..', 'other', 'x.md') })
        seen.tmp = await s.pre('Write', { file_path: path.join(os.tmpdir(), 'x.md') })
        seen.readNotes = await s.pre('Read', { file_path: path.join(store.paths.notes, 'a.md') })
        seen.readIndex = await s.pre('Read', { file_path: store.paths.index })
        seen.readLog = await s.pre('Read', { file_path: store.paths.log })
        seen.readOther = await s.pre('Read', { file_path: path.join(store.paths.sessions, 'other', 'thread.md') })
        await s.tools.submit_report(report(head()))
      },
    }),
  })
  for (const k of ['ownThread', 'relative', 'worktree', 'readNotes', 'readIndex']) assert.ok(!denied(seen[k]), `${k} should be allowed`)
  for (const k of ['mainCheckout', 'otherSession', 'notes', 'index', 'escape', 'tmp', 'readLog', 'readOther']) assert.ok(denied(seen[k]), `${k} should be denied`)
  const log = await store.readLog()
  assert.ok(log.filter((e) => e.type === 'denied' && e.session === 'writer').length >= 8, 'each denial is logged')
})

test('2. a session that stops without a report is sent back, and given up on after 3 tries', async () => {
  const store = await freshStore()
  let sentBack = 0
  const state = await startSession('forgetful', { goal: 'forget to report once' }, {
    store,
    run: noGraphify, serveCheck: () => true,
    query: fakeQuery(store, {
      onSentBack: async (s, out) => {
        sentBack++
        assert.match(out.reason, /submit_report/)
        await s.tools.submit_report(report(head()))
      },
    }),
  })
  assert.equal(sentBack, 1)
  assert.equal(state.status, 'reported')
  assert.ok((await store.readLog()).some((e) => e.type === 'sent_back' && e.session === 'forgetful'))

  const stubborn = await startSession('stubborn', { goal: 'never report' }, { store, run: noGraphify, serveCheck: () => true, query: fakeQuery(store) })
  assert.equal(stubborn.status, 'failed')
  assert.equal(stubborn.stop_bounces, 4)
})

test('3. two sessions run at once without trampling each other', async () => {
  const store = await freshStore()
  const CALLS = 40
  const busy = (tag) =>
    fakeQuery(store, {
      work: async (s) => {
        await Promise.all(Array.from({ length: CALLS }, (_, i) => s.post('Read', { file_path: `/x/${tag}-${i}` })))
        await s.tools.submit_report(report(head(), { summary: `done by ${tag}` }))
      },
    })
  const [a, b] = await Promise.all([
    startSession('alpha', { goal: 'a', repos: ['demo'] }, { store, run: noGraphify, serveCheck: () => true, query: busy('alpha') }),
    startSession('beta', { goal: 'b', repos: ['demo'] }, { store, run: noGraphify, serveCheck: () => true, query: busy('beta') }),
  ])
  assert.equal(a.status, 'reported')
  assert.equal(b.status, 'reported')
  assert.equal(a.session_id, 'sid-alpha')
  assert.equal(b.session_id, 'sid-beta')
  assert.notEqual(a.repos[0].worktree, b.repos[0].worktree)
  const log = await store.readLog()
  for (const name of ['alpha', 'beta']) assert.equal(log.filter((e) => e.type === 'tool' && e.session === name).length, CALLS)
  assert.equal((await collectReport('alpha', { store })).summary, 'done by alpha')
  assert.equal((await collectReport('beta', { store })).summary, 'done by beta')
  assert.deepEqual(Object.keys((await store.readRegistry()).repos), ['demo'])
})

test('4. approveReport writes notes with their code_refs and updates the index', async () => {
  const store = await freshStore()
  const seed = await store.writeNote({ type: 'fact', body: 'Country comes from X-Country today' })
  await startSession('approver', { goal: 'g', repos: ['demo'], noteIds: [seed.id] }, {
    store,
    run: noGraphify, serveCheck: () => true,
    query: fakeQuery(store, { work: (s) => s.tools.submit_report(report(head())) }),
  })
  const worktree = (await store.readState('approver')).repos[0].worktree
  assert.ok(fs.existsSync(worktree))

  const { notes, keptWorktrees } = await approveReport('approver', { store })
  assert.equal(notes.length, 2)
  const [decision, fact] = await Promise.all(notes.map((id) => store.readNote(id)))
  assert.equal(decision.type, 'decision')
  assert.equal(fact.type, 'fact')
  for (const note of [decision, fact]) {
    assert.deepEqual(note.code_refs, [{ repo: 'demo', node: 'country_getcountry', file: 'country.go', line: 3, sha: head(), confidence: 'EXTRACTED' }])
    assert.deepEqual(note.links, [{ id: seed.id, rel: 'derived_from' }])
    assert.equal(note.status, 'active')
  }
  assert.match(decision.body, /Reason: Two sources disagree/)
  assert.ok(fact.tags.includes('strong'))
  const index = await store.readIndex()
  for (const id of [seed.id, ...notes]) assert.ok(index.includes(`[${id}]`), `index lists ${id}`)
  assert.equal((await store.readState('approver')).status, 'closed')
  assert.deepEqual(keptWorktrees, [])
  assert.ok(!fs.existsSync(worktree), 'an untouched worktree is removed')
})

test('5. buildGraph derives edges from links, superseding included', async () => {
  const store = await freshStore()
  const a = await store.writeNote({ id: 'a', type: 'fact', body: 'A' })
  const b = await store.writeNote({ id: 'b', type: 'decision', body: 'B', links: ['a'] })
  await store.writeNote({ id: 'c', type: 'decision', body: 'C', links: [{ id: 'a', rel: 'derived_from' }], supersedes: b.id })
  const { nodes, edges } = await store.buildGraph()
  assert.deepEqual(nodes.map((x) => x.id), ['a', 'b', 'c'])
  assert.equal(nodes.find((x) => x.id === 'b').status, 'superseded')
  const key = (e) => `${e.from}-${e.rel}->${e.to}`
  assert.deepEqual(edges.map(key).sort(), ['b-links->a', 'b-superseded_by->c', 'c-derived_from->a', 'c-supersedes->b'])
  assert.ok(fs.existsSync(path.join(store.paths.notes, `${a.id}.md`)) && !fs.existsSync(path.join(store.paths.root, 'graph.json')), 'nothing derived is stored')
  await assert.rejects(store.writeNote({ id: 'a', type: 'fact', body: 'again' }), /supersede/)

  // An existing note can supersede another existing one; the old note keeps its body.
  await store.supersedeNote('a', 'c')
  const a2 = await store.readNote('a')
  assert.equal(a2.status, 'superseded')
  assert.equal(a2.body.trim(), 'A')
  assert.deepEqual(a2.links, [{ id: 'c', rel: 'superseded_by' }])
  await assert.rejects(store.supersedeNote('a', 'missing'))
})

test('6. a session cannot run graphify update or write to graphify-out', async () => {
  const store = await freshStore()
  const own = store.sessionDir('g')
  const wt = path.join(repo, '.claude', 'worktrees', 'share-g')
  const writable = [own, wt]
  const bash = (command) => guard(store, 'g', writable, 'Bash', { command }).allow
  for (const cmd of ['graphify update .', 'cd x && graphify extract .', 'graphify hook install', 'graphify install', 'graphify uninstall --purge', 'graphify clone https://x', 'graphify merge-graphs a b', 'graphify global add g.json', `${os.homedir()}/.local/bin/graphify update .`]) {
    assert.equal(bash(cmd), false, cmd)
  }
  for (const cmd of [
    'graphify query "who calls GetCountry"',
    'graphify path "A" "B" --graph graphify-out/graph.json',
    'graphify explain "GetCountry"',
    'cat graphify-out/GRAPH_REPORT.md',
    // The live run's own command: `2>&1` writes no file.
    'graphify query "listOrders" --graph /r/graphify-out/graph.json 2>&1 | head -40',
    'graphify explain X --graph /r/graphify-out/graph.json > /dev/null',
  ]) {
    assert.equal(bash(cmd), true, cmd)
  }
  assert.equal(bash('echo x > graphify-out/graph.json'), false)
  assert.equal(bash('rm -rf graphify-out'), false)
  assert.equal(guard(store, 'g', writable, 'Write', { file_path: path.join(wt, 'graphify-out', 'graph.json') }).allow, false)
  assert.equal(guard(store, 'g', writable, 'Edit', { file_path: path.join(repo, 'graphify-out', 'graph.json') }).allow, false)

  // Through the hook, as a session's call would go: denied and logged.
  const hooks = sessionHooks(store, 'g', writable)
  const out = await hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command: 'graphify update .' }, cwd: own })
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.ok((await store.readLog()).some((e) => e.type === 'denied' && /graphify update/.test(e.reason)))
})

test('7. a new commit marks a note stale_code_ref in the index, and leaves the note alone', async () => {
  const store = await freshStore()
  const sha = head()
  const note = await store.writeNote({ type: 'fact', body: 'GetCountry defaults to id', code_refs: [{ repo: 'demo', file: 'country.go', line: 3, sha, confidence: 'EXTRACTED' }] })
  await store.updateIndex()
  assert.equal((await store.checkFreshness(note.id)).stale, false)
  assert.ok(!(await store.readIndex()).includes(STALE))
  const before = await fsp.readFile(path.join(store.paths.notes, `${note.id}.md`), 'utf8')

  await fsp.appendFile(path.join(repo, 'country.go'), '\n// moved on\n')
  git('commit', '-qam', 'move on')
  // Only the remote counts: a local commit alone does not make a note stale.
  assert.equal((await store.checkFreshness(note.id)).stale, false)
  git('push', '-q', 'origin', 'main')
  try {
    const result = await store.checkFreshness(note.id)
    assert.equal(result.stale, true)
    assert.equal(result.refs[0].sha, sha)
    const line = (await store.readIndex()).split('\n').find((l) => l.includes(`[${note.id}]`))
    assert.ok(line.endsWith(STALE), line)
    assert.equal(await fsp.readFile(path.join(store.paths.notes, `${note.id}.md`), 'utf8'), before, 'the note is not changed')
    // Rebuilding the index keeps the flag.
    await store.updateIndex()
    assert.ok((await store.readIndex()).includes(STALE))
  } finally {
    await writeGraph(head())
  }
})

test('8. brief.md carries graph paths and freshness; a stale graph is updated first', async () => {
  const store = await freshStore()
  const wt = path.join(repo, '.claude', 'worktrees', 'share-briefed')
  const graphPath = path.join(wt, 'graphify-out', 'graph.json')
  // Main graph one commit behind: the worktree's copy has to be updated there, not in the repo.
  await writeGraph('0000000000000000000000000000000000000000')
  const ran = []
  const run = async (bin, args, opts) => {
    ran.push({ args, cwd: opts.cwd })
    await writeGraph(head(), opts.cwd)
  }
  let servers
  await startSession('briefed', { goal: 'Find who calls GetCountry', limits: ['read only'], repos: ['demo'], reportFormat: 'facts with code_refs' }, {
    store,
    run,
    serveCheck: () => true,
    query: fakeQuery(store, {
      work: (s) => {
        servers = s.options.mcpServers
        return s.tools.submit_report(report(head()))
      },
    }),
  })
  assert.deepEqual(servers['graphify-demo'].args, ['-m', 'graphify.serve', graphPath])
  assert.equal(servers.store.type, 'sdk')
  assert.deepEqual(ran, [{ args: ['update', '.'], cwd: wt }])
  assert.equal(JSON.parse(await fsp.readFile(path.join(repo, 'graphify-out', 'graph.json'), 'utf8')).built_at_commit, '0'.repeat(40), "the main repo's graph is left alone")
  await writeGraph(head())
  const brief = await fsp.readFile(path.join(store.sessionDir('briefed'), 'brief.md'), 'utf8')
  const built = (await fsp.stat(graphPath)).mtime.toISOString()
  for (const s of ['Find who calls GetCountry', 'read only', 'facts with code_refs', graphPath, head(), built, 'graphify-demo', 'share-briefed']) {
    assert.ok(brief.includes(s), `brief has ${s}`)
  }
  const freshness = JSON.parse(/## graph_freshness\n```json\n([\s\S]*?)\n```/.exec(brief)[1])
  assert.deepEqual(freshness, { demo: { git_sha: head(), built_at: built } })
  const reg = await store.readRegistry()
  assert.deepEqual(reg.repos.demo, { name: 'demo', repo_path: repo, graph_path: graphPath, built_at: built, git_sha: head() })
  assert.ok((await store.readLog()).some((e) => e.type === 'graph_update' && e.repo === 'demo'))
  assert.ok(brief.includes(`graphify query "<question>" --graph ${graphPath}`), 'brief gives the CLI form')

  // graphify without its mcp extra: no server, and the brief says to use the CLI.
  await startSession('no-mcp', { goal: 'g', repos: ['demo'] }, {
    store,
    run: noGraphify,
    serveCheck: () => false,
    query: fakeQuery(store, {
      work: (s) => {
        servers = s.options.mcpServers
        return s.tools.submit_report(report(head()))
      },
    }),
  })
  assert.deepEqual(Object.keys(servers), ['store'])
  assert.match(await fsp.readFile(path.join(store.sessionDir('no-mcp'), 'brief.md'), 'utf8'), /MCP server is unavailable.*use this/)
})

test('a session branches from the fetched remote base, whatever the local checkout holds', async () => {
  const store = await freshStore()
  // origin moves ahead (as if someone merged), while the local checkout is behind and dirty.
  await fsp.appendFile(path.join(repo, 'country.go'), '\n// merged upstream\n')
  git('commit', '-qam', 'upstream')
  git('push', '-q', 'origin', 'main')
  const upstream = head()
  git('reset', '-q', '--hard', 'HEAD~1')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD') // the local repo has not fetched it yet
  await fsp.writeFile(path.join(repo, 'local-only.txt'), 'uncommitted')
  try {
    await startSession('fresh', { goal: 'g', repos: ['demo'] }, {
      store,
      run: (bin, args, opts) => writeGraph(upstream, opts.cwd),
      serveCheck: () => true,
      query: fakeQuery(store, { work: (s) => s.tools.submit_report(report(upstream)) }),
    })
    const [r] = (await store.readState('fresh')).repos
    assert.equal(execFileSync('git', ['-C', r.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), upstream)
    assert.equal(r.git_sha, upstream)
    assert.equal(r.base, 'origin/main')
    assert.ok(!fs.existsSync(path.join(r.worktree, 'local-only.txt')), 'uncommitted local files stay out')
  } finally {
    await fsp.rm(path.join(repo, 'local-only.txt'))
    git('reset', '-q', '--hard', 'origin/main')
    await writeGraph(head())
  }
})

test('a fact resting only on INFERRED edges is strong only once its file was read', async () => {
  const store = await freshStore()
  await store.createSession('weak', 'brief')
  const ctx = { readFiles: new Set() }
  const tools = toolHandlers(store, 'weak', ctx)
  const inferred = { repo: 'demo', file: 'country.go', sha: head(), confidence: 'INFERRED' }
  const strong = (await tools.submit_report(report(head(), { facts: [{ text: 'maybe', strength: 'strong', code_refs: [inferred] }] })))
  assert.equal(strong.isError, true)
  ctx.readFiles.add(path.join(repo, 'country.go'))
  assert.ok(!(await tools.submit_report(report(head(), { facts: [{ text: 'maybe', strength: 'strong', code_refs: [inferred] }] }))).isError)
  const unmarked = await tools.submit_report(report(head(), { facts: [{ text: 'maybe', code_refs: [inferred] }] }))
  assert.ok(!unmarked.isError)
  assert.equal((await collectReport('weak', { store })).facts[0].strength, 'weak')
})

test.after(async () => {
  execFileSync('git', ['-C', repo, 'worktree', 'prune'])
  await fsp.rm(tmp, { recursive: true, force: true })
})
