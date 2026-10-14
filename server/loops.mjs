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
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { activeRun, queueMessage, renameThread, startChat, stopRun } from './chat.mjs'
import { newChatThread } from './harnesses/claude-code.mjs'

export const LOOP_SKILLS = ['pr-watch', 'review-queue']

const HOME = os.homedir()
/** Where both skills have always run: Claude Code's own folder. */
const LOOP_CWD = path.join(HOME, '.claude')
const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || LOOP_CWD, 'projects')

const until = async (test, ms, step = 250) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (test()) return true
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
 * Stop `oldSessionId`'s run if one is going, then start the skill afresh. Resolves once the new
 * session has an id, with the thread the page can open. `startChat` is the chat's, unless a
 * test hands in its own.
 */
export async function freshLoop({ skill, oldSessionId = '' }, { start = startChat } = {}) {
  if (!LOOP_SKILLS.includes(skill)) throw new Error(`Not a loop skill: ${skill}`)
  const running = oldSessionId && activeRun(oldSessionId)
  if (running) {
    stopRun(running.id)
    // Its process takes its schedule with it; wait, so two timers are never live at once.
    await until(() => running.done, 15_000)
  }
  const run = await start(LOOP_CWD, `/${skill} start`, LOOP_MODE)
  if (!(await until(() => run.sessionId, 90_000))) throw new Error('The new session did not start in time')
  queueMessage(run, handoff(skill, oldSessionId, await transcriptOf(oldSessionId)))
  await renameThread({ sessionId: run.sessionId }, skill).catch(() => {})
  return { runId: run.id, mode: LOOP_MODE, thread: { ...newChatThread(run.sessionId, LOOP_CWD), title: skill, project: path.basename(LOOP_CWD) } }
}
