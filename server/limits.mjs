/**
 * Your Claude plan's usage limits — the numbers `/usage` shows — as Claude Code last reported them.
 *
 * Claude Code hands them to the status line command on every refresh (`rate_limits` in its stdin
 * JSON, Pro and Max plans only), and the status line script saves them to a file here. Read from
 * that file and nowhere else: the app never touches Claude Code's credentials or calls the usage
 * endpoint itself, so the numbers are only as fresh as the last running session made them.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { defaultStoreRoot } from './store.mjs'

export const limitsFile = () => process.env.AGENTS_OF_EMPIRE_LIMITS || path.join(defaultStoreRoot(), 'limits.json')

const WINDOWS = ['five_hour', 'seven_day']

/** `{ five_hour?: { used, resetsAt }, seven_day?: …, at }` in ms, or null when there is nothing usable. */
export async function readLimits(file = limitsFile(), now = Date.now()) {
  let raw
  try {
    raw = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
  const out = { at: Number(raw?.at) * 1000 || 0 }
  for (const w of WINDOWS) {
    const used = Number(raw?.[w]?.used_percentage)
    const resetsAt = Number(raw?.[w]?.resets_at) * 1000
    // A window that has already reset says nothing about now.
    if (!Number.isFinite(used) || !(resetsAt > now)) continue
    out[w] = { used: Math.max(0, Math.min(100, used)), resetsAt }
  }
  return out.five_hour || out.seven_day ? out : null
}
