/**
 * What a delegated session gets beyond Claude Code itself: three tools into the store, one
 * read-only graph server per repo, and the hooks that keep it inside its own folder.
 *
 * A session writes only in `sessions/<name>/` and in its own worktrees. It reads shared notes
 * and the index, never another session's folder, the log or the graph registry. It may query a
 * code graph but never rebuild one: only the orchestrator runs `graphify update`.
 *
 * The tool handlers are plain functions (`toolHandlers`), wrapped into an in-process MCP server
 * by `storeServer`, so a test can drive them without a model.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { classify, requestPermit } from './permit.mjs'
import { CONFIDENCES, checkCodeRef, renderFrontMatter, writeAtomic } from './store.mjs'

/** Statuses after which a session may stop. */
export const SETTLED = ['reported', 'blocked']
/** How many times Stop sends a session back before giving up on it as `failed`. */
export const MAX_STOP_BOUNCES = 3

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const GRAPHIFY_ALLOWED = new Set(['query', 'path', 'explain'])
/** Shell that writes, for the paths a session must never change through Bash. */
const SHELL_WRITE_OPS = /(^|[\s;&|])(rm|mv|cp|tee|touch|mkdir|rmdir|truncate|ln|chmod|install)\s|>|\bsed\s+-i|\bperl\s+-i/
/** Redirects that write no file: `2>&1`, `>&2`, `> /dev/null`. */
const HARMLESS_REDIRECTS = /\d*>>?\s*&\s*\d+|&>\s*\/dev\/null|\d*>>?\s*\/dev\/null/g
const SHELL_WRITES = { test: (cmd) => SHELL_WRITE_OPS.test(cmd.replace(HARMLESS_REDIRECTS, ' ')) }
/** Bash a session may run without asking anyone: reading, and the read-only graph commands. */
const SAFE_BASH = /^\s*(graphify\s+(query|path|explain)\b|git\s+(-C\s+\S+\s+)?(status|diff|log|show|blame|grep|ls-files|rev-parse|branch\s+--show-current)\b|ls\b|cat\b|head\b|tail\b|wc\b|grep\b|rg\b|find\b|jq\b|pwd\b|echo\b)/
/**
 * What turns a read-only command into one that runs or writes something: substitution, file
 * redirects, process substitution, backgrounding, more lines, and the flags of find, rg and
 * git that run a program or write a file.
 */
const UNSAFE_SHELL =
  /\$\(|`|[<>]|&(?!&)|\n|\s-(exec|execdir|ok|okdir|delete|fprint\S*|fls)\b|\s--pre\b|\s(-O|--open-files-in-pager|--output)\b|\s--ext-diff\b/

const inside = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const resolveFrom = (cwd, p) => path.resolve(cwd || '/', String(p || ''))

/** The real path, through symlinks, of `p` or of its nearest folder that exists. */
function real(p) {
  const rest = []
  for (let d = p; ; d = path.dirname(d)) {
    try {
      return path.join(fs.realpathSync(d), ...rest)
    } catch {
      if (path.dirname(d) === d) return p
      rest.unshift(path.basename(d))
    }
  }
}

/** The python graphify was installed with, as it recorded it beside the graph. */
export function graphifyPython(graphPath) {
  try {
    const recorded = fs.readFileSync(path.join(path.dirname(graphPath), '.graphify_python'), 'utf8').trim()
    if (recorded) return recorded
  } catch {}
  return process.env.GRAPHIFY_PYTHON || 'python3'
}

/**
 * Whether `graphify.serve` can start for this graph: it needs graphify's `mcp` extra, which a
 * plain `uv tool install graphifyy` does not bring. Without it the session uses the CLI.
 */
export function canServeGraph(graphPath) {
  const r = spawnSync(graphifyPython(graphPath), ['-c', 'import mcp, graphify.serve'], { stdio: 'ignore', timeout: 30_000 })
  return r.status === 0
}

/** One read-only stdio MCP server per repo with a servable graph: `graphify-<repo>`. */
export function graphServers(entries) {
  const out = {}
  for (const e of entries) {
    if (!e.graph_path || e.graph_mcp === false) continue
    out[`graphify-${e.name}`] = { type: 'stdio', command: graphifyPython(e.graph_path), args: ['-m', 'graphify.serve', e.graph_path] }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The store tools

const codeRefShape = z.object({
  repo: z.string(),
  node: z.string().optional(),
  file: z.string(),
  line: z.number().int().optional(),
  sha: z.string(),
  confidence: z.enum(CONFIDENCES),
})
const itemShape = z.object({ text: z.string(), reason: z.string().optional(), code_refs: z.array(codeRefShape).optional() })
const factShape = itemShape.extend({ strength: z.enum(['strong', 'weak']).optional() })

export const REPORT_SHAPE = {
  status: z.enum(['done', 'partial', 'failed']).describe('How the assigned task ended'),
  summary: z.string().describe('The result in a few sentences: results and reasons, not the discussion'),
  decisions: z.array(itemShape).default([]),
  facts: z.array(factShape).default([]).describe('A fact backed only by INFERRED edges is weak unless you opened the file'),
  open_questions: z.array(z.string()).default([]),
  artifacts: z.array(z.object({ path: z.string(), description: z.string().optional() })).default([]),
  needs_from_orchestrator: z.array(z.string()).default([]),
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true })

function renderReport(r) {
  const list = (title, items, fmt) => (items?.length ? `## ${title}\n${items.map((i) => `- ${fmt(i)}`).join('\n')}\n` : '')
  const refs = (i) => (i.code_refs?.length ? ` (${i.code_refs.map((c) => `${c.repo}:${c.file}${c.line ? `:${c.line}` : ''} ${c.confidence}`).join('; ')})` : '')
  return [
    `# Report: ${r.status}`,
    '',
    r.summary,
    '',
    list('Decisions', r.decisions, (d) => `${d.text}${d.reason ? ` — ${d.reason}` : ''}${refs(d)}`),
    list('Facts', r.facts, (f) => `[${f.strength}] ${f.text}${refs(f)}`),
    list('Open questions', r.open_questions, (q) => q),
    list('Artifacts', r.artifacts, (a) => `${a.path}${a.description ? ` — ${a.description}` : ''}`),
    list('Needs from orchestrator', r.needs_from_orchestrator, (n) => n),
  ].join('\n')
}

/**
 * The three store tools as plain async functions. `ctx.readFiles` is the files this session has
 * opened with Read, which is what lets a fact on INFERRED edges count as strong.
 */
export function toolHandlers(store, name, ctx = { readFiles: new Set() }) {
  const dir = store.sessionDir(name)
  return {
    async submit_report(args) {
      try {
        const report = { ...args, decisions: args.decisions || [], facts: args.facts || [] }
        for (const item of [...report.decisions, ...report.facts]) item.code_refs = (item.code_refs || []).map(checkCodeRef)
        for (const fact of report.facts) {
          const refs = fact.code_refs
          const inferredOnly = refs.length > 0 && refs.every((r) => r.confidence !== 'EXTRACTED')
          if (!fact.strength) fact.strength = inferredOnly || !refs.length ? 'weak' : 'strong'
          if (fact.strength === 'strong' && inferredOnly) {
            const unread = refs.filter((r) => ![...ctx.readFiles].some((f) => f.endsWith(r.file)))
            if (unread.length) {
              return fail(`"${fact.text}" rests only on INFERRED/AMBIGUOUS edges. Open ${unread.map((r) => r.file).join(', ')} with Read first, or report it as weak.`)
            }
          }
        }
        const reported_at = new Date().toISOString()
        await writeAtomic(path.join(dir, 'report.md'), renderFrontMatter({ session: name, reported_at, ...report }, renderReport(report)))
        await store.writeState(name, { status: 'reported', last_report_time: reported_at })
        await store.appendLog({ type: 'report', session: name, status: report.status, decisions: report.decisions.length, facts: report.facts.length })
        return ok('Report filed. You can stop now.')
      } catch (err) {
        return fail(String(err?.message || err))
      }
    },

    async ask_orchestrator({ question, context = '' }) {
      const asked_at = new Date().toISOString()
      await writeAtomic(path.join(dir, 'question.md'), renderFrontMatter({ session: name, asked_at }, `${question}\n\n${context}`))
      await store.writeState(name, { status: 'blocked', last_question_time: asked_at })
      await store.appendLog({ type: 'question', session: name, question: question.slice(0, 300) })
      return ok('Question sent. Stop now; you will be resumed with the answer.')
    },

    async read_note({ id }) {
      try {
        const note = await store.readNote(id)
        return ok(renderFrontMatter(Object.fromEntries(Object.entries(note).filter(([k]) => k !== 'body')), note.body))
      } catch (err) {
        return fail(`No note ${id}: ${err.message}`)
      }
    },
  }
}

/** The in-process MCP server a session talks to the store through: `mcp__store__*`. */
export function storeServer(store, name, ctx) {
  const h = toolHandlers(store, name, ctx)
  return createSdkMcpServer({
    name: 'store',
    version: '1.0.0',
    tools: [
      tool('submit_report', 'File your result for the orchestrator. Call this once, when the task is done.', REPORT_SHAPE, h.submit_report),
      tool(
        'ask_orchestrator',
        'Ask the orchestrator something only it can answer, then stop and wait to be resumed.',
        { question: z.string(), context: z.string().optional() },
        h.ask_orchestrator
      ),
      tool('read_note', 'Read one shared note by id (see index.md for the ids).', { id: z.string() }, h.read_note),
    ],
  })
}

// ---------------------------------------------------------------------------------------------
// The guard

const deny = (reason) => ({ allow: false, reason })
const ALLOW = { allow: true }

/**
 * Whether a session may make this tool call. `writable` is the session folder plus its
 * worktrees. Pure, so the PreToolUse hook and canUseTool give the same answer.
 */
export function guard(store, name, writable, toolName, input = {}, cwd = '', { push = false } = {}) {
  const root = store.paths.root
  const own = store.sessionDir(name)
  if (WRITE_TOOLS.has(toolName)) {
    const target = resolveFrom(cwd, input.file_path || input.notebook_path)
    if (target.split(path.sep).includes('graphify-out')) return deny('graphify-out/ is read-only for sessions')
    // A symlink in the worktree must not carry a write out of it.
    if (!writable.some((dir) => inside(target, dir) && inside(real(target), real(dir)))) return deny(`Sessions write only inside ${own} and their own worktrees`)
    return ALLOW
  }
  if (READ_TOOLS.has(toolName)) {
    const target = resolveFrom(cwd, input.file_path || input.path || cwd)
    if (!inside(target, root)) return ALLOW
    if (inside(target, store.paths.notes) || target === store.paths.index || inside(target, own)) return ALLOW
    // Reading the store's root lists it; reading inside another session, the log or the registry is not shared.
    if (target === root && toolName !== 'Read') return ALLOW
    return deny('In the store, sessions read only notes/, index.md and their own folder')
  }
  if (toolName === 'Bash') {
    const cmd = String(input.command || '')
    for (const m of cmd.matchAll(/\bgraphify(?:\.py)?\s+([a-z][\w-]*)/g)) {
      if (!GRAPHIFY_ALLOWED.has(m[1])) return deny(`graphify ${m[1]} is for the orchestrator; sessions may run graphify query, path and explain`)
    }
    if (/graphify-out/.test(cmd) && SHELL_WRITES.test(cmd)) return deny('graphify-out/ is read-only for sessions')
    if ((cmd.includes(root) || /(^|[\s'"/])\.store\b/.test(cmd)) && SHELL_WRITES.test(cmd)) return deny('Write to the store through submit_report, ask_orchestrator or the Write tool in your own folder')
    // Loose on purpose: `git -C . push -uf`, `git -c x=y rebase`, `git pull --rebase`, a refspec `+main`.
    const line = cmd.replace(/\s+/g, ' ')
    if (/\bgit\b.*\brebase\b/.test(line) || /\bgit\b.*\bpush\b.*(\s--force|\s-[a-z]*f[a-z]*\b|\s\+\S)/.test(line)) return deny('Never rebase or force-push; merge main in and push fast-forward')
    // An implementing session's push waits for you at the gate; nobody else pushes at all.
    if (!push && /\bgit\b.*\bpush\b/.test(line)) return deny('Sessions do not push; report the branch instead')
    return ALLOW
  }
  return ALLOW
}

/**
 * canUseTool for a session. A researching one gets the guard and a short read-only Bash list.
 * An implementing one (`gate`: its repo and your ask rules) runs allow-all after the guard,
 * except what `classify` says waits for you: that call is held until you answer on the page.
 */
export function sessionPermissions(store, name, writable, { gate } = {}) {
  return async (toolName, input) => {
    const verdict = guard(store, name, writable, toolName, input, '', { push: Boolean(gate) })
    if (!verdict.allow) return { behavior: 'deny', message: verdict.reason }
    if (gate) {
      const held = classify(toolName, input, gate.rules)
      if (!held) return { behavior: 'allow', updatedInput: input }
      const choice = await requestPermit(store, { session: name, repo: gate.repo, toolName, input, ...held })
      await store.appendLog({ type: 'permit', session: name, tool: toolName, kind: held.kind, choice })
      return choice === 'allow'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The user denied this. Do not try another way round it; say what you needed in open_questions.' }
    }
    if (toolName === 'Bash' && !bashAllowed(String(input.command || ''))) {
      return { behavior: 'deny', message: 'Not on the session Bash allowlist (read-only commands and graphify query/path/explain). Report what you need instead.' }
    }
    return { behavior: 'allow', updatedInput: input }
  }
}

/**
 * A command chain is allowed when every part is: `cd <dir>` (the guard already checked
 * paths), a read-only command, or one from `extra`. `a && b`, `a; b` and `a | b` all count.
 */
export function bashAllowed(cmd, extra) {
  if (UNSAFE_SHELL.test(cmd.replace(HARMLESS_REDIRECTS, ' '))) return false
  const parts = cmd.split(/&&|\|\||;|\|/).map((p) => p.trim()).filter(Boolean)
  return parts.length > 0 && parts.every((p) => /^cd\s+\S+$/.test(p) || SAFE_BASH.test(p) || Boolean(extra?.test(p)))
}

const STORE_WRITE_TOOLS = /^mcp__store__(submit_report|ask_orchestrator)$/

/** PreToolUse, PostToolUse and Stop for one session. */
export function sessionHooks(store, name, writable, ctx = { readFiles: new Set() }, { gate } = {}) {
  const preToolUse = async (input) => {
    let verdict = guard(store, name, writable, input.tool_name, input.tool_input || {}, input.cwd, { push: Boolean(gate) })
    // A subagent hands its result to its session; only the session reports to the store.
    if (verdict.allow && input.agent_id && STORE_WRITE_TOOLS.test(input.tool_name)) verdict = deny('Subagents return results to their session; the session reports')
    // What waits for you goes to the permission prompt even when a settings rule would allow
    // it (a repo allowing `git push *`, say): canUseTool is where it waits.
    const held = verdict.allow && gate && classify(input.tool_name, input.tool_input || {}, gate.rules)
    if (held) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Waits for the user: ${held.reason}` } }
    if (verdict.allow) return {}
    await store.appendLog({ type: 'denied', session: name, tool: input.tool_name, reason: verdict.reason })
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } }
  }

  const postToolUse = async (input) => {
    const ti = input.tool_input || {}
    if (input.tool_name === 'Read' && ti.file_path) ctx.readFiles.add(resolveFrom(input.cwd, ti.file_path))
    const what = ti.file_path || ti.path || ti.command || ti.pattern || ti.id || ''
    await store.appendLog({ type: 'tool', session: name, tool: input.tool_name, agent: input.agent_id || undefined, input: String(what).slice(0, 200) })
    return {}
  }

  const stop = async () => {
    const state = (await store.readState(name)) || {}
    if (SETTLED.includes(state.status)) return {}
    const bounces = (state.stop_bounces || 0) + 1
    if (bounces > MAX_STOP_BOUNCES) {
      await store.writeState(name, { status: 'failed', stop_bounces: bounces })
      await store.appendLog({ type: 'gave_up', session: name, bounces })
      return {}
    }
    await store.writeState(name, { stop_bounces: bounces })
    await store.appendLog({ type: 'sent_back', session: name, bounces })
    return {
      decision: 'block',
      reason: 'You have not reported. Call mcp__store__submit_report with your result (or mcp__store__ask_orchestrator if you are blocked) before stopping.',
    }
  }

  const one = (fn) => [{ hooks: [fn] }]
  return { PreToolUse: one(preToolUse), PostToolUse: one(postToolUse), Stop: one(stop) }
}
