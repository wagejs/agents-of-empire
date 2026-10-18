/**
 * Villages on the board: Misc is the colony as it always was, and Sprint and Side-project are
 * islands of their own, each grown from its own middle and kept clear of Misc by open water.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { allocateCells, allocateWorld } from '../src/world/plots.js'
import { ORIGIN, hexDistance, isConnected, setBlockedCells, villageAnchor } from '../src/world/plot-move.js'

setBlockedCells([])

const misc = (id, size = 1) => ({ id, size })
const hex = (id, village, size = 1) => ({ id, size, village })
const cellsOf = (layout, ids) => ids.flatMap((id) => layout.get(id) || [])
const minGap = (a, b) => Math.min(...a.flatMap((x) => b.map((y) => hexDistance(x, y))))

test('with no hexes, the world is exactly the old colony', () => {
  const projects = [misc('.claude', 12), misc('api', 9), misc('web', 4), misc('cli', 1)]
  assert.deepEqual(allocateWorld(projects).layout, allocateCells(projects))
})

test('Misc lays out exactly as it would alone, hexes or not', () => {
  const projects = [misc('.claude', 12), misc('api', 9), misc('web', 4)]
  const alone = allocateCells(projects)
  const { layout } = allocateWorld([...projects, hex('hex:a', 'sprint', 4), hex('hex:b', 'side', 2)])
  for (const p of projects) assert.deepEqual(layout.get(p.id), alone.get(p.id))
})

test('each village is its own island, with water between it and Misc', () => {
  const projects = [misc('.claude', 12), misc('api', 9), hex('hex:a', 'sprint', 4), hex('hex:b', 'sprint', 1), hex('hex:c', 'side', 1)]
  const { layout, anchors } = allocateWorld(projects)
  const m = cellsOf(layout, ['.claude', 'api'])
  const s = cellsOf(layout, ['hex:a', 'hex:b'])
  const d = cellsOf(layout, ['hex:c'])
  assert.ok(minGap(m, s) >= 2, 'a ring of water between Misc and Sprint')
  assert.ok(minGap(m, d) >= 2, 'and between Misc and Side-project')
  assert.ok(minGap(s, d) >= 2, 'and between the two villages')
  assert.ok(isConnected(new Map([['a', layout.get('hex:a')], ['b', layout.get('hex:b')]])), 'a village is one island')
  assert.ok(anchors.get('sprint').r > 0 && anchors.get('side').r < 0, 'Sprint to one side of Misc, Side-project to the other')
})

test('a village grows from its own middle, like Misc does', () => {
  const { layout, anchors } = allocateWorld([misc('api', 2), hex('hex:a', 'sprint', 1)])
  assert.deepEqual(layout.get('hex:a')[0], anchors.get('sprint'), 'the first hex takes the island’s middle cell')
})

test('a village island keeps its ground across passes', () => {
  const projects = [misc('api', 4), hex('hex:a', 'sprint', 3), hex('hex:b', 'sprint', 1)]
  const first = allocateWorld(projects)
  const again = allocateWorld(projects, first.memory)
  assert.deepEqual(again.layout, first.layout)
})

test('when Misc grows, a village island moves out whole, never in', () => {
  const small = allocateWorld([misc('api', 1), hex('hex:a', 'sprint', 4), hex('hex:b', 'sprint', 1)])
  const many = Array.from({ length: 40 }, (_, i) => misc(`repo${i}`, 1))
  const big = allocateWorld([misc('api', 1), ...many, hex('hex:a', 'sprint', 4), hex('hex:b', 'sprint', 1)], small.memory)
  const shift = big.anchors.get('sprint').r - small.anchors.get('sprint').r
  assert.ok(shift > 0, 'pushed out')
  const moved = (id) => small.layout.get(id).map((c) => ({ q: c.q, r: c.r + shift }))
  assert.deepEqual(big.layout.get('hex:a'), moved('hex:a'), 'the island keeps its shape')
  // Misc shrinks back: the island stays where it went.
  const back = allocateWorld([misc('api', 1), hex('hex:a', 'sprint', 4), hex('hex:b', 'sprint', 1)], big.memory)
  assert.deepEqual(back.anchors.get('sprint'), big.anchors.get('sprint'))
})

test('a restored hex takes back its old cells on its island', () => {
  const projects = [misc('api', 4), hex('hex:a', 'sprint', 1), hex('hex:b', 'sprint', 1)]
  const first = allocateWorld(projects)
  const memory = new Map(first.memory)
  memory.delete('hex:b')
  const without = allocateWorld(projects.filter((p) => p.id !== 'hex:b'), memory)
  const back = allocateWorld(projects, new Map([...without.memory, ['hex:b', first.layout.get('hex:b')]]))
  assert.deepEqual(back.layout.get('hex:b'), first.layout.get('hex:b'))
})

test('archiving the hex that bridged two others slides the far one back on its own island', () => {
  const projects = [misc('api', 2), hex('hex:a', 'side', 1), hex('hex:b', 'side', 1), hex('hex:c', 'side', 1)]
  const first = allocateWorld(projects)
  const memory = new Map(first.memory)
  memory.delete('hex:a')
  const after = allocateWorld(projects.filter((p) => p.id !== 'hex:a'), memory)
  assert.deepEqual(after.layout.get('api'), first.layout.get('api'), 'Misc never moves for a hex')
  assert.ok(isConnected(new Map([['b', after.layout.get('hex:b')], ['c', after.layout.get('hex:c')]])))
})

test('a painted map’s blocked cells near the middle do not reach the village islands', () => {
  setBlockedCells(['0,0', '1,0', '0,1'])
  try {
    const { layout, anchors } = allocateWorld([misc('api', 1), hex('hex:a', 'sprint', 1)])
    assert.deepEqual(layout.get('hex:a')[0], anchors.get('sprint'))
  } finally {
    setBlockedCells([])
  }
})

test('the hub still takes the middle', () => {
  const { layout } = allocateWorld([hex('hex:a', 'sprint', 4), misc('.claude', 3)])
  assert.deepEqual(layout.get('.claude')[0], ORIGIN)
})

test('a village anchor sits straight out along its own direction', () => {
  assert.deepEqual(villageAnchor('sprint', 5), { q: 0, r: 5 })
  assert.deepEqual(villageAnchor('side', 5), { q: 0, r: -5 })
})

test('reconnect keeps the piece holding the middle in place', () => {
  const memory = new Map([
    ['.claude', [{ q: 0, r: 0 }]],
    ['a', [{ q: 1, r: 0 }]],
    ['b', [{ q: 2, r: 0 }]],
    ['c', [{ q: 3, r: 0 }]],
  ])
  memory.delete('a')
  const after = allocateCells([misc('.claude', 1), misc('b', 1), misc('c', 1)], memory)
  assert.deepEqual(after.get('.claude'), [{ q: 0, r: 0 }])
  assert.ok(isConnected(after))
})
