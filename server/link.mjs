/**
 * What the chat's link panel shows for a link.
 *
 * A GitHub pull request or issue is read through your own `gh` login and drawn by the page:
 * github.com refuses to be framed, so showing it in the page at all means fetching it here.
 * Anything else is framed as it is, when the site allows that; otherwise the panel offers to
 * open it in the browser.
 */
import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { findExecutable } from './lib/fsutil.mjs'

const GITHUB = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/

const PR_FIELDS = [
  'number', 'title', 'state', 'isDraft', 'author', 'body', 'url', 'headRefName', 'baseRefName',
  'additions', 'deletions', 'changedFiles', 'reviewDecision', 'mergeStateStatus', 'statusCheckRollup',
  'reviews', 'comments', 'files', 'createdAt', 'updatedAt',
]
const ISSUE_FIELDS = ['number', 'title', 'state', 'author', 'body', 'url', 'labels', 'comments', 'createdAt', 'updatedAt']

const run = (bin, args) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim().split('\n')[0])) : resolve(stdout)
    )
  )

/** `{ owner, repo, kind: 'pull'|'issues', number }` for a GitHub PR or issue link, else null. */
export function githubRef(url) {
  const m = GITHUB.exec(String(url))
  return m ? { owner: m[1], repo: m[2], kind: m[3], number: m[4] } : null
}

/** Whether a site lets another page frame it, judged from its response headers. */
export function frameable(headers) {
  const xfo = String(headers.get('x-frame-options') || '').toLowerCase()
  const csp = String(headers.get('content-security-policy') || '').toLowerCase()
  if (xfo === 'deny' || xfo === 'sameorigin') return false
  const ancestors = /frame-ancestors([^;]*)/.exec(csp)
  return !ancestors || /(^|\s)\*(\s|$)/.test(ancestors[1])
}

export async function previewLink(url, { gh = findExecutable('gh', ['/opt/homebrew/bin', '/usr/local/bin']) } = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: 'Not a link' }
  }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'Only web links open here' }

  const ref = githubRef(url)
  const bin = ref && (await gh)
  if (ref && bin) {
    const repo = `${ref.owner}/${ref.repo}`
    const [command, fields] = ref.kind === 'pull' ? ['pr', PR_FIELDS] : ['issue', ISSUE_FIELDS]
    try {
      const data = JSON.parse(await run(bin, [command, 'view', ref.number, '-R', repo, '--json', fields.join(',')]))
      return { ok: true, kind: ref.kind === 'pull' ? 'pr' : 'issue', repo, data }
    } catch (err) {
      return { ok: true, kind: 'blocked', error: `gh could not read it: ${err.message}` }
    }
  }

  // ponytail: headers only, without your cookies, so a site that frames only for logged-in
  // visitors is judged by what it tells a stranger.
  // A link from a reply never makes the server knock on your own network: a host that resolves
  // to a loopback, private or link-local address is framed without asking it first.
  if (await isInternal(url)) return { ok: true, kind: 'frame' }
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000) })
    res.body?.cancel()
    return { ok: true, kind: frameable(res.headers) ? 'frame' : 'blocked' }
  } catch {
    return { ok: true, kind: 'frame' }
  }
}

/**
 * Where each PR stands, for the pills: draft, open, approved, changes, merged or closed. One `gh`
 * call a PR, all at once, each kept for a couple of minutes; a PR `gh` cannot read keeps no status.
 * ponytail: one call per PR; a GraphQL batch per repo if sessions ever carry dozens.
 */
const STATE_TTL_MS = 120_000
const stateCache = new Map()

export function prStatus({ state, isDraft, reviewDecision } = {}) {
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  if (isDraft) return 'draft'
  if (reviewDecision === 'APPROVED') return 'approved'
  if (reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  return 'open'
}

export async function withPrStatus(prs, { gh = findExecutable('gh', ['/opt/homebrew/bin', '/usr/local/bin']), now = Date.now() } = {}) {
  const bin = await gh
  if (!bin) return prs
  return Promise.all(
    prs.map(async (pr) => {
      const ref = githubRef(pr.url)
      if (!ref || ref.kind !== 'pull') return pr
      let hit = stateCache.get(pr.url)
      if (!hit || now - hit.at > STATE_TTL_MS) {
        const ask = run(bin, ['pr', 'view', ref.number, '-R', `${ref.owner}/${ref.repo}`, '--json', 'state,isDraft,reviewDecision'])
          .then((out) => prStatus(JSON.parse(out)), () => '')
        hit = { at: now, status: ask }
        stateCache.set(pr.url, hit)
      }
      const status = await hit.status
      return status ? { ...pr, status } : pr
    })
  )
}

/** Whether a URL's host is this machine or the local network, by every address it resolves to. */
export async function isInternal(url) {
  let host
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return true
  }
  let addrs
  try {
    addrs = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  } catch {
    return true
  }
  return addrs.some((a) => {
    const v4 = a.startsWith('::ffff:') ? a.slice(7) : a
    if (net.isIPv4(v4)) {
      const [x, y] = v4.split('.').map(Number)
      return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127)
    }
    const low = a.toLowerCase()
    return low === '::1' || low === '::' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')
  })
}
