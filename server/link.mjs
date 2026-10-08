/**
 * What the chat's link panel shows for a link.
 *
 * A GitHub pull request or issue is read through your own `gh` login and drawn by the page:
 * github.com refuses to be framed, so showing it in the page at all means fetching it here.
 * Anything else is framed as it is, when the site allows that; otherwise the panel offers to
 * open it in the browser.
 */
import { execFile } from 'node:child_process'
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
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000) })
    res.body?.cancel()
    return { ok: true, kind: frameable(res.headers) ? 'frame' : 'blocked' }
  } catch {
    return { ok: true, kind: 'frame' }
  }
}
