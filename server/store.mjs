/**
 * The shared knowledge store: what the orchestrator and its sessions agree on, kept as files.
 *
 *   index.md     one line per note, rebuilt by the orchestrator
 *   log.jsonl    append only: every tool call, report and approval
 *   graphs.json  the code graphs sessions may query, and the commit each was built at
 *   notes/       one file per decision, fact, open question or artifact
 *   sessions/<name>/  brief.md, thread.md, report.md, question.md, state.json
 *
 * It lives beside Claude Code's own config, `~/.claude/.store` (or `$CLAUDE_CONFIG_DIR/.store`),
 * so anything on the machine can read it. `AGENTS_OF_EMPIRE_STORE` moves it; the tests do.
 *
 * A note is never deleted. Replacing one marks it `superseded` and links it to its successor.
 * The graph of notes is never stored either: `buildGraph` derives it from the notes' `links`.
 * Graph *content* never lands here, only `code_refs` pointing into it and the conclusions.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const NOTE_TYPES = ['decision', 'fact', 'question', 'artifact']
export const NOTE_STATUSES = ['active', 'superseded']
export const CONFIDENCES = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS']
export const STALE = 'stale_code_ref'

export const defaultStoreRoot = () =>
  process.env.AGENTS_OF_EMPIRE_STORE || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.store')

/** Where repos named by bare name live. */
export const defaultReposDir = () => process.env.AGENTS_OF_EMPIRE_REPOS || path.join(os.homedir(), 'projects')

/** The CLI that rebuilds a graph: your own install first, since a server's PATH rarely has `~/.local/bin`. */
const graphifyBin = () => {
  if (process.env.GRAPHIFY_BIN) return process.env.GRAPHIFY_BIN
  const local = path.join(os.homedir(), '.local', 'bin', 'graphify')
  return fs.existsSync(local) ? local : 'graphify'
}

const SESSION_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const NOTE_ID = /^[a-z0-9][a-z0-9_.-]{0,127}$/i

export function assertSessionName(name) {
  if (!SESSION_NAME.test(String(name || ''))) throw new Error(`Bad session name: ${name}`)
  return name
}

// ---------------------------------------------------------------------------------------------
// Atomic writes and locks

/** Write to a temp file beside the target, then rename: a reader sees the old file or the new one. */
export async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fsp.writeFile(tmp, text)
  await fsp.rename(tmp, file)
}

const LOCK_WAIT_MS = 10_000
const LOCK_STALE_MS = 30_000

/**
 * Run `fn` holding `<file>.lock`, an O_EXCL file, so two writers (two sessions' hooks, or a hook
 * and the orchestrator) never interleave a read-modify-write. A lock older than 30s belonged to
 * a process that died holding it and is taken over.
 */
export async function withLock(file, fn) {
  const lock = `${file}.lock`
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const start = Date.now()
  for (;;) {
    try {
      const fh = await fsp.open(lock, 'wx')
      await fh.writeFile(String(process.pid))
      await fh.close()
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const age = await fsp.stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0)
      if (age > LOCK_STALE_MS) await fsp.rm(lock, { force: true })
      else if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`Timed out waiting for ${lock}`)
      else await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20))
    }
  }
  try {
    return await fn()
  } finally {
    await fsp.rm(lock, { force: true })
  }
}

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

// ---------------------------------------------------------------------------------------------
// Front matter: a JSON header between `---` lines, then a markdown body. JSON, not YAML, so
// nothing has to be installed to read it and code_refs keep their exact shape.

export function parseFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return { header: {}, body: text }
  return { header: JSON.parse(m[1]), body: m[2] }
}

export const renderFrontMatter = (header, body) => `---\n${JSON.stringify(header, null, 2)}\n---\n\n${(body || '').trim()}\n`

// ---------------------------------------------------------------------------------------------
// Validation

/** A code_ref as a session reports it; throws on anything the store would mis-file. */
export function checkCodeRef(ref) {
  if (!ref || typeof ref !== 'object') throw new Error('code_ref must be an object')
  for (const k of ['repo', 'file', 'sha']) if (!ref[k] || typeof ref[k] !== 'string') throw new Error(`code_ref.${k} is required`)
  if (!CONFIDENCES.includes(ref.confidence)) throw new Error(`code_ref.confidence must be one of ${CONFIDENCES.join(', ')}`)
  return {
    repo: ref.repo,
    node: ref.node || '',
    file: ref.file,
    line: Number.isFinite(Number(ref.line)) ? Number(ref.line) : null,
    sha: ref.sha,
    confidence: ref.confidence,
  }
}

const linkOf = (l) => (typeof l === 'string' ? { id: l, rel: 'links' } : { id: String(l?.id || ''), rel: String(l?.rel || 'links') })

const slug = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

const firstLine = (body) => (String(body || '').split('\n').find((l) => l.trim()) || '').replace(/^#+\s*/, '').trim()

// ---------------------------------------------------------------------------------------------
// The store

export function openStore(root = defaultStoreRoot(), { reposDir = defaultReposDir() } = {}) {
  const p = {
    root,
    index: path.join(root, 'index.md'),
    log: path.join(root, 'log.jsonl'),
    graphs: path.join(root, 'graphs.json'),
    notes: path.join(root, 'notes'),
    sessions: path.join(root, 'sessions'),
  }
  const noteFile = (id) => {
    if (!NOTE_ID.test(String(id || ''))) throw new Error(`Bad note id: ${id}`)
    return path.join(p.notes, `${id}.md`)
  }
  const sessionDir = (name) => path.join(p.sessions, assertSessionName(name))

  const store = {
    paths: p,
    reposDir,
    sessionDir,

    async init() {
      await fsp.mkdir(p.notes, { recursive: true })
      await fsp.mkdir(p.sessions, { recursive: true })
      if (!fs.existsSync(p.index)) await writeAtomic(p.index, '# Shared knowledge index\n')
      if (!fs.existsSync(p.graphs)) await writeAtomic(p.graphs, JSON.stringify({ repos: {} }, null, 2) + '\n')
      if (!fs.existsSync(p.log)) await fsp.writeFile(p.log, '', { flag: 'a' })
      return store
    },

    // --- notes -------------------------------------------------------------------------------

    readIndex: () => fsp.readFile(p.index, 'utf8').catch(() => ''),

    async readNote(id) {
      const { header, body } = parseFrontMatter(await fsp.readFile(noteFile(id), 'utf8'))
      return { ...header, body }
    },

    async listNotes() {
      const files = (await fsp.readdir(p.notes).catch(() => [])).filter((f) => f.endsWith('.md'))
      return Promise.all(files.sort().map((f) => store.readNote(f.slice(0, -3))))
    },

    /**
     * Orchestrator only. A new note, or with `supersedes` the replacement of one: the old note
     * stays, marked `superseded` and linked to this one. Returns the note as written.
     */
    async writeNote({ id, type, tags = [], links = [], status = 'active', created_by = 'orchestrator', code_refs = [], body = '', supersedes } = {}) {
      if (!NOTE_TYPES.includes(type)) throw new Error(`Note type must be one of ${NOTE_TYPES.join(', ')}`)
      if (!NOTE_STATUSES.includes(status)) throw new Error(`Note status must be one of ${NOTE_STATUSES.join(', ')}`)
      const noteId = id || `${type}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${slug(firstLine(body)) || 'note'}-${randomBytes(2).toString('hex')}`
      const file = noteFile(noteId)
      if (fs.existsSync(file)) throw new Error(`Note ${noteId} exists; supersede it instead of overwriting`)
      const header = {
        id: noteId,
        type,
        tags: [...new Set(tags.map(String))],
        links: links.map(linkOf).filter((l) => l.id),
        status,
        created_by,
        created_at: new Date().toISOString(),
        code_refs: code_refs.map(checkCodeRef),
      }
      if (supersedes) header.links.push({ id: supersedes, rel: 'supersedes' })
      await writeAtomic(file, renderFrontMatter(header, body))
      if (supersedes) await store.supersedeNote(supersedes, noteId)
      return { ...header, body }
    },

    /**
     * Orchestrator only. Mark `oldId` superseded by the existing note `newId`: its status
     * changes and it gains a `superseded_by` link; nothing else in it does.
     */
    async supersedeNote(oldId, newId) {
      await store.readNote(newId)
      const { body, ...header } = await store.readNote(oldId)
      header.status = 'superseded'
      if (!header.links?.some((l) => l.id === newId && l.rel === 'superseded_by')) {
        header.links = [...(header.links || []), { id: newId, rel: 'superseded_by' }]
      }
      await writeAtomic(noteFile(oldId), renderFrontMatter(header, body))
      await store.appendLog({ type: 'supersede', note: oldId, by: newId })
      return { ...header, body }
    },

    /** Orchestrator only. Rebuild index.md from the notes, one line each, flagging stale code_refs. */
    async updateIndex() {
      const notes = await store.listNotes()
      const lines = ['# Shared knowledge index', '']
      for (const note of notes) lines.push(await indexLine(note))
      await writeAtomic(p.index, lines.join('\n') + '\n')
      return notes.length
    },

    // --- log ---------------------------------------------------------------------------------

    async appendLog(entry) {
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
      await withLock(p.log, () => fsp.appendFile(p.log, line))
    },

    readLog: async () =>
      (await fsp.readFile(p.log, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),

    // --- sessions ----------------------------------------------------------------------------

    async createSession(name, brief) {
      const dir = sessionDir(name)
      if (fs.existsSync(path.join(dir, 'state.json'))) throw new Error(`Session ${name} already exists`)
      await fsp.mkdir(dir, { recursive: true })
      await writeAtomic(path.join(dir, 'brief.md'), brief)
      await store.writeState(name, { name, session_id: '', status: 'created', last_report_time: null })
      return dir
    },

    readState: (name) => readJson(path.join(sessionDir(name), 'state.json'), null),

    /** Merge `data` into state.json under its lock; the hooks and the orchestrator both write it. */
    async writeState(name, data) {
      const file = path.join(sessionDir(name), 'state.json')
      return withLock(file, async () => {
        const next = { ...(await readJson(file, {})), ...data, updated_at: new Date().toISOString() }
        await writeAtomic(file, JSON.stringify(next, null, 2) + '\n')
        return next
      })
    },

    // --- code graphs -------------------------------------------------------------------------

    readRegistry: () => readJson(p.graphs, { repos: {} }),

    repoPath: (name) => (path.isAbsolute(name) ? name : path.join(reposDir, name)),

    /**
     * Orchestrator only. Give each session worktree its own graph at the worktree's base commit,
     * and record it. The graph is seeded from the main repo's graphify-out/ (gitignored, paths
     * relative), so `graphify update` in the worktree re-extracts only what changed; the main
     * repo's graph is never touched. `repos` are addWorktrees' entries; `run` is swapped by tests.
     */
    async refreshGraphs(repos, { run = exec } = {}) {
      const entries = {}
      for (const r of repos) {
        const seed = path.join(r.repo_path, 'graphify-out')
        const graph_path = path.join(r.worktree, 'graphify-out', 'graph.json')
        if (!fs.existsSync(graph_path) && fs.existsSync(path.join(seed, 'graph.json'))) await fsp.cp(seed, path.dirname(graph_path), { recursive: true })
        // No graph yet: building one is a full extract (an LLM pass), not this function's call.
        if (!fs.existsSync(graph_path)) {
          entries[r.name] = { ...r, graph_path: null, built_at: null }
          continue
        }
        let built = await builtAt(graph_path)
        if (built.sha !== r.git_sha) {
          await run(graphifyBin(), ['update', '.'], { cwd: r.worktree, timeout: 15 * 60_000, maxBuffer: 64 << 20 })
          await store.appendLog({ type: 'graph_update', repo: r.name, from: built.sha, to: r.git_sha })
          built = await builtAt(graph_path)
        }
        entries[r.name] = { ...r, graph_path, built_at: built.at }
      }
      await withLock(p.graphs, async () => {
        const reg = await readJson(p.graphs, { repos: {} })
        for (const e of Object.values(entries)) (reg.repos ||= {})[e.name] = { name: e.name, repo_path: e.repo_path, graph_path: e.graph_path, built_at: e.built_at, git_sha: e.git_sha }
        await writeAtomic(p.graphs, JSON.stringify(reg, null, 2) + '\n')
      })
      return entries
    },

    /**
     * Which of a note's code_refs point at a commit the remote base has moved past (as of the
     * last fetch; the local checkout does not count). Marks the note's
     * index line `stale_code_ref` when any do; the note itself is never touched.
     */
    async checkFreshness(noteOrId) {
      const note = typeof noteOrId === 'string' ? await store.readNote(noteOrId) : noteOrId
      const stale = await staleRefs(note)
      if (stale.length) {
        await withLock(p.index, async () => {
          const text = await store.readIndex()
          const out = text
            .split('\n')
            .map((l) => (l.includes(`[${note.id}]`) && !l.includes(STALE) ? `${l} · ${STALE}` : l))
            .join('\n')
          if (out !== text) await writeAtomic(p.index, out)
        })
      }
      return { id: note.id, stale: stale.length > 0, refs: stale }
    },

    /** The notes as a graph, derived on every call from their `links`. Never stored. */
    async buildGraph() {
      const notes = await store.listNotes()
      const nodes = notes.map((n) => ({ id: n.id, type: n.type, status: n.status }))
      const edges = notes.flatMap((n) => (n.links || []).map(linkOf).map((l) => ({ from: n.id, to: l.id, rel: l.rel })))
      return { nodes, edges }
    },
  }

  async function staleRefs(note) {
    const reg = await store.readRegistry()
    const heads = new Map()
    const stale = []
    for (const ref of note.code_refs || []) {
      const repo_path = reg.repos?.[ref.repo]?.repo_path || store.repoPath(ref.repo)
      if (!heads.has(repo_path)) heads.set(repo_path, await gitHead(repo_path, 'origin/HEAD').catch(() => gitHead(repo_path, 'origin/main')).catch(() => ''))
      const head = heads.get(repo_path)
      if (!head || !(head.startsWith(ref.sha) || ref.sha.startsWith(head))) stale.push({ ...ref, head })
    }
    return stale
  }

  async function indexLine(note) {
    const stale = (await staleRefs(note)).length ? ` · ${STALE}` : ''
    const tags = note.tags?.length ? ` · ${note.tags.join(', ')}` : ''
    return `- [${note.id}](notes/${note.id}.md) ${note.type} · ${note.status} · ${firstLine(note.body).slice(0, 140)}${tags}${stale}`
  }

  return store
}

export async function gitHead(repo, rev = 'HEAD') {
  const { stdout } = await exec('git', ['-C', repo, 'rev-parse', rev])
  return stdout.trim()
}

/** The commit a graph was built at, and when; graphify writes the commit into graph.json itself. */
async function builtAt(graphPath) {
  try {
    const [graph, stat] = await Promise.all([fsp.readFile(graphPath, 'utf8'), fsp.stat(graphPath)])
    // ponytail: parses the whole graph (7MB on web-app) for one field; fine once per session start.
    return { sha: JSON.parse(graph).built_at_commit || '', at: stat.mtime.toISOString() }
  } catch {
    return { sha: '', at: null }
  }
}
