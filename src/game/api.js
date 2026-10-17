import { mergeState } from './merge-state.js'

async function req(url, options) {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
  return body
}

const post = (url, payload) =>
  req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

export const fetchThreads = () => req('/api/threads')

/**
 * The colony file, and the base every later save is measured against.
 *
 * `baseUpdatedAt` is the file version this tab last agreed with; `baseSnapshot` is the state as
 * it looked at that moment. The snapshot is the half that matters: without it a conflicted save
 * can only union the two lists, and a union can never express "I un-archived this".
 */
let baseUpdatedAt = 0
let baseSnapshot = null

function adoptBase(state, updatedAt) {
  baseUpdatedAt = Number(updatedAt ?? state?.updatedAt) || 0
  // Cloned, because the page mutates the object it holds. Sharing the reference would let
  // `local` and `base` drift into being the same thing, which reads as "this tab changed
  // nothing" and quietly turns every save back into last-writer-wins.
  baseSnapshot = structuredClone(state)
}

export const fetchState = async () => {
  const state = await req('/api/state')
  adoptBase(state)
  return state
}

/** Enough attempts to get through a burst of saves from another tab, and no more. */
const SAVE_TRIES = 3

/**
 * Save the colony, merging rather than clobbering if another tab got there first.
 *
 * The server answers 409 with what is on disk when this tab's base is stale. That is not a
 * failure to report at the user — it is the normal shape of two tabs being open — so it is
 * merged and re-sent here. The base for the next attempt is the disk state just merged against,
 * which keeps a retry from re-applying edits it has already folded in.
 *
 * Returns the state the caller should hold from now on: the *same object* when nothing
 * conflicted, so the common path never swaps the page's state out from under a click that
 * happened mid-flight, and only a real merge hands back something new.
 */
export async function saveState(state) {
  // Nothing may be written before the file has been read. The page boots holding an EMPTY
  // archive list and only swaps it for the real one when fetchState() resolves; a save that
  // slips out inside that window PUTs the empty list and erases every archive on disk.
  //
  // The optimistic-concurrency guard does not cover it, by design: `baseUpdatedAt` is 0 until
  // a base is adopted, and the server reads a zero base as a first write and allows it. That
  // is right for a fresh install and wrong for a tab whose read failed — and the two are
  // distinguishable here, which is why the guard lives at this seam rather than at the caller.
  // A fresh install still *read* the file; the server answers a missing one with an empty state
  // rather than an error, so `baseSnapshot` is an object. Only a read that never happened
  // leaves it null.
  //
  // The damage hides itself, which is what makes this worth a guard rather than a comment: the
  // scan carries each harness's own archived flag independently of this file, so a wiped list
  // reads back populated rather than empty. Measured twice by the contributor who found it —
  // an archive list of 50 came back as 11, exactly the number with a Claude Code desktop record.
  if (baseSnapshot === null) throw new Error('Refusing to save a colony that was never read')

  let local = state
  for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
    const res = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...local, baseUpdatedAt }),
    })
    const body = await res.json().catch(() => ({}))

    if (res.status === 409) {
      local = mergeState(baseSnapshot, local, body)
      adoptBase(body)
      continue
    }
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
    adoptBase(local, body.updatedAt)
    return local
  }
  // Losing three times running means the other tab is saving faster than we can merge. The
  // caller swallows this: nothing local is lost, and the next save tries again.
  throw new Error('Could not save the colony — another tab kept writing first')
}

/**
 * Hand a thread back to whichever harness owns it — the desktop app comes forward on its own,
 * or a terminal opens with its CLI, whichever `via` asks for.
 *
 * `ref` is opaque here on purpose: it is whatever that harness's adapter needs to find the
 * thread again, and the browser only ever passes it straight back. Nothing in the UI knows
 * what a Claude Code session id, or a Codex rollout id, actually looks like.
 */
export const openThread = (thread, via) => post('/api/open', { harness: thread.harness, ref: thread.ref, via })

/** A brand new thread in a repo, via that harness's own new-session deep link. */
export const newSession = (folder, harness, via) => post('/api/new-session', { folder, harness, via })

export const revealFolder = (folder) => post('/api/reveal', { folder })

/** A thread's recent conversation, and whether it is open somewhere else right now. */
/** A thread's recent conversation; with `before` (a message id), the turns ahead of that one. */
export const chatMessages = (thread, before) =>
  post('/api/chat/messages', { harness: thread.harness, ref: thread.ref, ...(before ? { before } : {}) })

/** Claude Code's own `/rename`, so `claude --resume` lists the thread under the new name too. */
export const renameThread = (thread, title) => post('/api/chat/rename', { harness: thread.harness, ref: thread.ref, title })

/**
 * `choice` is `allow`, `always` or `deny`; the server denies anything else. A question is
 * answered with `answers` instead, one string per question text, and skipped without.
 */
export const chatPermission = (id, choice, answers) => post('/api/chat/permission', { id, choice, answers })

/**
 * Send one message into a thread. The reply runs on the server, so this only returns its
 * `runId`; `chatAttach` is how the page watches it.
 */
export const chatSend = (thread, text, mode, model) =>
  post('/api/chat/send', { harness: thread.harness, ref: thread.ref, threadId: thread.id, text, mode, model })

/**
 * Start a new Claude Code thread in `folder` with its first message. Its run's first event is a
 * `session` carrying the thread, for every message after this one to go to.
 */
export const chatStart = (folder, text, mode, model) => post('/api/chat/new', { folder, text, mode, model })

/** The `/` commands Claude Code offers for a thread, or in the folder of a new one. */
export const chatCommands = ({ thread, folder }) =>
  post('/api/chat/commands', thread ? { harness: thread.harness, ref: thread.ref } : { folder })

/** The PRs a thread opened: `{ prs: [{ number, url, repo }] }`. */
export const threadPrs = (thread) => post('/api/chat/prs', { harness: thread.harness, ref: thread.ref })

/** A markdown file a chat named, to show beside the chat: `{ path, text }`. */
export const chatFile = (path, cwd) => post('/api/chat/file', { path, cwd })

/** Stop the session running a loop skill and start the skill afresh in a new one. */
export const chatFreshLoop = (skill, oldSessionId) => post('/api/chat/loop', { skill, oldSessionId })

/** Switch a running reply's model. */
/** What the chat's link panel shows for a link: a GitHub PR or issue, a framable page, or neither. */
export const chatLink = (url) => post('/api/chat/link', { url })

export const chatModel = (runId, model) => post('/api/chat/model', { runId, model })

/** Switch a running reply's permission mode. */
export const chatMode = (runId, mode) => post('/api/chat/mode', { runId, mode })

/**
 * Watch a run from event `from` on, handing each to `onEvent`. Aborting `signal` stops watching
 * and leaves the reply running. Resolves when the run has finished or the stream drops.
 */
export const chatAttach = (runId, from, onEvent, signal) =>
  streamEvents('/api/chat/attach', { runId, from }, onEvent, signal)

export const chatStop = (runId) => post('/api/chat/stop', { runId })

/** Shared sessions: what a plan.md would start, and starting its orchestrator. */
export const sharePreview = (plan) => post('/api/share/preview', { plan })
export const shareStart = (plan, models) => post('/api/share/start', { plan, models })
/** How far Opus has got exercising a previewed plan, per repo. */
export const shareExercise = (job) => post('/api/share/exercise', { job })
/** Your Allow or Deny for something a repo session is waiting on. */
export const shareAnswer = (id, choice) => post('/api/share/answer', { id, choice })
/** What you said to a repo session yourself, passed on to its orchestrator. */
export const shareReport = (ref) => post('/api/share/report', { ref })

/** The reply is NDJSON, one event per line, so a tool approval can arrive mid-stream. */
async function streamEvents(url, payload, onEvent, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw Object.assign(new Error(body.error || `${res.status} ${res.statusText}`), { status: res.status })
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line))
  }
}

/** The ⌘P browser: every repo under its folder with its files, `{ root, repos: [{ name, branch, files }] }`. */
export const filesList = () => post('/api/files/list', {})
/** One file, by `{ repo, path }` or `{ abs }`: `{ kind: 'text'|'image'|'large'|'binary', text, … }`. */
export const filesRead = (where) => post('/api/files/read', where)
/** Lines containing `query` across the repos, or in `repo` alone. */
export const filesGrep = (query, repo) => post('/api/files/grep', { query, repo })
export const filesOpenInEditor = (repo, path, line) => post('/api/files/open', { repo, path, line })
export const fileImageUrl = (repo, path) => `/api/files/image?${new URLSearchParams({ repo, path })}`
