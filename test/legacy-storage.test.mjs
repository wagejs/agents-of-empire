import test from 'node:test'
import assert from 'node:assert/strict'
import { migrate } from '../src/core/legacy-storage.js'

const store = (o) => {
  const s = Object.create({
    getItem(k) { return Object.hasOwn(this, k) ? this[k] : null },
    setItem(k, v) { this[k] = String(v) },
    removeItem(k) { delete this[k] },
  })
  return Object.assign(s, o)
}

test('old keys move to agents-of-empire.*, a newer key wins, others stay', () => {
  const s = store({ 'bot-crossing.chat-modes': 'a', 'botcrossing.settings.v1': 's', 'bot-crossing.plan-size': 'old', 'agents-of-empire.plan-size': 'new', other: 'x' })
  migrate(s)
  assert.deepEqual({ ...s }, { 'agents-of-empire.chat-modes': 'a', 'agents-of-empire.settings.v1': 's', 'agents-of-empire.plan-size': 'new', other: 'x' })
})
