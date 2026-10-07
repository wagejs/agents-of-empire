/** The Medieval planet's buildings: which one a thread shows, and that the packed kit has it. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { medievalLook } from '../src/world/buildings.js'

const glb = readFileSync(new URL('../public/assets/medieval.glb', import.meta.url))
const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)))
const nodes = new Set(json.nodes.map((n) => n.name))

test('a young thread shows construction, a grown one a building in its status colour', () => {
  assert.equal(medievalLook(7, 0.1, 'working').model, 'building_scaffolding')
  assert.equal(medievalLook(7, 0.45, 'working').model, 'building_stage_B')
  const built = medievalLook(7, 0.7, 'working')
  assert.equal(built.team, 'green')
  assert.match(built.model, /^building_\w+_green$/)
  assert.equal(medievalLook(7, 0.7, 'waiting').team, 'blue')
  assert.equal(medievalLook(7, 0.7, 'blocked').team, 'red')
  assert.equal(medievalLook(7, 0.7, 'celebrating').team, 'yellow')
  // The same thread keeps the same kind of building whatever its status.
  assert.equal(medievalLook(7, 0.7, 'waiting').type, built.type)
})

test('an idle thread keeps a colour of its own, muted', () => {
  const idle = medievalLook(7, 0.7, 'idle')
  assert.equal(idle.muted, true)
  assert.ok(['blue', 'green', 'red', 'yellow'].includes(idle.team))
  assert.equal(medievalLook(7, 0.7, 'working').muted, false)
})

test('only the biggest threads become churches, windmills and great towers, and none a castle', () => {
  const grand = new Set(['church', 'windmill', 'tower_B'])
  for (let seed = 1; seed < 200; seed++) {
    for (const p of [0.1, 0.45, 0.7, 0.95]) assert.notEqual(medievalLook(seed, p, 'working').type, 'castle')
    assert.equal(grand.has(medievalLook(seed, 0.95, 'working').type), true)
    assert.equal(grand.has(medievalLook(seed, 0.7, 'working').type), false)
  }
})

test('every building a thread can show is in the packed kit', () => {
  for (let seed = 1; seed < 400; seed++) {
    for (const progress of [0.1, 0.3, 0.45, 0.55, 0.7, 0.95]) {
      for (const status of ['working', 'waiting', 'blocked', 'celebrating', 'idle']) {
        const look = medievalLook(seed, progress, status)
        assert.ok(nodes.has(look.model), look.model)
        if (look.type === 'windmill') {
          assert.ok(nodes.has(`building_windmill_top_${look.team}`))
          assert.ok(nodes.has(`building_windmill_top_fan_${look.team}`))
        }
      }
    }
  }
})
