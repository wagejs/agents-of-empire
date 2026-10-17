import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { grepFiles, listFiles, readFile } from '../server/files.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' })

test('files: lists repos without worktrees or ignored files, and reads only what it lists', async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'bc-files-')))
  const repo = path.join(root, 'api')
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true })
  await fsp.writeFile(path.join(repo, 'src', 'main.go'), 'package main\n// utm_campaign here\n')
  await fsp.writeFile(path.join(repo, '.gitignore'), '.env\n')
  await fsp.writeFile(path.join(repo, '.env'), 'SECRET=1\n')
  git(repo, 'init', '-q')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'x')
  await fsp.writeFile(path.join(repo, 'new.txt'), 'untracked but not ignored\n')
  git(repo, 'worktree', 'add', '-q', path.join(root, 'api-tree'))
  await fsp.mkdir(path.join(root, 'api-wt'))
  await fsp.mkdir(path.join(root, 'notes', 'node_modules'), { recursive: true })
  await fsp.writeFile(path.join(root, 'notes', 'a.md'), '# a\n')
  await fsp.writeFile(path.join(root, 'notes', 'node_modules', 'x.js'), '')

  const { repos } = await listFiles(root)
  assert.deepEqual(repos.map((r) => r.name), ['api', 'notes'])
  assert.deepEqual(repos[0].files.sort(), ['.gitignore', 'new.txt', 'src/main.go'])
  assert.deepEqual(repos[1].files, ['a.md'])

  const main = await readFile({ repo: 'api', path: 'src/main.go' }, root)
  assert.equal(main.kind, 'text')
  assert.match(main.text, /package main/)
  assert.equal((await readFile({ repo: 'api', path: '.env' }, root)).ok, false)
  assert.equal((await readFile({ repo: 'api', path: '../notes/a.md' }, root)).ok, false)
  assert.equal((await readFile({ repo: '..', path: 'x' }, root)).ok, false)
  assert.equal((await readFile({ abs: path.join(repo, 'src', 'main.go') }, root)).ok, true)
  assert.equal((await readFile({ abs: '/etc/hosts' }, root)).ok, false)

  // As a chat names a file: from the thread's folder, or by the end of its path.
  assert.equal((await readFile({ cwd: repo, ref: 'src/main.go' }, root)).path, 'src/main.go')
  assert.equal((await readFile({ cwd: repo, ref: 'main.go' }, root)).path, 'src/main.go')
  assert.equal((await readFile({ cwd: root, ref: 'main.go' }, root)).repo, 'api')
  assert.equal((await readFile({ cwd: repo, ref: '.env' }, root)).ok, false)

  const { hits } = await grepFiles({ query: 'UTM_CAMPAIGN' }, root)
  assert.deepEqual(hits.map((h) => [h.repo, h.path, h.line]), [['api', 'src/main.go', 2]])
  await fsp.rm(root, { recursive: true, force: true })
})
