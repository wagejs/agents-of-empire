/**
 * The ⌘P browser's side of things: every file in the repos under one root folder, listed, read
 * and searched, so the page can find and show any of them.
 *
 * The root is `~/projects` unless BOT_CROSSING_FILES_ROOT says otherwise. Each folder
 * directly inside it is a repo. A git worktree (a folder whose `.git` is a file, or one named
 * `…-wt`) is a copy of a repo already listed, so it is left out, as are hidden folders.
 *
 * Only what you would see in the repo is listed: git's tracked files plus new ones it does not
 * ignore (`git ls-files -co --exclude-standard`), so a `.env` or anything else gitignored never
 * shows, and cannot be read either: a file is read only when its listing has it. A folder that
 * is not a git repo is walked instead, skipping the usual build and dependency folders.
 *
 * The routes that call this answer this machine's browser only, like the chat.
 */
import { execFile, spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findExecutable } from './lib/fsutil.mjs'

export const FILES_ROOT = path.resolve(process.env.BOT_CROSSING_FILES_ROOT || path.join(os.homedir(), 'projects'))

const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_WALK_FILES = 20_000
const GREP_LIMIT = 500
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '.next', '.venv', '__pycache__', '.terraform', 'coverage'])
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|avif)$/i

const git = (cwd, args, { maxBuffer = 64 * 1024 * 1024 } = {}) =>
  new Promise((resolve, reject) =>
    execFile('git', args, { cwd, maxBuffer, timeout: 30_000 }, (err, stdout) => (err && err.code !== 1 ? reject(err) : resolve(err ? '' : stdout)))
  )

const isDir = (p) => fsp.stat(p).then((s) => s.isDirectory(), () => false)

/** `{ name, dir, git }` for each repo under the root, worktrees and hidden folders left out. */
export async function listRepos(root = FILES_ROOT) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  const repos = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = path.join(root, e.name)
    const dotGit = await fsp.lstat(path.join(dir, '.git')).catch(() => null)
    // A worktree (its files are the main checkout's), or a copy named as one.
    if (dotGit?.isFile() || /-wt(-|$)/.test(e.name)) continue
    repos.push({ name: e.name, dir, git: Boolean(dotGit?.isDirectory()) })
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name))
}

/** A folder that is not a repo, walked: every file under it, capped, build output skipped. */
async function walk(dir) {
  const out = []
  const visit = async (rel) => {
    if (out.length >= MAX_WALK_FILES) return
    const entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.') || out.length >= MAX_WALK_FILES) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(p)
      } else if (e.isFile()) out.push(p)
    }
  }
  await visit('')
  return out.sort()
}

/**
 * A repo's files, cached until git's index or the folder changes. The index moves on every
 * add, commit and checkout; a new untracked file changes its folder's mtime, which for a file
 * deep down is missed until the next index change. ponytail: good enough for finding files;
 * a watcher if new deep files must show the instant they are written.
 */
const listCache = new Map()

export async function repoFiles(repo) {
  const stamp = repo.git
    ? await fsp.stat(path.join(repo.dir, '.git', 'index')).then((s) => s.mtimeMs, () => 0)
    : Math.floor(Date.now() / 60_000)
  const top = await fsp.stat(repo.dir).then((s) => s.mtimeMs, () => 0)
  const key = `${stamp}:${top}`
  const hit = listCache.get(repo.dir)
  if (hit?.key === key) return hit.files
  const files = repo.git
    ? (await git(repo.dir, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    : await walk(repo.dir)
  listCache.set(repo.dir, { key, files, set: new Set(files) })
  return files
}

/** The branch a git repo has checked out, for the viewer's header. */
const branchOf = (repo) =>
  repo.git ? git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim(), () => '') : Promise.resolve('')

/** Every repo with its files: what the palette searches as you type. */
export async function listFiles(root = FILES_ROOT) {
  const repos = await listRepos(root)
  return {
    root,
    repos: await Promise.all(
      repos.map(async (r) => ({ name: r.name, git: r.git, branch: await branchOf(r), files: await repoFiles(r).catch(() => []) }))
    ),
  }
}

/** The repo `name` under the root, or null: a name is only ever one folder, never a path. */
async function repoNamed(name, root) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.startsWith('.')) return null
  return (await listRepos(root)).find((r) => r.name === name) || null
}

/**
 * Where an absolute path sits: `{ repo, rel }` when it is a listed file of a repo under the
 * root, else null. Symlinks are followed first, so a link cannot lead out of the root.
 */
export async function locate(abs, root = FILES_ROOT) {
  if (typeof abs === 'string' && abs.startsWith('~/')) abs = path.join(os.homedir(), abs.slice(2))
  if (typeof abs !== 'string' || !path.isAbsolute(abs) || abs.includes('\0')) return null
  const real = await fsp.realpath(abs).catch(() => null)
  const realRoot = await fsp.realpath(root).catch(() => root)
  if (!real || !real.startsWith(realRoot + path.sep)) return null
  const [name, ...rest] = path.relative(realRoot, real).split(path.sep)
  const repo = await repoNamed(name, root)
  if (!repo || !rest.length) return null
  const rel = rest.join('/')
  await repoFiles(repo)
  return listCache.get(repo.dir)?.set.has(rel) ? { repo, rel } : null
}

/**
 * A path as Claude writes it in a chat, found: relative to the thread's folder `cwd` if it is
 * there, else the one file whose path ends with it (`product/service_test.go` for
 * `internal/services/product/service_test.go`), in the thread's repo first and then in any. Several equally good matches: the shortest path. None: null.
 */
export async function findFile(cwd, ref, root = FILES_ROOT) {
  if (typeof ref !== 'string' || !ref || ref.includes('\0')) return null
  if (ref.startsWith('/') || ref.startsWith('~/')) return locate(ref, root)
  if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
    const direct = await locate(path.join(cwd, ref), root)
    if (direct) return direct
  }
  const realRoot = await fsp.realpath(root).catch(() => root)
  const inside = typeof cwd === 'string' && cwd.startsWith(realRoot + path.sep) ? path.relative(realRoot, cwd).split(path.sep)[0] : ''
  const tail = ref.replace(/^\.\//, '')
  const repos = await listRepos(root)
  const search = async (only) => {
    let best = null
    for (const repo of repos) {
      if (only && repo.name !== only) continue
      for (const f of await repoFiles(repo).catch(() => [])) {
        if ((f === tail || f.endsWith(`/${tail}`)) && (!best || f.length < best.rel.length)) best = { repo, rel: f }
      }
    }
    return best
  }
  // A chat in one repo can name a file of another, the frontend's from a backend thread.
  return (inside && (await search(inside))) || search('')
}

/** One file, by repo and path, by absolute path, or by `{ cwd, ref }` as a chat names it. */
export async function readFile({ repo: name, path: rel, abs, cwd, ref } = {}, root = FILES_ROOT) {
  let where = null
  if (ref) where = await findFile(cwd, ref, root)
  else if (abs) where = await locate(abs, root)
  else {
    const repo = await repoNamed(name, root)
    if (repo && typeof rel === 'string') where = await locate(path.join(repo.dir, rel), root)
    if (where && where.repo.name !== repo.name) where = null // `../other-repo/…` is not this repo's
  }
  if (!where) return { ok: false, error: 'That file is not in a repo under the browser folder (or git ignores it)' }
  const file = path.join(where.repo.dir, where.rel)
  const stat = await fsp.stat(file)
  const base = { ok: true, repo: where.repo.name, path: where.rel, abs: file, size: stat.size, mtime: stat.mtimeMs, branch: await branchOf(where.repo) }
  if (IMAGE.test(file)) return { ...base, kind: 'image' }
  if (stat.size > MAX_READ_BYTES) return { ...base, kind: 'large' }
  const buf = await fsp.readFile(file)
  // A NUL in the first few KB is how git decides a file is binary too.
  if (buf.subarray(0, 8000).includes(0)) return { ...base, kind: 'binary' }
  return { ...base, kind: 'text', text: buf.toString('utf8') }
}

/** An image's bytes and type, for the viewer's <img>; the same listing rule as text. */
export async function readImage(query, root = FILES_ROOT) {
  const file = await readFile(query, root)
  if (!file.ok || file.kind !== 'image') return null
  const ext = path.extname(file.abs).slice(1).toLowerCase()
  const type = { svg: 'image/svg+xml', jpg: 'image/jpeg', ico: 'image/x-icon' }[ext] || `image/${ext}`
  return { type, body: await fsp.readFile(file.abs) }
}

/**
 * Lines containing `query`, case-insensitive, as plain text not a pattern: `git grep` in each
 * git repo, eight at a time, so every repo under projects answers in about a second. A
 * folder that is not a repo is not searched. Capped at 500 lines all told.
 */
export async function grepFiles({ query, repo: only } = {}, root = FILES_ROOT) {
  const q = String(query || '')
  if (q.trim().length < 2) return { ok: true, hits: [], more: false }
  const repos = (await listRepos(root)).filter((r) => r.git && (!only || r.name === only))
  const hits = []
  let more = false
  const queue = [...repos]
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      if (hits.length >= GREP_LIMIT) return (more = true)
      // --untracked: new files Claude wrote are searched too; ignored ones still are not.
      const out = await git(r.dir, ['grep', '-n', '-I', '-i', '-F', '--untracked', '--max-count=20', '-e', q]).catch(() => '')
      for (const line of out.split('\n')) {
        const m = /^(.*?):(\d+):(.*)$/.exec(line)
        if (!m) continue
        if (hits.length >= GREP_LIMIT) {
          more = true
          break
        }
        hits.push({ repo: r.name, path: m[1], line: Number(m[2]), text: m[3].slice(0, 300) })
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  hits.sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path) || a.line - b.line)
  return { ok: true, hits, more }
}

/** Open a file in VS Code at a line, through its `code` command when it is installed. */
export async function openInEditor(query, root = FILES_ROOT) {
  const file = await readFile(query, root)
  if (!file.ok) return file
  const line = Math.max(1, Number(query.line) || 1)
  const code = await findExecutable('code', ['/usr/local/bin', '/opt/homebrew/bin'])
  const [bin, args] = code ? [code, ['-g', `${file.abs}:${line}`]] : ['open', ['-a', 'Visual Studio Code', file.abs]]
  spawn(bin, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
  return { ok: true }
}
