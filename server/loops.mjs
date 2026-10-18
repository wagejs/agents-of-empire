/**
 * Fresh sessions for the two skills that run all day from the page: /pr-watch and
 * /review-queue. One call stops the session currently running the skill, starts a new one
 * with the skill's own `start`, names it after the skill so the next call finds it, and tells
 * it which session it replaces.
 *
 * What carries over is what the skills keep on disk: their state, drafts, decisions and notes
 * (see each skill's "Where things live"). A new session's `start` reads those, so nothing a
 * skill has learnt is lost. What does not carry over is the old session's conversation and any
 * subagent it was holding, so the handoff points the new session at the old transcript in case
 * a round was cut off half way.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { activeRun, queueMessage, renameThread, startChat, stopRun } from './chat.mjs'
import { newChatThread } from './harnesses/claude-code.mjs'

/** What the Fresh loop row holds until someone edits it from the page. */
export const DEFAULT_LOOPS = ['pr-watch', 'review-queue']
/** A skill name as Claude Code accepts it: what a `/` command and a folder name can both be. */
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i

const HOME = os.homedir()
/** Where both skills have always run: Claude Code's own folder. */
const LOOP_CWD = path.join(HOME, '.claude')
const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || LOOP_CWD, 'projects')

const SKILLS_DIR = () => path.join(process.env.CLAUDE_CONFIG_DIR || LOOP_CWD, 'skills')

/** Every personal skill installed here, by folder name: the ones the page may offer as loops. */
export function installedSkills(dir = SKILLS_DIR()) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((n) => SKILL_NAME.test(n) && fs.existsSync(path.join(dir, n, 'SKILL.md'))).sort()
}

/** The loops chosen on the page, kept in the app's data folder; the defaults until first edited. */
export function readLoops(file) {
  try {
    const skills = JSON.parse(fs.readFileSync(file, 'utf8')).skills
    if (Array.isArray(skills)) return [...new Set(skills.map(String).filter((s) => SKILL_NAME.test(s)))]
  } catch {
    /* no file yet, or unreadable: the defaults */
  }
  return [...DEFAULT_LOOPS]
}

/** Save the row's loops. Only installed skills are kept, in the order given. */
export function writeLoops(file, skills, dir = SKILLS_DIR()) {
  const installed = new Set(installedSkills(dir))
  const kept = [...new Set((Array.isArray(skills) ? skills : []).map(String))].filter((s) => installed.has(s))
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ skills: kept }, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  return kept
}

/** The row as the page draws it: loops that are installed, and the installed skills it could add. */
export function loopStatus(file, dir = SKILLS_DIR()) {
  const installed = installedSkills(dir)
  const skills = readLoops(file).filter((s) => installed.includes(s))
  return { skills, available: installed.filter((s) => !skills.includes(s)) }
}

const until = async (test, ms, step = 250) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await test()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return test()
}

/** The transcript of a session, wherever Claude Code filed it. */
async function transcriptOf(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId || '')) return ''
  for (const dir of await fsp.readdir(PROJECTS).catch(() => [])) {
    const file = path.join(PROJECTS, dir, `${sessionId}.jsonl`)
    if (await fsp.stat(file).then(() => true, () => false)) return file
  }
  return ''
}

export function handoff(skill, oldSessionId, transcript) {
  return [
    `This session replaces an earlier /${skill} session${oldSessionId ? ` (${oldSessionId})` : ''}, which has been stopped.`,
    `Everything the skill keeps on disk carries over: work from its state, drafts and notes as usual.`,
    transcript
      ? `Only if a round, fix or question was left half done, read the end of the old transcript for it: ${transcript}`
      : '',
    `Do not redo work the state files already record as done.`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Loops run in Allow all: a tick pulls and reads PRs on its own, which is the whole point of
 * running it unattended. What the skills put in front of you (post this review? fix this
 * finding?) are questions, not tool approvals, so they still wait for your answer.
 */
export const LOOP_MODE = 'bypassPermissions'

/**
 * Every run going for a skill, whatever its session has come to be called: started by this
 * file, or by hand with `/<skill> …` as its first message. Found by the run, not by the thread's
 * title, because a title is only a name: Claude Code titles a session itself when a rename has
 * not landed, and a session nobody can find by name is one nobody stops, its timer still live.
 */
export function loopRuns(skill) {
  const runs = globalThis[Symbol.for('agents-of-empire.chat')]?.runs?.values() || []
  return [...runs].filter(
    (run) => !run.done && (run.loop === skill || new RegExp(`^/${skill.replace(/[.]/g, '\\.')}(\\s|$)`).test(String(run.prompt || '').trim()))
  )
}

/**
 * Name a session, once Claude Code has a transcript to write the name into. Too early and the
 * rename has nowhere to go, which is how a fresh loop used to end up under a title of Claude
 * Code's own choosing.
 */
export async function nameSession(sessionId, title, { rename = renameThread, wait = 60_000 } = {}) {
  let file = ''
  await until(async () => (file = await transcriptOf(sessionId)), wait, 500)
  if (!file) return false
  for (let tries = 0; tries < 5; tries++) {
    try {
      await rename({ sessionId }, title)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  return false
}

/**
 * Stop `oldSessionId`'s run if one is going, then start the skill afresh. Resolves once the new
 * session has an id, with the thread the page can open. `startChat` is the chat's, unless a
 * test hands in its own.
 */
export async function freshLoop({ skill, oldSessionId = '' }, { start = startChat, name = nameSession } = {}) {
  if (!SKILL_NAME.test(String(skill))) throw new Error(`Not a loop skill: ${skill}`)
  // Every session running this skill stops, not just the one the page knew to name: two live
  // sessions mean two timers ticking.
  const old = loopRuns(skill)
  const named = oldSessionId && activeRun(oldSessionId)
  if (named && !old.includes(named)) old.push(named)
  for (const run of old) stopRun(run.id)
  // Each process takes its schedule with it; wait, so two timers are never live at once.
  await until(() => old.every((run) => run.done), 15_000)
  const stopped = [...new Set([oldSessionId, ...old.map((run) => run.sessionId)].filter(Boolean))]
  const previous = oldSessionId || stopped[0] || ''

  const run = await start(LOOP_CWD, `/${skill} start`, LOOP_MODE)
  run.loop = skill
  if (!(await until(() => run.sessionId, 90_000))) throw new Error('The new session did not start in time')
  queueMessage(run, handoff(skill, previous, await transcriptOf(previous)))
  // Not awaited: the name lands once the transcript exists, which can be a while after start.
  name(run.sessionId, skill).then((ok) => !ok && console.warn(`[loops] could not name ${run.sessionId} "${skill}"`))
  return {
    runId: run.id,
    mode: LOOP_MODE,
    stopped,
    thread: { ...newChatThread(run.sessionId, LOOP_CWD), title: skill, project: path.basename(LOOP_CWD) },
  }
}
