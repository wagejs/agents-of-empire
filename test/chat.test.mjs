/**
 * Chat: what the popup shows of a thread, and when the server refuses to send into one.
 *
 * Fixture-driven. The SDK run itself is not exercised: it would resume a real session against a
 * real model, and every refusal tested here happens before it starts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { withServer } from './support/with-server.mjs'

const SESSION_ID = '0f0e0d0c-1111-4222-8333-444455556666'
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-fixture-'))
const configDir = path.join(root, 'claude')
const project = path.join(configDir, 'projects', '-tmp-demo')
const registry = path.join(configDir, 'sessions', `${process.pid}.json`)
await fsp.mkdir(project, { recursive: true })
await fsp.mkdir(path.dirname(registry), { recursive: true })

const transcript = [
  { type: 'user', cwd: root, message: { role: 'user', content: '<system-reminder>context</system-reminder>fix the bug\nplease' } },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'injected by the CLI' } },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Looking.' }] } },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] } },
  { type: 'user', isSidechain: true, message: { role: 'user', content: 'a subagent brief' } },
  { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Done.' }] } },
  { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
]
await fsp.writeFile(path.join(project, `${SESSION_ID}.jsonl`), transcript.map((r) => JSON.stringify(r)).join('\n') + '\n')

// The adapter reads its paths once, on first import, and the server shares that import.
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.BOT_CROSSING_CLAUDE_DESKTOP = path.join(root, 'no-desktop-app')
const { default: claudeCode } = await import('../server/harnesses/claude-code.mjs')
const { activeRun, alwaysRule, answerPermission, attachRun, chatStatus, eventsOf, getRun, modeOf, queueMessage, setRunMode, settledBy, startRun, stopRun } = await import('../server/chat.mjs')

const ref = { cliSessionId: SESSION_ID, cwd: root }
const register = (fields) =>
  fsp.writeFile(registry, JSON.stringify({ pid: process.pid, sessionId: SESSION_ID, ...fields }))

test.after(() => fsp.rm(root, { recursive: true, force: true }))

test('the popup sees what was said, one message per reply, without the noise around it', async () => {
  const { ok, messages } = await claudeCode.readMessages(ref)
  assert.equal(ok, true)
  assert.deepEqual(messages, [
    { role: 'user', text: 'fix the bug\nplease', tools: [] },
    { role: 'assistant', text: 'Looking.', tools: [{ name: 'Bash', summary: 'ls' }] },
    { role: 'assistant', text: 'Done.', tools: [] },
  ])
})

test('an id from the page is never turned into a path unless it is a session id', async () => {
  for (const cliSessionId of ['../claude/projects', [SESSION_ID], '']) {
    assert.equal((await claudeCode.readMessages({ cliSessionId })).ok, false)
    assert.equal((await claudeCode.chatTarget({ cliSessionId })).ok, false)
  }
})

test('a thread with a transcript can be chatted with', async () => {
  const [thread] = await claudeCode.scanThreads()
  assert.equal(thread.canChat, true)
})

test('a thread started from the page is the one the scan finds afterwards', async () => {
  const { newChatThread } = await import('../server/harnesses/claude-code.mjs')
  const started = newChatThread(SESSION_ID, root)
  const [scanned] = await claudeCode.scanThreads()
  assert.equal(started.id, scanned.id)
  assert.equal(started.ref.cliSessionId, scanned.ref.cliSessionId)
  // And it can be talked to straight away, before any scan has seen it.
  assert.equal((await claudeCode.chatTarget(started.ref)).ok, true)
})

test('a live process makes the thread busy only while it is mid-turn', async () => {
  await fsp.rm(registry, { force: true })
  assert.deepEqual(
    { ...(await claudeCode.chatTarget(ref)), bin: null },
    { ok: true, sessionId: SESSION_ID, cwd: root, bin: null, live: false, busy: false, where: '' }
  )

  await register({ status: 'idle', entrypoint: 'claude-desktop' })
  const idle = await claudeCode.chatTarget(ref)
  assert.deepEqual([idle.live, idle.busy, idle.where], [true, false, 'the Claude app'])

  await register({ status: 'busy', entrypoint: 'cli' })
  const busy = await claudeCode.chatTarget(ref)
  assert.deepEqual([busy.live, busy.busy, busy.where], [true, true, 'a terminal'])
  await fsp.rm(registry, { force: true })
})

test('a reply streams token by token, and a streamed block is never sent a second time', () => {
  const block = { streamed: false }
  const stream = (event, parent = null) => ({ type: 'stream_event', event, parent_tool_use_id: parent })
  const delta = (text) => stream({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
  const said = (content) => ({ type: 'assistant', parent_tool_use_id: null, message: { content } })
  const events = [
    stream({ type: 'content_block_start' }),
    delta('Hel'),
    delta('lo'),
    said([{ type: 'text', text: 'Hello' }]),
    stream({ type: 'content_block_start' }),
    said([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
    stream({ type: 'content_block_start' }),
    delta('Next'),
    said([{ type: 'text', text: 'Next' }]),
    // An API error comes back as a whole assistant message that was never streamed.
    said([{ type: 'text', text: 'API Error: overloaded' }]),
    // Whatever streams after it starts its own paragraph.
    delta('Retrying'),
    { ...delta('inside a subagent'), parent_tool_use_id: 'toolu_1' },
    { type: 'result', is_error: false, total_cost_usd: 0.01 },
  ].flatMap((msg) => eventsOf(msg, block))

  assert.deepEqual(events.slice(0, 6), [
    { type: 'delta', text: 'Hel', fresh: true },
    { type: 'delta', text: 'lo', fresh: false },
    { type: 'tool', name: 'Bash', summary: 'ls' },
    { type: 'delta', text: 'Next', fresh: true },
    { type: 'text', text: 'API Error: overloaded' },
    { type: 'delta', text: 'Retrying', fresh: true },
  ])
  assert.deepEqual(events.slice(6), [{ type: 'done', ok: true, error: undefined, cost: 0.01 }])
})

test('"Always allow" saves only the allow rules Claude Code suggested, to the project', () => {
  const rules = [{ toolName: 'Bash', ruleContent: 'touch:*' }, { toolName: 'Read' }]
  const always = alwaysRule([
    { type: 'addRules', behavior: 'allow', destination: 'session', rules },
    { type: 'addRules', behavior: 'deny', destination: 'session', rules: [{ toolName: 'Write' }] },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addDirectories', directories: ['/'], destination: 'session' },
  ])
  assert.equal(always.label, 'Bash(touch:*), Read')
  assert.deepEqual(always.updates, [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules }])
  // Nothing suggested, nothing offered: the page hides the button on an empty label.
  assert.deepEqual(alwaysRule(undefined), { label: '', updates: [] })
})

// ── replies that outlive the page ────────────────────────────────────────────

const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
}
const THREAD_ID = `claude-code:${SESSION_ID}`
const streamed = (text) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const said = (text) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } })

test('a reply runs on the server: a page can leave mid-way, and one arriving later sees all of it', async () => {
  // Stands in for the SDK: streams a word, asks to run a tool, then reports what it was told.
  const query = ({ options }) =>
    (async function* () {
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start' } }
      yield streamed('Hel')
      yield streamed('lo')
      yield said('Hello')
      const decision = await options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [] })
      yield said(`after ${decision.behavior}`)
      yield { type: 'result', is_error: false, total_cost_usd: 0 }
    })()
  const run = startRun({ sessionId: SESSION_ID, cwd: root, threadId: THREAD_ID }, 'hi', { query })

  const first = []
  const leave = attachRun(run, 0, (event) => first.push(event), () => {})
  await until(() => run.pending.size === 1)
  assert.equal(activeRun(SESSION_ID), run)
  assert.equal(chatStatus(THREAD_ID), 'approval')
  leave() // the popup moves to another thread: the reply must not stop

  const [permission] = run.events.filter((e) => e.type === 'permission')
  assert.equal(answerPermission(permission.id, 'allow'), true)
  await until(() => run.done)

  const late = []
  let ended = false
  attachRun(run, 0, (event) => late.push(event), () => (ended = true))
  assert.equal(ended, true)
  assert.deepEqual(late.map((e) => e.type), ['delta', 'delta', 'permission', 'answered', 'text', 'done'])
  assert.equal(late.find((e) => e.type === 'text').text, 'after allow')
  assert.deepEqual(first.map((e) => e.type), ['delta', 'delta', 'permission'])
  // Picking up mid-way, as a reconnect does, gives only what was missed.
  const rest = []
  attachRun(run, 4, (event) => rest.push(event.type), () => {})
  assert.deepEqual(rest, ['text', 'done'])
  assert.equal(chatStatus(THREAD_ID), '')
  assert.equal(activeRun(SESSION_ID), null)
})

test('messages sent while Claude works go straight into the same session, without waiting for it', async () => {
  const seen = []
  let release
  const query = ({ prompt }) =>
    (async function* () {
      const messages = prompt[Symbol.asyncIterator]()
      seen.push((await messages.next()).value.message.content)
      await new Promise((resolve) => (release = resolve))
      // Mid-reply, what you typed is already there for Claude Code to take in.
      seen.push((await messages.next()).value.message.content, (await messages.next()).value.message.content)
      yield said('done all three')
      yield { type: 'result', is_error: false, total_cost_usd: 0 }
    })()
  const run = startRun({ sessionId: SESSION_ID, cwd: root, threadId: THREAD_ID }, 'build it', { query })
  await until(() => release)
  assert.ok(queueMessage(run, 'also add tests'))
  assert.ok(queueMessage(run, 'and docs'))
  release()
  await until(() => run.done)
  assert.deepEqual(seen, ['build it', 'also add tests', 'and docs'])
  assert.deepEqual(run.events.map((e) => e.type), ['queued', 'queued', 'taken', 'taken', 'text', 'done'])
})

test('a reply stays open while its subagents run, and their results arrive as the next turn', async () => {
  let inputEnded = false
  let finishAgent
  const query = ({ prompt }) =>
    (async function* () {
      const messages = prompt[Symbol.asyncIterator]()
      await messages.next()
      // Ends its turn with a subagent still running in the background.
      yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', task_type: 'local_agent', description: 'x' }] }
      yield said('Agent running')
      yield { type: 'result', is_error: false, total_cost_usd: 0 }
      await new Promise((resolve) => (finishAgent = resolve))
      // It finishes: Claude Code reports that, then answers with what it found.
      yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] }
      yield said('Agent says done')
      yield { type: 'result', is_error: false, total_cost_usd: 0 }
      inputEnded = (await messages.next()).done
    })()
  const run = startRun({ sessionId: SESSION_ID, cwd: root, threadId: THREAD_ID }, 'go', { query })
  await until(() => finishAgent)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(run.done, false) // not cut off at the end of the first turn
  assert.equal(chatStatus(THREAD_ID), 'running')
  finishAgent()
  await until(() => run.done)
  assert.deepEqual(run.events.map((e) => e.type), ['text', 'note', 'text', 'done'])
  assert.equal(run.events[2].text, 'Agent says done')
  assert.equal(inputEnded, true) // and once nothing is left running, the session is let go
})

test("Claude's questions reach the page, and the answers go back the way AskUserQuestion takes them", async () => {
  const questions = [
    { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: '' }, { label: 'MySQL', description: '' }] },
  ]
  const decisions = []
  const query = ({ options }) =>
    (async function* () {
      for (let round = 0; round < 2; round++) {
        decisions.push(await options.canUseTool('AskUserQuestion', { questions }, { signal: new AbortController().signal }))
      }
      yield { type: 'result', is_error: false, total_cost_usd: 0 }
    })()
  const run = startRun({ sessionId: SESSION_ID, cwd: root, threadId: THREAD_ID }, 'hi', { query })

  await until(() => run.events.filter((e) => e.type === 'question').length === 1)
  assert.equal(chatStatus(THREAD_ID), 'approval') // its bot raises its hand while a question waits
  const [first] = run.events.filter((e) => e.type === 'question')
  assert.deepEqual(first.questions, questions)
  // Answers for questions nobody asked are dropped on the way back.
  assert.equal(answerPermission(first.id, 'answer', { 'Which database?': ' Postgres ', 'Injected?': 'yes' }), true)

  await until(() => run.events.filter((e) => e.type === 'question').length === 2)
  const second = run.events.filter((e) => e.type === 'question')[1]
  answerPermission(second.id, 'deny')
  await until(() => run.done)

  assert.deepEqual(decisions[0], { behavior: 'allow', updatedInput: { questions, answers: { 'Which database?': 'Postgres' } } })
  assert.equal(decisions[1].behavior, 'deny')
  assert.deepEqual(run.events.filter((e) => e.type === 'answered').map((e) => e.choice), ['answer', 'deny'])
})

test('a chat runs in the mode you picked, and switching mid-reply settles what is already waiting', async () => {
  const switched = []
  let started
  const answers = []
  const query = ({ options }) => {
    started = options.permissionMode
    const stream = (async function* () {
      const ask = (name) => options.canUseTool(name, { file_path: '/tmp/x' }, { signal: new AbortController().signal })
      // Two waiting at once: an edit, and a shell command.
      const edit = ask('Edit').then((r) => answers.push(['Edit', r.behavior]))
      const bash = ask('Bash').then((r) => answers.push(['Bash', r.behavior]))
      await edit
      await bash
      yield { type: 'result', is_error: false, total_cost_usd: 0 }
    })()
    stream.setPermissionMode = async (mode) => switched.push(mode)
    return stream
  }
  const run = startRun({ sessionId: SESSION_ID, cwd: root, threadId: THREAD_ID, mode: 'plan' }, 'look first', { query })
  await until(() => run.pending.size === 2)
  assert.equal(started, 'plan')
  // Auto-edit lets the edit through and leaves the command with you…
  assert.equal(await setRunMode(run.id, 'acceptEdits'), true)
  await until(() => answers.length === 1)
  assert.deepEqual(answers, [['Edit', 'allow']])
  assert.equal(run.pending.size, 1)
  // …and Allow all lets the rest go.
  await setRunMode(run.id, 'bypassPermissions')
  await until(() => run.done)
  assert.deepEqual(answers, [['Edit', 'allow'], ['Bash', 'allow']])
  assert.deepEqual(switched, ['acceptEdits', 'bypassPermissions'])
  assert.equal(await setRunMode(run.id, 'plan'), false) // finished: nothing to switch
  assert.equal(modeOf('rm -rf'), 'default')
  assert.equal(settledBy('dontAsk', 'Bash'), 'deny')
  assert.equal(settledBy('default', 'Bash'), '')
})

test('Stop ends a reply and turns down the approval it was waiting on', async () => {
  const query = ({ options }) =>
    (async function* () {
      const aborted = new Promise((_, reject) =>
        options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')))
      )
      yield* []
      await Promise.race([options.canUseTool('Write', { file_path: '/tmp/x' }, { signal: new AbortController().signal }), aborted])
    })()
  const run = startRun({ sessionId: SESSION_ID, cwd: root, threadId: THREAD_ID }, 'hi', { query })
  await until(() => run.pending.size === 1)
  assert.equal(stopRun(run.id), true)
  await until(() => run.done)
  assert.deepEqual(run.events.map((e) => e.type), ['permission', 'answered', 'done'])
  assert.equal(run.events[1].choice, 'deny')
  assert.equal(run.events[2].error, 'Stopped')
  assert.equal(stopRun(run.id), false)
})

test('a thread is working only while its process says it is busy', async () => {
  // The fixture's transcript ends on your message, the shape a reply cut off before answering
  // leaves behind. With the process idle that is not work in progress.
  await register({ status: 'idle', entrypoint: 'claude-desktop' })
  assert.equal((await claudeCode.scanThreads())[0].running, false)
  await register({ status: 'busy', entrypoint: 'claude-desktop' })
  assert.equal((await claudeCode.scanThreads())[0].running, true)
  await fsp.rm(registry, { force: true })
})

test('the chat routes read the thread and refuse what they cannot send', async () => {
  await withServer(async ({ call }) => {
    const post = (p, body) => call(p, { method: 'POST', body: JSON.stringify(body) })

    const read = await post('/api/chat/messages', { harness: 'claude-code', ref })
    assert.equal(read.status, 200)
    const body = await read.json()
    assert.equal(body.messages.length, 3)
    assert.equal(body.busy, false)

    const empty = await post('/api/chat/send', { harness: 'claude-code', ref, text: '   ' })
    assert.equal(empty.status, 400)

    // A new thread needs something to say and somewhere real to say it.
    assert.equal((await post('/api/chat/new', { folder: root, text: '' })).status, 400)
    assert.equal((await post('/api/chat/new', { folder: path.join(root, 'gone'), text: 'hi' })).status, 400)
    assert.equal((await post('/api/chat/new', { folder: 'relative/path', text: 'hi' })).status, 400)

    await register({ status: 'busy', entrypoint: 'cli' })
    const busy = await post('/api/chat/send', { harness: 'claude-code', ref, text: 'hello' })
    assert.equal(busy.status, 409)
    assert.match((await busy.json()).error, /mid-turn in a terminal/)
    await fsp.rm(registry, { force: true })

    const stale = await post('/api/chat/permission', { id: 'nothing-waiting', choice: 'allow' })
    assert.equal(stale.status, 404)
    assert.equal((await post('/api/chat/attach', { runId: 'no-such-run' })).status, 404)
    assert.equal((await post('/api/chat/stop', { runId: 'no-such-run' })).status, 404)
  })
})

test('renaming writes Claude Code its own custom title, which the scan then reads', async () => {
  await withServer(async ({ call }) => {
    const post = (body) => call('/api/chat/rename', { method: 'POST', body: JSON.stringify(body) })
    assert.equal((await post({ harness: 'claude-code', ref, title: '  ' })).status, 400)
    assert.equal((await post({ harness: 'claude-code', ref, title: 'x'.repeat(201) })).status, 400)
    assert.equal((await post({ harness: 'claude-code', ref: { cliSessionId: '../x' }, title: 'Nope' })).status, 400)

    const renamed = await post({ harness: 'claude-code', ref, title: '  Auth rewrite  ' })
    assert.equal(renamed.status, 200)
    const records = (await fsp.readFile(path.join(project, `${SESSION_ID}.jsonl`), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(records.at(-1).customTitle, 'Auth rewrite')
    const [thread] = await claudeCode.scanThreads()
    assert.equal(thread.title, 'Auth rewrite')
  })
})

test('a session with a schedule is kept between ticks, and takes messages straight away', async () => {
  const seen = []
  const query = ({ prompt, options }) =>
    (async function* () {
      const messages = prompt[Symbol.asyncIterator]()
      const stop = options.hooks.Stop[0].hooks[0]
      for (;;) {
        const next = await messages.next()
        if (next.done) return
        seen.push(next.value.message.content)
        yield said(`ok ${next.value.message.content}`)
        // The skill schedules itself on its first turn and clears it when told to stop.
        await stop({ session_crons: seen.at(-1) === 'stop' ? [] : [{ id: 'c1', schedule: '7 8 * * 1-5', recurring: true, prompt: '/pr-watch tick' }] })
        yield { type: 'result', is_error: false, total_cost_usd: 0 }
      }
    })()
  const run = startRun({ sessionId: SESSION_ID, cwd: root, threadId: THREAD_ID }, '/pr-watch', { query })
  await until(() => run.scheduled)
  assert.equal(run.done, false)
  assert.equal(chatStatus(THREAD_ID), '')
  assert.ok(queueMessage(run, 'stop'))
  await until(() => run.done)
  assert.deepEqual(seen, ['/pr-watch', 'stop'])
  assert.equal(run.events.at(-1).type, 'done')
})

test('a plan waits for you: approved into the mode you pick, or sent back with what to change', async () => {
  const outcomes = []
  const modes = []
  const query = ({ options }) => {
    const stream = (async function* () {
      const plan = (text) => options.canUseTool('ExitPlanMode', { plan: text }, { signal: new AbortController().signal })
      outcomes.push(await plan('# First go'))
      outcomes.push(await plan('# Second go'))
      yield { type: 'result', is_error: false, total_cost_usd: 0 }
    })()
    stream.setPermissionMode = async (mode) => modes.push(mode)
    return stream
  }
  const run = startRun({ sessionId: SESSION_ID, cwd: root, threadId: THREAD_ID, mode: 'plan' }, 'plan it', { query })
  await until(() => run.events.some((e) => e.type === 'plan'))
  assert.equal(run.events.find((e) => e.type === 'plan').plan, '# First go')
  assert.equal(chatStatus(THREAD_ID), 'approval') // the bot needs you while it waits
  // Switching mode never approves a plan for you.
  await setRunMode(run.id, 'bypassPermissions')
  assert.equal(run.pending.size, 1)
  const first = run.events.find((e) => e.type === 'plan').id
  assert.ok(answerPermission(first, 'keep', 'split step 2 in two'))
  await until(() => run.events.filter((e) => e.type === 'plan').length === 2)
  const second = run.events.filter((e) => e.type === 'plan')[1].id
  assert.ok(answerPermission(second, 'acceptEdits'))
  await until(() => run.done)
  assert.equal(outcomes[0].behavior, 'deny')
  assert.match(outcomes[0].message, /split step 2 in two/)
  assert.equal(outcomes[1].behavior, 'allow')
  assert.equal(run.mode, 'acceptEdits')
  assert.deepEqual(modes, ['bypassPermissions', 'acceptEdits'])
})
