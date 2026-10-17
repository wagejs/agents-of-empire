/**
 * Thread search: every word has to land somewhere in what the scan knows about a thread.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { matches } from '../src/game/thread-search.js'

const row = {
  statusLabel: 'Dormant',
  thread: {
    title: 'Add a chat popup',
    preview: 'instead of opening the claude app, show a popup',
    project: 'agents-of-empire',
    gitBranch: 'feature/chat',
    harnessName: 'Claude Code',
  },
}

test('every word must match somewhere, in any order and any case', () => {
  assert.equal(matches(row, ''), true)
  assert.equal(matches(row, 'EMPIRE popup'), true)
  assert.equal(matches(row, 'feature/chat dormant'), true)
  assert.equal(matches(row, 'popup projects'), false)
})
