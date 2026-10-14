import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readMarkdown, resolveMarkdown } from '../server/mdfile.mjs'

test('a markdown path is read as Claude wrote it: absolute, ~/, or from the thread folder', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdfile-'))
  await fsp.mkdir(path.join(dir, 'docs'))
  await fsp.writeFile(path.join(dir, 'docs', 'plan.md'), '# Plan\n\nstep one')
  const fromCwd = await readMarkdown('docs/plan.md', dir)
  assert.equal(fromCwd.ok, true)
  assert.match(fromCwd.text, /step one/)
  assert.equal((await readMarkdown(path.join(dir, 'docs', 'plan.md'))).ok, true)
  assert.equal(resolveMarkdown('~/notes.md'), path.join(os.homedir(), 'notes.md'))
  // Relative with no folder to resolve against: nothing to read.
  assert.equal(resolveMarkdown('docs/plan.md', ''), null)

  // Only markdown, only files, and a link named .md to something else is not markdown.
  await fsp.writeFile(path.join(dir, 'secret.env'), 'TOKEN=x')
  assert.equal((await readMarkdown('secret.env', dir)).ok, false)
  await fsp.symlink(path.join(dir, 'secret.env'), path.join(dir, 'sneaky.md'))
  assert.equal((await readMarkdown('sneaky.md', dir)).ok, false)
  await fsp.mkdir(path.join(dir, 'folder.md'))
  assert.equal((await readMarkdown('folder.md', dir)).ok, false)
  assert.equal((await readMarkdown('missing.md', dir)).ok, false)
  await fsp.rm(dir, { recursive: true, force: true })
})
