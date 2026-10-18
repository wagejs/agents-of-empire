/**
 * What a repo session may do without you, and what waits for your Allow or Deny.
 *
 * An implementing session runs allow-all inside its worktree, under your own Claude settings:
 * your `deny` rules (user and repo) still deny, natively. Three things wait for you instead:
 *   push    `git push`, `gh pr create/merge/…`: until you have approved 5 of them for that repo
 *   danger  commands that reach past the worktree: clusters, databases, cloud, publish, writes
 *           over HTTP. A pattern list, so a speed bump rather than a wall (see the ponytail note)
 *   rule    anything your `ask` rules name
 * Every answer is recorded per repo in the store's permits.json.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeAtomic } from './store.mjs'

/** Approved pushes or PRs after which a repo's sessions push and open PRs without asking. */
export const TRUST_AFTER = 5

// Anywhere in the part, so `env X=1 git push`, `git -c a=b push` and `sh -c "git push"` wait too.
const PUSH = /(\bgit\b.*\bpush\b|\bgh\b.*\bpr\s+(create|merge|ready|edit|close|reopen|comment|review)\b)/
// ponytail: matched on the command text, so a script that does the same thing slips past it.
// Writes stay inside the worktree (the guard); turn on Claude Code's sandbox if that is not enough.
const DANGER =
  /^\s*(kubectl\s+(apply|create|delete|edit|patch|replace|scale|rollout|annotate|label|exec)|helm\s+(install|upgrade|uninstall|rollback|delete)|terraform\s+(apply|destroy|import|state)|terragrunt\s+(apply|destroy|run-all|import)|gcloud\b|gsutil\s+(cp|mv|rm|rsync)|aws\b|mysql\b|psql\b|mongo(sh)?\b|redis-cli\b|(npm|pnpm|yarn)\s+publish|docker\s+push|curl\s+.*(-X\s*['"]?(POST|PUT|PATCH|DELETE)|--data\b|-d\s|--form\b|-F\s)|wget\s+.*--post|.*\bmigrate\b|gh\s+api\s+.*(-X|--method|-f\s|-F\s|--field|--raw-field|--input)|gh\s+(release|repo|secret|variable|workflow)\s+(create|delete|edit|set|run|rename))/i

/** Wrappers that run the command after them: `env X=1`, `sudo`, `sh -c "…"`, `xargs`. */
const WRAPPERS = /^(?:(?:env|sudo|command|exec|nohup|time|xargs|nice)\s+(?:-\S+\s+)*|\w+=\S*\s+|(?:ba|z)?sh\s+-c\s+['"]?|\(\s*)+/
const parts = (cmd) =>
  String(cmd).split(/&&|\|\||;|\||\n|&/).map((p) => p.trim().replace(WRAPPERS, '')).filter(Boolean)

/** Claude Code's rule syntax, for the rules that matter here: bare tools, MCP servers, Bash(...). */
export function ruleMatches(rule, toolName, input = {}) {
  const m = /^([^()]+?)(?:\((.*)\))?$/.exec(String(rule).trim())
  if (!m) return false
  const [, tool, spec] = m
  if (spec === undefined) return toolName === tool || toolName.startsWith(`${tool}__`)
  if (tool !== toolName || tool !== 'Bash') return false
  const test = spec.endsWith(':*')
    ? (p) => p.startsWith(spec.slice(0, -2))
    : ((re) => (p) => re.test(p))(new RegExp(`^${spec.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`))
  return parts(input.command).some(test)
}

/** Your `ask` rules: user settings, then the repo's own (committed and local). */
export function askRules(repoPaths = []) {
  const files = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json'),
    ...repoPaths.flatMap((r) => [path.join(r, '.claude', 'settings.json'), path.join(r, '.claude', 'settings.local.json')]),
  ]
  const rules = []
  for (const f of files) {
    try {
      rules.push(...(JSON.parse(fs.readFileSync(f, 'utf8')).permissions?.ask || []))
    } catch {
      /* no file, or not JSON: no rules from it */
    }
  }
  return rules
}

/** Whether a call waits for you, and why. Null for everything that just runs. */
export function classify(toolName, input = {}, rules = []) {
  if (toolName === 'Bash') {
    const cmds = parts(input.command)
    if (cmds.some((p) => PUSH.test(p))) return { kind: 'push', reason: 'pushes or changes a pull request' }
    if (cmds.some((p) => DANGER.test(p))) return { kind: 'danger', reason: 'reaches past the worktree' }
  }
  const rule = rules.find((r) => ruleMatches(r, toolName, input))
  return rule ? { kind: 'rule', reason: `your ask rule ${rule}` } : null
}

// ---------------------------------------------------------------------------------------------
// Asks waiting for you, and the record of your answers

const shared = (globalThis[Symbol.for('agents-of-empire.permit')] ??= { pending: new Map(), listeners: new Set() })

/** Hear about each new ask: the orchestrator is told through this. */
export const onAsk = (fn) => (shared.listeners.clear(), shared.listeners.add(fn))

const recordFile = (store) => path.join(store.paths.root, 'permits.json')
export function readPermits(store) {
  try {
    return JSON.parse(fs.readFileSync(recordFile(store), 'utf8'))
  } catch {
    return { repos: {} }
  }
}

export const trusted = (store, repo) => (readPermits(store).repos?.[repo]?.push_approved || 0) >= TRUST_AFTER

async function record(store, repo, entry) {
  const all = readPermits(store)
  const r = ((all.repos ||= {})[repo] ||= { push_approved: 0, decisions: [] })
  r.decisions.push({ at: new Date().toISOString(), ...entry })
  if (entry.kind === 'push' && entry.choice === 'allow' && !entry.auto) r.push_approved += 1
  await writeAtomic(recordFile(store), JSON.stringify(all, null, 2) + '\n')
  return r
}

const summary = (toolName, input) => String(input.command || input.file_path || input.url || JSON.stringify(input)).slice(0, 400)

/**
 * Hold a call until you answer it on the page; a push in a trusted repo goes straight through,
 * and is still written down. Resolves 'allow' or 'deny'.
 */
export async function requestPermit(store, { session, repo, toolName, input, kind, reason }) {
  const command = summary(toolName, input)
  if (kind === 'push' && trusted(store, repo)) {
    await record(store, repo, { session, kind, tool: toolName, command, choice: 'allow', auto: true })
    return 'allow'
  }
  const id = randomUUID()
  const answer = new Promise((resolve) => shared.pending.set(id, { id, session, repo, tool: toolName, command, kind, reason, at: Date.now(), resolve }))
  for (const fn of shared.listeners) Promise.resolve(fn(shared.pending.get(id))).catch(() => {})
  return answer
}

/** Your answer to one ask: lets the call through or refuses it, and records it for the repo. */
export async function answerPermit(store, id, choice) {
  const ask = shared.pending.get(id)
  if (!ask) throw new Error('That request is no longer waiting')
  if (choice !== 'allow' && choice !== 'deny') throw new Error('Answer allow or deny')
  shared.pending.delete(id)
  const r = await record(store, ask.repo, { session: ask.session, kind: ask.kind, tool: ask.tool, command: ask.command, choice })
  ask.resolve(choice)
  return { repo: ask.repo, push_approved: r.push_approved, trusted: r.push_approved >= TRUST_AFTER }
}

/** What each session is waiting on you for, for the page. */
export const pendingAsks = () => [...shared.pending.values()].map(({ resolve, ...a }) => a)

/** A session that ends with asks open drops them: nothing is left to let through. */
export function dropAsks(session) {
  for (const [id, a] of shared.pending) if (a.session === session) (shared.pending.delete(id), a.resolve('deny'))
}
