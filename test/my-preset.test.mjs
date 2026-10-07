/** Your own quality preset: saved once, there to come back to after trying a built-in one. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PRESETS, Settings } from '../src/core/settings.js'

test('Mine keeps what you tuned, and brings it back after another preset', () => {
  const s = new Settings()
  s.applyPreset('balanced')
  s.set('renderScale', 0.7)
  assert.equal(s.get('preset'), 'custom')
  s.saveMine()
  assert.equal(s.get('preset'), 'mine')

  s.applyPreset('potato')
  assert.equal(s.get('renderScale'), PRESETS.potato.values.renderScale)
  s.applyPreset('mine')
  assert.equal(s.get('renderScale'), 0.7)
  assert.equal(s.get('preset'), 'mine')

  // Tweaking it again leaves Mine as saved until you save over it.
  s.set('renderScale', 0.9)
  assert.equal(s.get('preset'), 'custom')
  assert.equal(s.get('myPreset').renderScale, 0.7)
})

test('Mine does nothing before anything is saved', () => {
  const s = new Settings()
  s.applyPreset('balanced')
  s.applyPreset('mine')
  assert.equal(s.get('preset'), 'balanced')
})
