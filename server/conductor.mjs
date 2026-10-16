/**
 * The orchestrator as a Claude Code session you talk to: it lives in ~/.claude, runs a plan
 * through the tools below, and reads each repo session's report back to you as it lands.
 *
 * It is an ordinary chat thread. The page starts it, shows it, and every message you send it
 * later goes through `chat.mjs` as any other; its tools come with it on every turn because
 * `provideSessionOptions` hands them to whichever run resumes it. Which session ids are
 * orchestrators is kept in the store (`conductors.json`), so that survives a server restart.
 *
 * Reading tools run without asking. Starting a plan was your click; approving, closing or
 * answering a repo session asks you on the page, every time.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSdkMcpServer, query as sdkQuery, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { activeRun, attachRun, provideSessionOptions, queueMessage, startRun } from './chat.mjs'
import { cliBinary, newChatThread } from './harnesses/claude-code.mjs'
import { approveReport, closeSession, collectReport, DEFAULT_MODEL, prepareRepos, resumeSession } from './orchestrator.mjs'
import { exerciseFile, exerciseHash, IMPLEMENT_MODEL, planFromReading, planKey, readExercise, readingFile, repoChecker, runPlan } from './plan.mjs'
import { bashAllowed, canServeGraph, graphServers } from './session-tools.mjs'
import { answerPermit, onAsk, pendingAsks, readPermits } from './permit.mjs'
import { readMessages } from './scan.mjs'
import { openStore, writeAtomic } from './store.mjs'

export const CONDUCTOR_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

/** Models a repo session can be given. The first is the default. */
export const SESSION_MODELS = [
  { id: IMPLEMENT_MODEL, label: 'Sonnet (latest)' },
  { id: DEFAULT_MODEL, label: 'Opus 5.5' },
  { id: 'haiku', label: 'Haiku (latest)' },
]
const modelOk = (m) => SESSION_MODELS.some((x) => x.id === m)

const CONDUCTOR_RULES = `
You are the orchestrator for shared sessions. Each repo in a plan gets its own Claude Code session in its own git worktree, branched fresh from the repo's remote default branch (fetched at start), so the local checkout's branch, staleness or uncommitted changes never matter and you never ask the user to pull. You coordinate the sessions through the mcp__orchestrator__* tools.
- Never edit repo code yourself and never run graphify update. Sessions do the work; you read their reports.
- When a session settles you are told. Read its report (read_report) and tell the user: status, what changed, commits, open questions, and anything that needs them.
- A blocked session asked a question. Answer it with resume_session only when the plan clearly answers it; otherwise ask the user.
- Approve (approve_report) or close (close_session) a session only when the user says so.
- Do not read a session's thread.md unless the user asks.
`.trim()

// ---------------------------------------------------------------------------------------------
// Which sessions are orchestrators

const shared = (globalThis[Symbol.for('bot-crossing.conductor')] ??= { plans: new Map() })
shared.jobs ??= new Map()

function registryFile(store) {
  return path.join(store.paths.root, 'conductors.json')
}

function readRegistry(store) {
  try {
    return JSON.parse(fs.readFileSync(registryFile(store), 'utf8'))
  } catch {
    return {}
  }
}

async function register(store, sessionId, entry) {
  const reg = readRegistry(store)
  reg[sessionId] = { ...entry, registered_at: new Date().toISOString() }
  await writeAtomic(registryFile(store), JSON.stringify(reg, null, 2) + '\n')
}

/**
 * Which Claude sessions belong to a shared run, keyed by session id: each orchestrator, and
 * each repo session it started, both carrying the plan's key so the page can group them.
 * Read on every scan; a handful of small files.
 */
export function shareRoles(store = openStore()) {
  const roles = new Map()
  const permits = readPermits(store)
  for (const [sid, c] of Object.entries(readRegistry(store))) {
    roles.set(sid, { role: 'orchestrator', plan: planKey(c.plan), file: c.plan })
  }
  const dir = store.paths.sessions
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    let state
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, name, 'state.json'), 'utf8'))
    } catch {
      continue
    }
    if (!state.session_id) continue
    const repo = state.repos?.[0]?.name || ''
    const plan = repo && name.endsWith(`-${repo}`) ? name.slice(0, -repo.length - 1) : name
    // What it is waiting on you for right now, and how far the repo is from pushing on its own.
    const asks = pendingAsks().filter((a) => a.session === name)
    const pushApproved = permits.repos?.[repo]?.push_approved || 0
    roles.set(state.session_id, { role: 'child', plan, name, repo, status: state.status, asks, push_approved: pushApproved })
  }
  return roles
}

/** The newest orchestrator of a plan, by session id. */
function orchestratorFor(store, plan) {
  const found = Object.entries(readRegistry(store))
    .filter(([, c]) => planKey(c.plan) === plan)
    .sort(([, a], [, b]) => String(b.registered_at).localeCompare(String(a.registered_at)))
  return found[0]?.[0] || null
}

// A repo session waiting for your Allow or Deny: its orchestrator hears of it and tells you
// what it is for. You answer on the page, never the orchestrator.
onAsk(async (ask) => {
  const store = openStore()
  const plan = ask.repo && ask.session.endsWith(`-${ask.repo}`) ? ask.session.slice(0, -ask.repo.length - 1) : ask.session
  const id = orchestratorFor(store, plan)
  if (!id) return
  await tell(
    { id },
    `[shared session] ${ask.session} is waiting for my permission to run \`${ask.command}\` (${ask.reason}). I answer Allow or Deny on the page, in the Orchestrations tab. In two lines, tell me what it is for and what could go wrong. Do not answer it yourself.`
  )
})

// ---------------------------------------------------------------------------------------------
// Telling the orchestrator something happened

/**
 * Say `text` to the orchestrator session: into its running reply when it has one, else as a
 * new turn. Each repo session settling arrives this way, so the orchestrator wakes for it.
 */
async function tell(holder, text, { start = startRun } = {}) {
  if (!holder.id) return
  const running = activeRun(holder.id)
  if (running && queueMessage(running, text)) return
  start({ sessionId: holder.id, threadId: newChatThread(holder.id, CONDUCTOR_HOME).id, cwd: CONDUCTOR_HOME, bin: await cliBinary(), mode: 'default', model: DEFAULT_MODEL }, text)
}

const settledNote = (r) =>
  r.status === 'waiting'
    ? `[shared session] ${r.name} did not start: ${r.reason}.`
    : `[shared session] ${r.name} ended ${r.status}. Read its report and summarise it for me.`

// ---------------------------------------------------------------------------------------------
// You talked to a repo session yourself

/** Tool calls that end a session's turn for the orchestrator: what came after is news to it. */
const REPORTED = new Set(['mcp__store__submit_report', 'mcp__store__ask_orchestrator'])

/**
 * Pass what you said to a repo session directly, and what it did, on to its orchestrator.
 * Everything after the session's last report, or after the last time this was pressed, goes
 * as one message; the orchestrator is asked to update its picture of the run.
 */
export async function reportToOrchestrator(ref, { store = openStore(), read = (r) => readMessages('claude-code', r), ...runOpts } = {}) {
  const child = shareRoles(store).get(ref?.cliSessionId)
  if (child?.role !== 'child') throw new Error('This thread is not a repo session of a shared run')
  const orchestrator = orchestratorFor(store, child.plan)
  if (!orchestrator) throw new Error(`No orchestrator for ${child.plan}`)
  const log = await read(ref)
  if (!log.ok) throw new Error(log.error || 'Could not read the session')
  const messages = log.messages
  const state = (await store.readState(child.name)) || {}
  const lastReport = messages.findLastIndex((m) => (m.tools || []).some((t) => REPORTED.has(t.name)))
  const from = Math.max(lastReport + 1, state.synced_messages || 0)
  const fresh = messages.slice(from).filter((m) => m.text.trim() || m.tools?.length)
  if (!fresh.length) return { sent: false, reason: `Nothing new in ${child.repo} since its last report` }
  const line = (m) => {
    const tools = m.tools?.length ? ` _(tools: ${[...new Set(m.tools.map((t) => t.name))].join(', ')})_` : ''
    return `**${m.role === 'user' ? 'Me' : child.repo}:** ${m.text.trim() || '—'}${tools}`
  }
  const text = `[shared session] I talked to ${child.name} directly. Below is that conversation since its last report. Update your picture of the run: what changed, what was decided, what is still open, and whether it changes what any other session should do. Tell me in a few lines.

${fresh.map(line).join('\n\n')}`
  await tell({ id: orchestrator }, text, runOpts)
  await store.writeState(child.name, { synced_messages: messages.length, synced_at: new Date().toISOString() })
  await store.appendLog({ type: 'direct_talk_reported', session: child.name, messages: fresh.length })
  return { sent: true, orchestrator, messages: fresh.length }
}

// ---------------------------------------------------------------------------------------------
// The tools

const ok = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const fail = (err) => ({ content: [{ type: 'text', text: String(err?.message || err) }], isError: true })
const guarded = (fn) => async (args) => {
  try {
    return await fn(args)
  } catch (err) {
    return fail(err)
  }
}

const expand = (p) => path.resolve(String(p || '').replace(/^~(?=$|\/)/, os.homedir()))

/** Plain handlers for the orchestrator tools, for one orchestrator session (`holder.id`). */
export function conductorHandlers(holder, { store = openStore(), ...runOpts } = {}) {
  const settled = (r) => tell(holder, settledNote(r), runOpts)
  return {
    async preview_plan({ plan_path }) {
      const warnings = []
      const sessions = await runPlan(expand(plan_path), { store, dry: true, say: (s) => warnings.push(s) })
      return ok({ sessions, warnings })
    },

    async run_plan({ plan_path, models = {} }) {
      const file = expand(plan_path)
      if (shared.plans.has(file)) return ok(`${file} is already running. Use status to follow it.`)
      for (const [repo, m] of Object.entries(models)) if (!modelOk(m)) throw new Error(`Unknown model ${m} for ${repo}`)
      const warnings = []
      const sessions = await runPlan(file, { store, dry: true, models, say: (s) => warnings.push(s) })
      const running = runPlan(file, { store, models, say: () => {}, onSettled: settled, ...runOpts })
        .catch((err) => tell(holder, `[shared session] the plan run failed: ${err.message}`, runOpts))
        .finally(() => shared.plans.delete(file))
      shared.plans.set(file, running)
      return ok({ started: sessions.map((s) => ({ name: s.name, repo: s.repo, model: s.model, after: s.dependsOn })), warnings })
    },

    async status({ prefix = '' }) {
      const dir = store.paths.sessions
      const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort() : []
      const rows = []
      for (const name of names) {
        const s = (await store.readState(name)) || {}
        rows.push({ name, status: s.status, model: s.model, repos: (s.repos || []).map((r) => r.name), cost_usd: s.cost_usd, kept_worktrees: s.kept_worktrees })
      }
      return ok(rows)
    },

    async read_report({ session }) {
      const report = await collectReport(session, { store })
      if (report) return ok(report.body)
      const question = await fs.promises.readFile(path.join(store.sessionDir(session), 'question.md'), 'utf8').catch(() => '')
      return ok(question ? `No report. The session asked:\n\n${question}` : `${session} has not reported yet.`)
    },

    async resume_session({ session, message }) {
      resumeSession(session, message, { store, ...runOpts })
        .then((state) => settled({ name: session, status: state.status }))
        .catch((err) => tell(holder, `[shared session] resuming ${session} failed: ${err.message}`, runOpts))
      return ok(`${session} resumed; you will be told when it settles.`)
    },

    approve_report: async ({ session }) => ok(await approveReport(session, { store })),
    close_session: async ({ session, reason = '' }) => ok(await closeSession(session, { store, reason })),
  }
}

export const READ_TOOLS = ['preview_plan', 'run_plan', 'status', 'read_report'].map((t) => `mcp__orchestrator__${t}`)

function conductorServer(holder, opts) {
  const h = conductorHandlers(holder, opts)
  const s = z.string()
  return createSdkMcpServer({
    name: 'orchestrator',
    version: '1.0.0',
    tools: [
      tool('preview_plan', 'Which repo sessions a plan.md would start, their steps, order and models. Starts nothing.', { plan_path: s }, guarded(h.preview_plan)),
      tool(
        'run_plan',
        'Start every repo session of a plan.md in the background. You are told as each one settles.',
        { plan_path: s, models: z.record(z.string(), z.string()).optional().describe('repo -> model; default Opus 5.5') },
        guarded(h.run_plan)
      ),
      tool('status', 'Every shared session (optionally those whose name starts with prefix): status, model, repos, cost.', { prefix: s.optional() }, guarded(h.status)),
      tool('read_report', "A session's report, or the question it is blocked on.", { session: s }, guarded(h.read_report)),
      tool('resume_session', 'Send a blocked or finished session an answer or instruction; it runs in the background.', { session: s, message: s }, guarded(h.resume_session)),
      tool('approve_report', "Turn a session's report into shared notes and close it. Only when the user says so.", { session: s }, guarded(h.approve_report)),
      tool('close_session', 'Close a session without writing notes.', { session: s, reason: s.optional() }, guarded(h.close_session)),
    ],
  })
}

/** What every orchestrator turn runs with: its tools, which of them need no asking, its rules. */
export function conductorOptions(holder, opts) {
  return {
    mcpServers: { orchestrator: conductorServer(holder, opts) },
    allowedTools: READ_TOOLS,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: CONDUCTOR_RULES },
  }
}

// Any later turn of a known orchestrator, from the page or from `tell`, gets the same options.
provideSessionOptions('conductor', (sessionId) => (readRegistry(openStore())[sessionId] ? conductorOptions({ id: sessionId }) : null))

// ---------------------------------------------------------------------------------------------
// Starting one

async function checkPlan(plan, models, store) {
  const file = expand(plan)
  if (!file.endsWith('.md')) throw new Error('A plan is a .md file')
  if (!fs.existsSync(file)) throw new Error(`No file at ${file}`)
  const warnings = []
  const sessions = await runPlan(file, { store, dry: true, models, say: (s) => warnings.push(s) })
  if (!sessions.length) throw new Error(`No repo steps found in ${path.basename(file)}${warnings.length ? `:\n${warnings.join('\n')}` : ''}`)
  return { file, sessions, warnings }
}

/**
 * Start an orchestrator session in ~/.claude for `plan`, with `models` per repo. Returns the
 * chat run, which the page watches like any reply.
 */
export async function startConductor(plan, models = {}, { store = openStore(), start = startRun } = {}) {
  for (const [repo, m] of Object.entries(models)) if (!modelOk(m)) throw new Error(`Unknown model ${m} for ${repo}`)
  const { file, sessions } = await checkPlan(plan, models, store)
  await store.init()
  const holder = { id: '' }
  const prompt = `Run the plan at ${file}.

Repo sessions and their models:
${sessions.map((s) => `- ${s.name} (${s.repo}) on ${s.model}${s.dependsOn.length ? `, after ${s.dependsOn.join(', ')}` : ''}`).join('\n')}

1. Call preview_plan and show me the sessions and any steps it cannot place.
2. Call run_plan with models ${JSON.stringify(Object.fromEntries(sessions.map((s) => [s.repo, s.model])))}.
3. As each session settles, read its report and summarise it for me. Approve nothing until I say so.`
  const run = start({ sessionId: '', cwd: CONDUCTOR_HOME, bin: await cliBinary(), mode: 'default', model: DEFAULT_MODEL, options: conductorOptions(holder, { store }) }, prompt)
  // The session's id arrives with its first message; from then on it is a known orchestrator.
  let stop = null
  const learn = () => {
    if (holder.id || !run.sessionId) return
    holder.id = run.sessionId
    register(store, holder.id, { plan: file, models }).catch(() => {})
    stop?.()
  }
  stop = attachRun(run, 0, learn, () => {})
  if (holder.id) stop()
  return run
}

/** The model that exercises a plan against the code, before any session writes a line. */
export const EXERCISE_MODEL = DEFAULT_MODEL

const EXERCISE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'changes', 'tests', 'risks', 'questions'],
  properties: {
    summary: { type: 'string' },
    changes: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['file', 'change'], properties: { file: { type: 'string' }, change: { type: 'string' } } },
    },
    tests: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
  },
}

/**
 * Opus reads the plan against one repo's real code, in the worktree the session will use, and
 * says exactly what changes where. Read-only: no edits, and only read-only shell commands.
 */
export async function exerciseRepo(file, session, { store = openStore(), query = sdkQuery, run, serveCheck = canServeGraph } = {}) {
  const [entry] = Object.values(await prepareRepos(store, [session.repo], session.name, { run }))
  const plan = await fsp.readFile(file, 'utf8')
  const prompt = `You are exercising an approved implementation plan against the real code, before anyone writes any. Do not edit anything.

Repo: ${entry.name}. Its worktree is ${entry.worktree}, branched from ${entry.base} at ${entry.git_sha.slice(0, 8)}: this is the code the implementing session will start from.
This repo's part of the plan: ${session.steps.join('; ')}.
${entry.graph_path ? `A code graph of this commit: \`graphify query "<question>" --graph ${entry.graph_path}\` (also path, explain), or the graphify-${entry.name} MCP tools.` : ''}

Read the plan, then the code it touches. Return:
- summary: two or three sentences: what this repo's change is, and whether the plan fits the code as it is.
- changes: each file to change and what changes in it, citing file:line for the code it touches.
- tests: the test cases to add or update, by file and name.
- risks: what could break, and where.
- questions: wherever the code disagrees with the plan, or the plan leaves a decision open.
Only what the plan asks for.

<plan path="${file}">
${plan}
</plan>`
  const options = {
    model: EXERCISE_MODEL,
    cwd: entry.worktree,
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    mcpServers: graphServers(entry.graph_path && serveCheck(entry.graph_path) ? [entry] : []),
    canUseTool: async (toolName, input) =>
      toolName !== 'Bash' || bashAllowed(String(input.command || ''))
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Read-only: use read-only shell commands, Read, Grep and Glob.' },
    permissionMode: 'default',
    settingSources: [],
    persistSession: false,
    outputFormat: { type: 'json_schema', schema: EXERCISE_SCHEMA },
    pathToClaudeCodeExecutable: (await cliBinary()) || undefined,
  }
  for await (const msg of query({ prompt, options })) {
    if (msg.type !== 'result') continue
    if (msg.subtype !== 'success' || !msg.structured_output) throw new Error(`Opus could not finish the exercise (${msg.subtype})`)
    return { ...msg.structured_output, repo: entry.name, base: entry.base, git_sha: entry.git_sha, model: EXERCISE_MODEL, cost_usd: msg.total_cost_usd }
  }
  throw new Error('Opus could not finish the exercise: no answer')
}


const readingSchema = (repos) => ({
  type: 'object',
  additionalProperties: false,
  required: ['sessions', 'human', 'notes'],
  properties: {
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'steps', 'depends_on'],
        properties: {
          repo: { type: 'string', ...(repos.length ? { enum: [...repos, 'other'] } : {}) },
          steps: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['title', 'detail'], properties: { title: { type: 'string' }, detail: { type: 'string' } } },
          },
          depends_on: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    human: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
})

/**
 * Opus reads the whole plan, whatever its layout, and decides the repo sessions: which repo
 * each piece of agent work belongs to, the order between them, and what is the user's to do.
 * No tools: the plan is the input. Kept per plan text in the store, where Start reads it.
 */
export async function readPlan(file, { store = openStore(), query = sdkQuery } = {}) {
  const text = await fsp.readFile(file, 'utf8')
  const isRepo = repoChecker(store.reposDir)
  const repos = fs.existsSync(store.reposDir) ? fs.readdirSync(store.reposDir).filter(isRepo).sort() : []
  const prompt = `Read this whole implementation plan and split the agent work in it into one session per repo. Each session is a coding agent working alone in that repo's git worktree; sessions run in parallel unless one depends on another.

- sessions: one per repo that an agent changes. repo is the repo's folder name from this list: ${repos.join(', ') || '(none)'}; use "other" only for agent work in a repo not on that list. steps: that repo's work in plan order, each a short title and a detail of what to do, carrying the plan's own specifics (names, files, values, constraints, which section to follow). depends_on: the repos whose session must finish first, only where the plan says so or the work truly needs it.
- human: work the plan gives to a person rather than an agent (a migration they run, a monitor they create, a rollout), one line each.
- notes: anything else every session must know: rules the plan sets for all agents, order constraints, what is out of scope.
Read all of it, not one section: plans name their tasks, steps and rules in different places.

<plan path="${file}">
${text}
</plan>`
  const options = {
    model: EXERCISE_MODEL,
    cwd: CONDUCTOR_HOME,
    tools: [],
    settingSources: [],
    persistSession: false,
    outputFormat: { type: 'json_schema', schema: readingSchema(repos) },
    pathToClaudeCodeExecutable: (await cliBinary()) || undefined,
  }
  for await (const msg of query({ prompt, options })) {
    if (msg.type !== 'result') continue
    if (msg.subtype !== 'success' || !msg.structured_output) throw new Error(`Opus could not read the plan (${msg.subtype})`)
    const reading = { ...msg.structured_output, plan_hash: exerciseHash(text, '', []), model: EXERCISE_MODEL, cost_usd: msg.total_cost_usd, at: new Date().toISOString() }
    const out = readingFile(store, planKey(file))
    await fsp.mkdir(path.dirname(out), { recursive: true })
    await writeAtomic(out, JSON.stringify(reading, null, 2) + '\n')
    return reading
  }
  throw new Error('Opus could not read the plan: no answer')
}

/**
 * The preview, in the background: Opus reads the whole plan into repo sessions (kept while the
 * plan is unchanged), then exercises each against its code at once. The page follows it.
 */
function startPreview(file, opts) {
  // Preview pressed again while Opus is still at it: follow the same run rather than pay twice.
  const running = [...shared.jobs.values()].find((j) => j.file === file && !j.done)
  if (running) return running
  const job = { id: randomUUID(), file, phase: 'reading', sessions: [], warnings: [], repos: {}, cost_usd: 0, done: false }
  shared.jobs.set(job.id, job)
  const text = fs.readFileSync(file, 'utf8')
  const exercise = async (s) => {
    const r = job.repos[s.repo]
    const hash = exerciseHash(text, s.repo, s.steps)
    const kept = readExercise(opts.store, s.name, hash)
    if (kept) return Object.assign(r, { status: 'done', exercise: kept, reused: true })
    try {
      r.status = 'reading'
      const ex = { ...(await exerciseRepo(file, s, opts)), plan_hash: hash, at: new Date().toISOString() }
      await fsp.mkdir(path.dirname(exerciseFile(opts.store, s.name)), { recursive: true })
      await writeAtomic(exerciseFile(opts.store, s.name), JSON.stringify(ex, null, 2) + '\n')
      job.cost_usd += ex.cost_usd || 0
      Object.assign(r, { status: 'done', exercise: ex })
    } catch (err) {
      Object.assign(r, { status: 'failed', error: String(err?.message || err) })
    }
  }
  ;(async () => {
    const isRepo = repoChecker(opts.store.reposDir)
    if (!planFromReading(opts.store, planKey(file), text, isRepo)) job.cost_usd += (await readPlan(file, opts)).cost_usd || 0
    const { sessions, warnings } = await checkPlan(file, {}, opts.store)
    Object.assign(job, { sessions, warnings, phase: 'exercising', repos: Object.fromEntries(sessions.map((s) => [s.repo, { status: 'queued' }])) })
    await Promise.all(sessions.map(exercise))
  })()
    .catch((err) => (job.error = String(err?.message || err)))
    .finally(() => {
      job.done = true
      job.phase = 'done'
      // ponytail: finished jobs live in memory for an hour; the reading and exercises are on disk.
      setTimeout(() => shared.jobs.delete(job.id), 3600_000).unref?.()
    })
  return job
}

const jobView = (job) => ({ phase: job.phase, sessions: job.sessions, warnings: job.warnings, repos: job.repos, cost_usd: job.cost_usd, error: job.error || null, done: job.done })

/** Preview a plan: started here, followed with /api/share/exercise. */
async function previewPlan(plan, opts) {
  const file = expand(plan)
  if (!file.endsWith('.md')) throw new Error('A plan is a .md file')
  if (!fs.existsSync(file)) throw new Error(`No file at ${file}`)
  await opts.store.init()
  const job = startPreview(file, opts)
  return { file, job: job.id, ...jobView(job) }
}

/** The page's calls: preview a plan, follow its exercise, start its orchestrator, and the rest. */
export async function shareRoute(pathname, body, { store = openStore(), query = sdkQuery, run, serveCheck } = {}) {
  if (pathname === '/api/share/preview') {
    const preview = await previewPlan(body.plan, { store, query, run, serveCheck })
    return { status: 200, json: { ...preview, models: SESSION_MODELS, home: CONDUCTOR_HOME } }
  }
  if (pathname === '/api/share/exercise') {
    const job = shared.jobs.get(String(body.job || ''))
    if (!job) return { status: 404, json: { error: 'That exercise is gone; press Preview again' } }
    return { status: 200, json: jobView(job) }
  }
  if (pathname === '/api/share/answer') {
    return { status: 200, json: await answerPermit(store, String(body.id || ''), body.choice) }
  }
  if (pathname === '/api/share/report') {
    return { status: 200, json: await reportToOrchestrator(body.ref, { store }) }
  }
  if (pathname === '/api/share/start') {
    const models = body.models && typeof body.models === 'object' ? body.models : {}
    const run = await startConductor(body.plan, models, { store })
    return { status: 200, json: { runId: run.id, folder: CONDUCTOR_HOME } }
  }
  return { status: 404, json: { error: 'Unknown endpoint' } }
}
