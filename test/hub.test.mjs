import test from 'node:test'
import assert from 'node:assert/strict'
import { allocateCells } from '../src/world/plots.js'

test('the harness home always takes the middle cell and grows outward from it', () => {
  const projects = [{ id: 'app', size: 4 }, { id: '.claude', size: 12 }]
  // Someone else held the middle before; the hub takes it over and they are reseeded.
  const laid = allocateCells(projects, new Map([['app', [{ q: 0, r: 0 }]], ['.claude', [{ q: 3, r: 0 }]]]))
  assert.deepEqual(laid.get('.claude')[0], { q: 0, r: 0 })
  assert.ok(!laid.get('app').some((c) => c.q === 0 && c.r === 0))
  // And keeps its grown cells on the next pass.
  const again = allocateCells(projects, laid)
  assert.deepEqual(again.get('.claude'), laid.get('.claude'))
})
