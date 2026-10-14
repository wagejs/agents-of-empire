/**
 * A markdown file Claude wrote or named in a chat, read so the page can show it beside the chat.
 *
 * Only `.md` / `.markdown`, only a regular file, and only up to a size worth reading on screen.
 * A path is taken as Claude wrote it: absolute, `~/…`, or relative to the thread's folder. The
 * route that calls this answers this machine's browser only, like the rest of the chat.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
const MARKDOWN = /\.(md|markdown)$/i

/** Where `file` points, from the thread's folder `cwd`. Null when it cannot be a markdown file. */
export function resolveMarkdown(file, cwd = '') {
  const raw = String(file || '').trim().replace(/^file:\/\//, '')
  if (!raw || raw.includes('\0') || !MARKDOWN.test(raw)) return null
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw
  if (path.isAbsolute(expanded)) return path.normalize(expanded)
  return cwd && path.isAbsolute(cwd) ? path.resolve(cwd, expanded) : null
}

export async function readMarkdown(file, cwd) {
  const where = resolveMarkdown(file, cwd)
  if (!where) return { ok: false, error: 'Only a markdown file opens here' }
  let real
  try {
    real = await fsp.realpath(where)
  } catch {
    return { ok: false, error: 'That file is not on this machine (any more)' }
  }
  // A link named `.md` pointing at something else is not a markdown file.
  if (!MARKDOWN.test(real)) return { ok: false, error: 'Only a markdown file opens here' }
  const stat = await fsp.stat(real)
  if (!stat.isFile()) return { ok: false, error: 'That is not a file' }
  if (stat.size > MAX_BYTES) return { ok: false, error: 'That file is too big to show here' }
  return { ok: true, path: real, text: await fsp.readFile(real, 'utf8'), mtime: stat.mtimeMs }
}
