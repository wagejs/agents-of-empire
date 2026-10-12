/**
 * The orchestrator: hands one task to one Claude Code session, reads back its report, and turns
 * what you approve into shared notes.
 *
 * Only the orchestrator writes notes/ and index.md, and only it runs `graphify update`. Each
 * session gets a git worktree per repo, branched fresh from the remote base branch, with its own
 * copy of the graph brought up to that commit, so the code it reads is exactly the code the
 * graph describes, and the `sha` in its code_refs says which.
 *
 * `query` is the SDK's unless a test hands in its own, the same seam `chat.mjs` uses.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { cliBinary } from './harnesses/claude-code.mjs'
import { canServeGraph, graphServers, IMPLEMENT_BASH, sessionHooks, sessionPermissions, storeServer } from './session-tools.mjs'
import { assertSessionName, openStore, parseFrontMatter } from './store.mjs'

const exec = promisify(execFile)
const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

/** The stable rules every session runs under. Task facts go in the brief, not here. */
export const SESSION_RULES = `
You are a delegated session working for an orchestrator. Your brief is brief.md in your session folder (named at the end of these rules).
- Do the one task in the brief. You may use your own skills and subagents; a subagent returns its result to you, never to the store.
- Write only in your session folder and in the repo worktrees listed in the brief. Keep your own working notes in thread.md in your session folder.
- Shared notes are read-only to you: read index.md and use mcp__store__read_note. Never write to the store directly.
- Code graphs are read-only: use the graphify-<repo> MCP tools, or graphify query/path/explain. Never run graphify update/extract or touch graphify-out/.
- Every code fact carries code_refs {repo, node, file, line, sha, confidence}. Use the brief's git_sha for sha. Copy the edge's confidence (EXTRACTED, INFERRED, AMBIGUOUS).
- A fact backed only by INFERRED edges is weak. Open the file with Read before you report it as strong.
- Do not copy graph content or your discussion into the report. Report results and reasons only.
- Finish by calling mcp__store__submit_report. If you cannot go on without an answer, call mcp__store__ask_orchestrator and stop.
`.trim()

const worktreePath = (repoPath, name) => path.join(repoPath, '.claude', 'worktrees', `share-${name}`)
const branchOf = (name) => `share/${name}`

/**
 * The commit a repo's sessions start from: its remote default branch, fetched now. The main
 * checkout's branch, HEAD and uncommitted changes never matter, however stale they are.
 */
async function remoteBase(repoPath) {
  await git(repoPath, 'fetch', '--quiet', 'origin')
  const ref = await git(repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => 'origin/main')
  return { ref, sha: await git(repoPath, 'rev-parse', ref) }
}

/**
 * A worktree per repo, branched fresh from the remote base, reused when the session already has
 * one. `git_sha` is where the branch left the base, so the session's own commits never count.
 */
async function addWorktrees(store, repos, name) {
  const out = []
  for (const repo of repos) {
    const repo_path = store.repoPath(repo)
    const worktree = worktreePath(repo_path, name)
    const base = await remoteBase(repo_path)
    if (!fs.existsSync(worktree)) await git(repo_path, 'worktree', 'add', '--no-track', '-b', branchOf(name), worktree, base.sha)
    const git_sha = await git(worktree, 'merge-base', 'HEAD', base.sha)
    out.push({ name: path.basename(repo_path), repo_path, worktree, branch: branchOf(name), base: base.ref, git_sha })
  }
  return out
}

/**
 * Remove the worktrees a session left untouched; keep, and return, the ones with changes or
 * commits, since deleting those would lose work.
 */
async function removeCleanWorktrees(repos) {
  const kept = []
  for (const r of repos || []) {
    if (!fs.existsSync(r.worktree)) continue
    const dirty = await git(r.worktree, 'status', '--porcelain')
    const ahead = Number(await git(r.worktree, 'rev-list', '--count', `${r.git_sha}..HEAD`))
    if (dirty || ahead) {
      kept.push(r.worktree)
      continue
    }
    await git(r.repo_path, 'worktree', 'remove', r.worktree)
    await git(r.repo_path, 'branch', '-D', r.branch).catch(() => {})
  }
  return kept
}

export function renderBrief({ name, goal, limits, noteIds, reportFormat, repos }) {
  const freshness = Object.fromEntries(repos.map((r) => [r.name, { git_sha: r.git_sha, built_at: r.built_at }]))
  const list = (items) => (items?.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)')
  return `# Brief: ${name}

## Goal
${goal}

## Limits
${Array.isArray(limits) ? list(limits) : limits || '- (none)'}

## Notes to read first
${list(noteIds)}

## Report format
${reportFormat || 'Call mcp__store__submit_report with status, summary, decisions, facts, open_questions, artifacts, needs_from_orchestrator.'}

## Repos
| repo | worktree | base | graph_path | git_sha | built_at |
|---|---|---|---|---|---|
${repos.map((r) => `| ${r.name} | ${r.worktree} | ${r.base || '-'} | ${r.graph_path || '(no graph)'} | ${r.git_sha} | ${r.built_at || '-'} |`).join('\n') || '| (none) | | | | | |'}

Graph MCP servers: ${repos.filter((r) => r.graph_path && r.graph_mcp !== false).map((r) => `graphify-${r.name}`).join(', ') || '(none)'}
${repos
  .filter((r) => r.graph_path)
  .map((r) => `- ${r.name} from the shell: \`graphify query "<question>" --graph ${r.graph_path}\` (also \`path\`, \`explain\`)${r.graph_mcp === false ? ' — its MCP server is unavailable (graphify is missing its mcp extra), use this' : ''}`)
  .join('\n')}

## graph_freshness
\`\`\`json
${JSON.stringify(freshness, null, 2)}
\`\`\`
`
}

/** The model every session runs on unless told otherwise. */
export const DEFAULT_MODEL = 'claude-opus-5-5'

/**
 * The SDK options for one session, rebuilt the same way on start and on resume. A session with
 * repos opens in its first worktree, so it is a thread of that repo, as if started there; its
 * store folder and any other worktrees come along as extra directories.
 */
async function sessionOptions(store, name, repos, mode, extra = {}) {
  const dir = store.sessionDir(name)
  const worktrees = repos.map((r) => r.worktree)
  const writable = [dir, ...worktrees]
  const ctx = { readFiles: new Set() }
  return {
    cwd: worktrees[0] || dir,
    additionalDirectories: worktrees.length ? [dir, ...worktrees.slice(1)] : [],
    mcpServers: { store: storeServer(store, name, ctx), ...graphServers(repos) },
    hooks: sessionHooks(store, name, writable, ctx),
    canUseTool: sessionPermissions(store, name, writable, { bash: mode === 'implement' ? IMPLEMENT_BASH : null }),
    permissionMode: 'default',
    // Your own skills and settings load, as in a terminal; the hooks above still apply.
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: `${SESSION_RULES}\nYour session folder (brief.md, thread.md) is ${dir}.` },
    pathToClaudeCodeExecutable: (await cliBinary()) || undefined,
    ...extra,
    model: extra.model || DEFAULT_MODEL,
  }
}

/** Run one session's messages to the end, keeping state.json current. */
async function drive(store, name, prompt, options, query) {
  try {
    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        await store.writeState(name, { session_id: msg.session_id, model: msg.model || undefined })
      }
      if (msg.type === 'result') {
        await store.writeState(name, { cost_usd: msg.total_cost_usd, turns: msg.num_turns, result: msg.subtype })
      }
    }
  } catch (err) {
    await store.appendLog({ type: 'session_error', session: name, error: String(err?.message || err) })
  }
  const state = await store.readState(name)
  // Ended without a report or a question, and the Stop hook did not already give up on it.
  if (state.status === 'running') return store.writeState(name, { status: 'failed' })
  return state
}

/**
 * Start one session on one task. Resolves when the session stops, with its state; run several
 * at once with Promise.all.
 */
export async function startSession(
  name,
  { goal, limits = [], noteIds = [], repos = [], reportFormat = '', mode = 'research' },
  { store = openStore(), query = sdkQuery, run, model, options = {}, serveCheck = canServeGraph } = {}
) {
  assertSessionName(name)
  await store.init()
  const entries = await store.refreshGraphs(await addWorktrees(store, repos, name), run ? { run } : {})
  const withWorktrees = Object.values(entries).map((r) => ({ ...r, graph_mcp: Boolean(r.graph_path) && serveCheck(r.graph_path) }))
  for (const r of withWorktrees) {
    if (r.graph_path && !r.graph_mcp) await store.appendLog({ type: 'graph_mcp_unavailable', session: name, repo: r.name })
  }
  const brief = renderBrief({ name, goal, limits, noteIds, reportFormat, repos: withWorktrees })
  const dir = await store.createSession(name, brief)
  await store.writeState(name, { status: 'running', mode, model: model || DEFAULT_MODEL, repos: withWorktrees, note_ids: noteIds, started_at: new Date().toISOString() })
  await store.appendLog({ type: 'session_start', session: name, repos: withWorktrees.map((r) => `${r.name}@${r.git_sha.slice(0, 8)}`) })
  const prompt = `Your brief (also at ${path.join(dir, 'brief.md')}):\n\n${brief}`
  return drive(store, name, prompt, await sessionOptions(store, name, withWorktrees, mode, { model, ...options }), query)
}

/** Continue a session where it left off, with an answer or a new instruction. */
export async function resumeSession(name, message, { store = openStore(), query = sdkQuery, model, options = {} } = {}) {
  const state = await store.readState(name)
  if (!state?.session_id) throw new Error(`Session ${name} has no session_id to resume`)
  if (state.status === 'closed') throw new Error(`Session ${name} is closed`)
  await store.writeState(name, { status: 'running', stop_bounces: 0 })
  await store.appendLog({ type: 'session_resume', session: name })
  const opts = await sessionOptions(store, name, state.repos || [], state.mode, { resume: state.session_id, model: model || state.model, ...options })
  return drive(store, name, message, opts, query)
}

/** The session's report as filed. thread.md is the session's own and is not read here. */
export async function collectReport(name, { store = openStore() } = {}) {
  const text = await fsp.readFile(path.join(store.sessionDir(name), 'report.md'), 'utf8').catch(() => null)
  if (text == null) return null
  const { header, body } = parseFrontMatter(text)
  return { ...header, body }
}

/**
 * Turn an approved report's decisions and facts into notes, code_refs kept, each linked to the
 * notes the session was briefed with. Then rebuild the index, close the session, and remove the
 * worktrees it left untouched.
 */
export async function approveReport(name, { store = openStore() } = {}) {
  const report = await collectReport(name, { store })
  if (!report) throw new Error(`Session ${name} has no report`)
  const state = await store.readState(name)
  const links = (state.note_ids || []).map((id) => ({ id, rel: 'derived_from' }))
  const notes = []
  const add = (type, item, tags) =>
    store
      .writeNote({
        type,
        body: item.reason ? `${item.text}\n\nReason: ${item.reason}` : item.text,
        tags: [`session:${name}`, ...tags],
        links,
        code_refs: item.code_refs || [],
        created_by: `orchestrator (from session ${name})`,
      })
      .then((n) => notes.push(n.id))
  for (const d of report.decisions || []) await add('decision', d, [])
  for (const f of report.facts || []) await add('fact', f, [f.strength || 'weak'])
  await store.updateIndex()
  const keptWorktrees = await removeCleanWorktrees(state.repos)
  await store.writeState(name, { status: 'closed', approved_notes: notes, closed_at: new Date().toISOString(), kept_worktrees: keptWorktrees })
  await store.appendLog({ type: 'approve', session: name, notes })
  return { notes, keptWorktrees }
}

/**
 * Close a session without writing notes: rejected, failed, or simply done with. Worktrees with
 * changes or commits are kept, as on approval.
 */
export async function closeSession(name, { store = openStore(), reason = '' } = {}) {
  const state = await store.readState(name)
  if (!state) throw new Error(`No session ${name}`)
  const keptWorktrees = await removeCleanWorktrees(state.repos)
  await store.writeState(name, { status: 'closed', closed_at: new Date().toISOString(), close_reason: reason, kept_worktrees: keptWorktrees })
  await store.appendLog({ type: 'close', session: name, reason })
  return { keptWorktrees }
}
