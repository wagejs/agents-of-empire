/**
 * Talking to a Claude Code thread from the page, through the Agent SDK.
 *
 * The one place a thread grows because of Bot Crossing: the SDK resumes the session and Claude
 * Code appends the turn to its own transcript, exactly as if it had been typed in a terminal.
 * Nothing here touches a harness file itself.
 *
 * A reply is a *run* held here, not by the page. It keeps every event it has produced, and a page
 * watches it by attaching: from the start, or from wherever it left off. So switching the popup
 * to another thread, closing it, or reloading the page only stops the watching; the reply goes
 * on, and whoever attaches next sees all of it. Only Stop, or the run finishing, ends one.
 *
 * A tool approval crosses HTTP twice. The run records a `permission` event and waits; the page
 * answers on a second request, which resolves the wait and records an `answered` event, so a
 * page attaching later knows the card is settled.
 */
import { randomUUID } from 'node:crypto'
import { query as sdkQuery, renameSession } from '@anthropic-ai/claude-agent-sdk'
import { cliBinary, newChatThread, toolSummary } from './harnesses/claude-code.mjs'

/**
 * Runs and waiting approvals, on `globalThis` so they outlive this module. The dev server
 * re-imports it whenever a server file changes, and a run started under the old copy is still
 * going: a fresh, empty registry would leave it running where no page can ever find it again.
 */
const shared = (globalThis[Symbol.for('bot-crossing.chat')] ??= { runs: new Map(), pending: new Map() })
const { runs, pending } = shared

/**
 * Extra SDK options some sessions always run with, whoever sends to them: the orchestrator's
 * tools, say. Each provider answers for a session id, or with nothing; keyed by name so the dev
 * server re-importing a provider replaces it rather than adding a second.
 */
const extras = (shared.extras ??= new Map())
export const provideSessionOptions = (name, forSession) => extras.set(name, forSession)
const extraOptions = (target) =>
  Object.assign({}, ...[...extras.values()].map((forSession) => (target.sessionId && forSession(target.sessionId)) || {}), target.options)

/** How long a finished run stays attachable, so a page that reloads just then still sees how it ended. */
const KEEP_FINISHED_MS = 60_000

const record = (run, event) => {
  run.events.push(event)
  for (const listen of run.listeners) listen(event)
}

/** The run still going for a session, if there is one. */
export const activeRun = (sessionId) =>
  [...runs.values()].find((run) => !run.done && sessionId && run.sessionId === sessionId) || null

export const getRun = (runId) => runs.get(runId) || null

/**
 * What a thread's chat is doing, for the map: waiting on an approval, working, or nothing. A
 * session kept for its schedule is nothing between ticks, so the bot is not shown busy all day.
 */
export function chatStatus(threadId) {
  const run = [...runs.values()].find((r) => !r.done && r.threadId === threadId)
  if (!run) return ''
  return run.pending.size ? 'approval' : run.scheduled ? '' : 'running'
}

/** The sessions being kept for their schedules, for the page to list. */
export const scheduledRuns = () =>
  [...runs.values()].filter((r) => !r.done && r.crons?.length).map((r) => ({ runId: r.id, threadId: r.threadId, crons: r.crons }))

/**
 * Watch a run: every event from index `from` on, then each new one as it happens, then `end`
 * once it has finished. Returns the way to stop watching, which leaves the run alone.
 */
export function attachRun(run, from, write, end) {
  for (const event of run.events.slice(Math.max(0, from))) write(event)
  if (run.done) {
    end()
    return () => {}
  }
  const listen = (event) => {
    write(event)
    if (event.type === 'done') end()
  }
  run.listeners.add(listen)
  return () => run.listeners.delete(listen)
}

/**
 * Hold a message for when the running reply finishes. False for a run started by an older copy
 * of this module, from before replies kept a queue: nothing would ever send what it held.
 */
export function queueMessage(run, text) {
  // Straight into the open session, as typing into a terminal mid-reply is: Claude Code takes
  // it in at its next step, without the reply having to finish or be stopped first.
  if (run.inbox?.push(text)) {
    record(run, { type: 'queued', text })
    return true
  }
  if (!Array.isArray(run.queue)) return false
  run.queue.push(text)
  record(run, { type: 'queued', text })
  return true
}

export function stopRun(runId) {
  const run = runs.get(runId)
  if (!run || run.done) return false
  run.abort.abort()
  return true
}

/**
 * Answer a waiting tool call with `allow`, `always` or `deny`; anything else denies. False when
 * nothing is waiting under that id any more.
 */
export function answerPermission(id, choice, answers) {
  const waiting = pending.get(id)
  if (!waiting) return false
  pending.delete(id)
  waiting.run.pending.delete(id)
  // A plan is approved, with how edits go from here, or sent back with what to change.
  if (waiting.plan) {
    const verdict = PLAN_CHOICES.includes(choice) ? choice : 'keep'
    const feedback = typeof answers === 'string' ? answers.trim().slice(0, 4000) : ''
    record(waiting.run, { type: 'answered', id, choice: verdict, feedback })
    waiting.resolve(verdict, feedback)
    return true
  }
  // A question takes its answers, one string per question text; anything else skips it.
  if (waiting.question) {
    const given = answersFor(waiting.question, answers)
    record(waiting.run, { type: 'answered', id, choice: given ? 'answer' : 'deny', answers: given })
    waiting.resolve(given ? 'answer' : 'deny', given)
    return true
  }
  const answer = choice === 'allow' || choice === 'always' ? choice : 'deny'
  record(waiting.run, { type: 'answered', id, choice: answer })
  waiting.resolve(answer)
  return true
}

/**
 * What a plan can be told, as Claude Code's own plan prompt offers it: go ahead and take edits
 * without asking, go ahead but ask before each edit, or keep planning.
 */
export const PLAN_CHOICES = ['acceptEdits', 'default', 'keep']

/**
 * The page's answers to Claude's questions, kept only for questions actually asked and only as
 * plain strings, which is the shape AskUserQuestion takes. Null when nothing usable came back.
 */
export function answersFor(questions, answers) {
  if (!answers || typeof answers !== 'object') return null
  const out = {}
  for (const q of Array.isArray(questions) ? questions : []) {
    const a = answers[q?.question]
    if (typeof a === 'string' && a.trim()) out[q.question] = a.trim().slice(0, 2000)
  }
  return Object.keys(out).length ? out : null
}

/**
 * "Always allow", built from the rules Claude Code itself suggests for this call, the same ones
 * its own "don't ask again" would save. They land in the project's `.claude/settings.local.json`,
 * so a terminal or the app stops asking too. Only allow rules: a suggestion to switch mode or
 * widen the working directories is more than one button should quietly do.
 */
export function alwaysRule(suggestions) {
  const updates = (Array.isArray(suggestions) ? suggestions : [])
    .filter((s) => s?.type === 'addRules' && s.behavior === 'allow' && s.rules?.length)
    .map((s) => ({ ...s, destination: 'localSettings' }))
  const label = updates
    .flatMap((s) => s.rules)
    .map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName))
    .join(', ')
  return { label, updates }
}

/**
 * Claude Code's own `/rename`: a custom-title record appended to the session's transcript, so
 * `claude --resume` lists the thread under its new name. The desktop app keeps a title of its
 * own and is not told; the colony shows the new name from `data/colony.json` either way.
 */
export const renameThread = (target, title) => renameSession(target.sessionId, title)

const denial = () => 'Denied in Bot Crossing'

const errorOf = (m) =>
  (typeof m.result === 'string' && m.result) || (Array.isArray(m.errors) && m.errors.join('; ')) || m.subtype

/**
 * The page's events for one SDK message.
 *
 * Text arrives twice: as deltas while it is being written, then whole once its block is done.
 * A block that streamed is not sent again. One that never streamed, such as a synthetic error
 * reply, still is. `block` carries that between messages. `fresh` marks a block's first delta,
 * so the page starts a new paragraph rather than running two blocks together.
 */
export function eventsOf(msg, block) {
  // Subagent traffic stays inside the subagent; its approvals still come through canUseTool.
  if (msg.parent_tool_use_id) return []
  if (msg.type === 'stream_event') {
    const { type, delta } = msg.event || {}
    if (type === 'content_block_start') block.streamed = false
    if (type !== 'content_block_delta' || delta?.type !== 'text_delta' || !delta.text) return []
    const fresh = !block.streamed
    block.streamed = true
    return [{ type: 'delta', text: delta.text, fresh }]
  }
  if (msg.type === 'assistant') {
    return (msg.message?.content || []).flatMap((part) => {
      if (part.type === 'tool_use') return [{ type: 'tool', name: part.name, summary: toolSummary(part.name, part.input) }]
      if (part.type !== 'text' || !part.text) return []
      const streamed = block.streamed
      block.streamed = false
      return streamed ? [] : [{ type: 'text', text: part.text }]
    })
  }
  if (msg.type === 'result') {
    return [{ type: 'done', ok: !msg.is_error, error: msg.is_error ? errorOf(msg) : undefined, cost: msg.total_cost_usd }]
  }
  return []
}

/**
 * A brand new Claude Code thread in `cwd`, started by its first message. Without your own CLI on
 * the machine, the SDK's bundled one starts it instead.
 */
export async function startChat(cwd, text, mode, model) {
  return startRun({ sessionId: '', cwd, bin: await cliBinary(), mode, model }, text)
}

/**
 * The permission modes a chat can run in, as Claude Code names them: ask before anything not
 * already allowed, plan only, accept file edits, allow everything, or deny whatever would ask.
 */
export const MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk']
export const modeOf = (mode) => (MODES.includes(mode) ? mode : 'default')

/**
 * The models a chat can pick, as Claude Code's own `--model` aliases, so each always means the
 * latest of its line. Anything else, '' included, leaves the thread on its default.
 */
export const MODELS = ['opus', 'sonnet', 'haiku', 'claude-opus-5-5']
export const modelOf = (model) => (MODELS.includes(model) ? model : '')

/** Commands per folder, and when they were read: a list this size barely changes. */
const commandCache = new Map()
const COMMANDS_TTL_MS = 10 * 60_000
const COMMANDS_TIMEOUT_MS = 20_000

/**
 * The slash commands Claude Code offers in `cwd`, built-ins, skills, plugins and the project's
 * own, exactly as its own `/` menu lists them. Answered by starting Claude Code there with no
 * message to send: it reports its commands and is let go before the model is ever called.
 */
export async function listCommands(cwd, { query = sdkQuery } = {}) {
  const cached = commandCache.get(cwd)
  if (cached && Date.now() - cached.at < COMMANDS_TTL_MS) return cached.list
  const abortController = new AbortController()
  const idle = { async *[Symbol.asyncIterator]() { await new Promise((resolve) => abortController.signal.addEventListener('abort', resolve)) } }
  const timer = setTimeout(() => abortController.abort(), COMMANDS_TIMEOUT_MS)
  try {
    const session = query({ prompt: idle, options: { cwd, pathToClaudeCodeExecutable: (await cliBinary()) || undefined, abortController } })
    const list = (await session.supportedCommands())
      .map((c) => ({ name: c.name, description: c.description || '', hint: c.argumentHint || '' }))
      .sort((a, b) => a.name.localeCompare(b.name))
    commandCache.set(cwd, { at: Date.now(), list })
    return list
  } finally {
    clearTimeout(timer)
    abortController.abort()
  }
}

/** Switch a running reply's mode. It applies from Claude's next tool call on. */
export async function setRunMode(runId, mode) {
  const run = runs.get(runId)
  if (!run || run.done || !run.session) return false
  run.mode = modeOf(mode)
  await run.session.setPermissionMode(run.mode)
  record(run, { type: 'mode', mode: run.mode })
  // What is already waiting is settled by the new mode too, as if it had been asked under it:
  // otherwise switching to Allow all leaves the reply stuck on the card that made you switch.
  for (const id of [...run.pending]) {
    const waiting = pending.get(id)
    // A plan is yours to read, whatever the mode: switching never approves one.
    if (!waiting || waiting.question || waiting.plan) continue
    const choice = settledBy(run.mode, waiting.name)
    if (choice) answerPermission(id, choice)
  }
  return true
}

/** File edits, which Auto-edit lets through without asking. */
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** How a mode answers a waiting tool call: allow, deny, or '' to leave it with you. */
export function settledBy(mode, name) {
  if (mode === 'bypassPermissions') return 'allow'
  if (mode === 'acceptEdits' && EDITS.has(name)) return 'allow'
  if (mode === 'dontAsk') return 'deny'
  return ''
}

/** Switch a running reply's model. It applies from Claude's next request on. */
export async function setRunModel(runId, model) {
  const run = runs.get(runId)
  if (!run || run.done || !run.session) return false
  run.model = modelOf(model)
  await run.session.setModel(run.model || undefined)
  return true
}

/**
 * Send `text` into `target.sessionId`, or into a new session in `target.cwd` when there is none.
 * Returns the run at once; the reply happens in the background, recording `session` (a new
 * thread's id, as soon as it has one), `delta`, `text`, `tool`, `permission`, `answered`, and a
 * final `done`. `query` is the SDK's, unless a test hands in its own.
 */
export function startRun(target, text, { query = sdkQuery } = {}) {
  const run = {
    id: randomUUID(),
    sessionId: target.sessionId || '',
    threadId: target.threadId || '',
    prompt: text,
    mode: modeOf(target.mode),
    model: modelOf(target.model),
    events: [],
    listeners: new Set(),
    pending: new Set(),
    abort: new AbortController(),
    done: false,
    /** Messages sent while this reply was running: they go together as the next turn. */
    queue: [],
  }
  runs.set(run.id, run)
  drive(run, target, text, query)
  return run
}

/**
 * How long a finished turn waits, with nothing left running in the background, for Claude Code
 * to start the turn a just-finished subagent's result brings. And the longest a reply stays open
 * for background work at all: a dev server started in the background never finishes.
 * ponytail: fixed numbers; make them settings if a real workload needs longer.
 */
const SETTLE_MS = 10_000
const BACKGROUND_LIMIT_MS = 30 * 60_000

/**
 * The session's input, kept open after the first message. Claude Code exits when its input
 * ends, and with it any subagent still running in the background, which then never reports
 * back. Held open, a finished subagent's result arrives as a new turn, as it does in the app.
 */
function inbox(first, taken = () => {}) {
  const items = [first]
  let given = 0
  let wake = null
  let closed = false
  return {
    /** Hand the session another message while it is open; false once it has closed. */
    push(text) {
      if (closed) return false
      items.push(text)
      wake?.()
      return true
    },
    close() {
      closed = true
      wake?.()
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) {
          const content = items.shift()
          // Everything after the first message is one you typed while it worked: say it is in.
          if (given++) taken()
          yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
        }
        if (closed) return
        await new Promise((resolve) => (wake = resolve))
        wake = null
      }
    },
  }
}

async function drive(run, target, text, query) {
  const write = (event) => record(run, event)
  const input = (run.inbox = inbox(text, () => write({ type: 'taken' })))
  /** The session's own schedule (CronCreate, /loop), as Claude Code reports it at each turn's end. */
  run.crons = []
  const stop = () => {
    for (const id of [...run.pending]) answerPermission(id, 'deny')
    input.close()
  }
  run.abort.signal.addEventListener('abort', stop, { once: true })

  const canUseTool = (name, input, { signal: toolSignal, suggestions, decisionReason, defaultToNo }) =>
    new Promise((resolve) => {
      const id = randomUUID()
      const always = alwaysRule(suggestions)
      run.pending.add(id)
      // Plan mode presenting its plan: shown to you as a document, approved or sent back.
      if (name === 'ExitPlanMode') {
        pending.set(id, {
          run,
          plan: true,
          resolve: async (verdict, feedback) => {
            if (verdict === 'keep') {
              return resolve({
                behavior: 'deny',
                message: feedback
                  ? `The user wants changes to the plan before approving it:\n${feedback}`
                  : 'The user did not approve the plan yet. Keep planning, and ask what to change if it is unclear.',
              })
            }
            resolve({ behavior: 'allow', updatedInput: input })
            // Out of plan mode into the mode you picked, as the terminal's own prompt does.
            run.mode = verdict
            await run.session?.setPermissionMode(verdict).catch(() => {})
            record(run, { type: 'mode', mode: verdict })
          },
        })
        toolSignal?.addEventListener('abort', () => answerPermission(id, 'keep'), { once: true })
        write({ type: 'plan', id, plan: String(input?.plan || ''), file: input?.planFilePath || '' })
        return
      }
      // Claude asking you something: shown as a question with its options, answered from there.
      if (name === 'AskUserQuestion') {
        const questions = Array.isArray(input?.questions) ? input.questions : []
        pending.set(id, {
          run,
          question: questions,
          resolve: (choice, answers) =>
            resolve(
              choice === 'answer'
                ? { behavior: 'allow', updatedInput: { ...input, answers } }
                : { behavior: 'deny', message: 'The user skipped these questions. Ask in plain text if you still need an answer.' }
            ),
        })
        toolSignal?.addEventListener('abort', () => answerPermission(id, 'deny'), { once: true })
        write({ type: 'question', id, questions })
        return
      }
      // The mode you picked, held to here as well. Claude Code can still ask under Allow all
      // (its own safety checks, a subagent, a rule that asks), and an ask then would stall a
      // loop meant to run unattended. So the page answers as the mode says, and leaves a note.
      // Not for an ask Claude Code marks as one never to approve on reflex.
      const settled = defaultToNo ? '' : settledBy(run.mode, name)
      if (settled) {
        run.pending.delete(id)
        const summary = toolSummary(name, input)
        write({ type: 'note', text: `${settled === 'allow' ? 'Allowed' : 'Denied'} by mode (${run.mode}): ${name} · ${summary}`.slice(0, 300) })
        return resolve(settled === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: denial(name) })
      }
      pending.set(id, {
        run,
        name,
        resolve: (choice) => {
          if (choice === 'deny') return resolve({ behavior: 'deny', message: denial(name) })
          const saved = choice === 'always' && always.updates.length ? { updatedPermissions: always.updates } : {}
          resolve({ behavior: 'allow', updatedInput: input, ...saved })
        },
      })
      toolSignal?.addEventListener('abort', () => answerPermission(id, 'deny'), { once: true })
      write({
        type: 'permission',
        id,
        name,
        summary: toolSummary(name, input),
        input: JSON.stringify(input, null, 2).slice(0, 4096),
        always: always.label,
        // Why Claude Code asked at all, in its own words, for when the answer is surprising.
        reason: typeof decisionReason === 'string' ? decisionReason.slice(0, 300) : '',
      })
    })

  /** The run's last event, written only once anything that has to come before it is. */
  let ended = null
  try {
    const messages = (run.session = query({
      prompt: input,
      options: {
        // First, so nothing a provider says can change how the page asks, streams or stops.
        ...extraOptions(target),
        resume: target.sessionId || undefined,
        cwd: target.cwd,
        // Explicit: left unset, a resumed run can start in `auto` and never ask the page at all.
        permissionMode: run.mode,
        model: run.model || undefined,
        // Lets the page switch to "Allow all" mid-reply; which mode applies is still `run.mode`.
        allowDangerouslySkipPermissions: true,
        // Your own CLI, so the session runs on the same version and login it was started with.
        pathToClaudeCodeExecutable: target.bin || undefined,
        abortController: run.abort,
        canUseTool,
        includePartialMessages: true,
        // Each turn's end says what the session has scheduled. While anything is, the session is
        // kept: its timers live in this process, and so do the questions they bring.
        hooks: {
          Stop: [
            {
              hooks: [
                async (hook) => {
                  const crons = hook.session_crons || []
                  // Told to the page when it changes, so the chat can offer to run a tick now.
                  if (JSON.stringify(crons) !== JSON.stringify(run.crons)) write({ type: 'schedule', crons })
                  run.crons = crons
                  return { continue: true }
                },
              ],
            },
          ],
        },
      },
    }))
    const block = { streamed: false }
    // Background work Claude Code reports, and whether a turn has finished with no new one yet.
    let background = 0
    let idleSince = 0
    let settle = null
    const finish = () => {
      clearTimeout(settle)
      input.close()
    }
    const settleSoon = () => {
      clearTimeout(settle)
      settle = setTimeout(finish, SETTLE_MS)
      settle.unref?.()
    }
    for await (const msg of messages) {
      if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
        background = (msg.tasks || []).filter((t) => !t.ambient).length
        if (idleSince && !background) settleSoon()
        continue
      }
      // Anything from a turn means the session is working again.
      if (msg.type === 'assistant' || msg.type === 'stream_event') {
        idleSince = 0
        clearTimeout(settle)
        if (run.scheduled) {
          run.scheduled = false
          write({ type: 'note', text: 'Working again: a scheduled tick, or a result coming back' })
        }
      }
      // Which model is replying: the page shows it in the chat's header.
      if (msg.type === 'system' && msg.subtype === 'init' && msg.model) write({ type: 'model', model: msg.model })
      // A new thread learns its id from the first thing its session says.
      if (!run.sessionId && msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        const thread = newChatThread(msg.session_id, target.cwd)
        run.sessionId = msg.session_id
        run.threadId = thread.id
        write({ type: 'session', thread })
      }
      for (const event of eventsOf(msg, block)) {
        if (event.type !== 'done') {
          write(event)
          continue
        }
        // Held back: `done` has to be the last thing a run records, after any `next`. A turn
        // that ends with subagents still going leaves the run open for their results.
        ended = event
        idleSince ||= Date.now()
        // A turn's end is a turn's end, for the page, even when the session stays.
        if (!event.ok) write({ type: 'note', text: event.error || 'That turn failed' })
        if (run.crons.length) {
          // ponytail: kept until Stop or until the schedule is empty; the Bot Crossing server
          // stopping ends it too, as closing the terminal would.
          clearTimeout(settle)
          run.scheduled = true
          write({ type: 'note', text: `Waiting for the schedule: ${run.crons.map((c) => `${c.schedule} ${c.prompt.slice(0, 40)}`).join('; ')}` })
          write({ type: 'idle' })
        } else if (!background) finish()
        else if (Date.now() - idleSince > BACKGROUND_LIMIT_MS) finish()
        else {
          write({ type: 'note', text: `Waiting on ${background} background task${background === 1 ? '' : 's'}; their results come back here` })
          clearTimeout(settle)
          settle = setTimeout(finish, BACKGROUND_LIMIT_MS)
          settle.unref?.()
        }
      }
    }
    // Ending without a result is a reply that never came, unless you stopped it.
    ended ||= { type: 'done', ok: false, error: run.abort.signal.aborted ? 'Stopped' : 'Claude Code ended without a reply' }
  } catch (err) {
    ended = { type: 'done', ok: false, error: run.abort.signal.aborted ? 'Stopped' : String(err?.message || err) }
  } finally {
    run.abort.signal.removeEventListener('abort', stop)
    stop()
    // What you sent while it worked goes now, as one turn in the same session; after a Stop too,
    // which is how you interrupt and redirect. All of this is synchronous, so nothing can slip
    // into the queue between taking it and this run counting as finished.
    const queued = run.queue.splice(0)
    if (queued.length && run.sessionId) {
      const next = startRun({ ...target, sessionId: run.sessionId, threadId: run.threadId, mode: run.mode, model: run.model }, queued.join('\n\n'), { query })
      write({ type: 'next', runId: next.id })
    }
    write(ended)
    run.done = true
    run.listeners.clear()
    setTimeout(() => runs.delete(run.id), KEEP_FINISHED_MS).unref?.()
  }
}
