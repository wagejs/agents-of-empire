/** The Medieval planet's hex tiles: every connection has a tile, and the board is laid sensibly. */
import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { HEX_DIRS, TILES, layoutBoard, layoutFromMap, tileFor, subdivide, unmatched } from '../src/world/hexboard.js'
import * as THREE from 'three'

const ANGLES = [30, 90, 150, 210, 270, 330]

test('every set of road openings has a road tile, turned to fit', () => {
  for (let mask = 1; mask < 64; mask++) {
    const angles = ANGLES.filter((_, i) => mask & (1 << i))
    const tile = tileFor(angles, TILES.road)
    assert.ok(tile, `no road for ${angles}`)
    // The turn carries the tile's own edges (60k°) onto exactly these lattice angles.
    const deg = (tile.turn * 180) / Math.PI
    const landed = TILES.road[tile.model].map((k) => ((Math.round(60 * k - deg) % 360) + 360) % 360).sort((a, b) => a - b)
    assert.deepEqual(landed, angles)
  }
})

test('rivers cover every pair, coasts every arc of one to four', () => {
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) assert.ok(tileFor([ANGLES[i], ANGLES[j]], TILES.river))
  for (let n = 1; n <= 4; n++) for (let s = 0; s < 6; s++) {
    const arc = Array.from({ length: n }, (_, k) => ANGLES[(s + k) % 6])
    assert.ok(tileFor(arc, TILES.coast), `no coast for ${arc}`)
  }
})

test('the board rings the colony with a road, a river and a coast', () => {
  const footprint = [{ q: 0, r: 0 }, ...HEX_DIRS.map(([q, r]) => ({ q, r }))]
  const board = layoutBoard(footprint)
  const cells = [...board.values()]
  for (const c of footprint) assert.equal(board.get(`${c.q},${c.r}`).kind, 'grass')
  assert.ok(cells.filter((c) => c.ring === 1).every((c) => c.kind === 'road'))
  const river = cells.filter((c) => c.kind === 'river')
  assert.ok(river.length >= 3 && river.every((c) => c.angles.length === 2 && tileFor(c.angles, TILES.river)))
  assert.ok(cells.some((c) => c.kind === 'coast'))
  for (const c of cells) {
    if (TILES[c.kind]) assert.ok(tileFor(c.angles, TILES[c.kind]), `${c.kind} at ${c.q},${c.r} has no tile`)
    assert.ok(c.ring <= 3)
  }
  // Same colony, same board.
  assert.deepEqual([...layoutBoard(footprint).values()], cells)
})

test('subdividing keeps the surface and shortens every edge', () => {
  const geo = new THREE.PlaneGeometry(10, 10)
  const out = subdivide(geo, 1.6)
  const p = out.attributes.position
  let area = 0
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2)
    assert.ok(a.distanceTo(b) <= 1.6 + 1e-6 && b.distanceTo(c) <= 1.6 + 1e-6 && c.distanceTo(a) <= 1.6 + 1e-6)
    area += new THREE.Triangle(a, b, c).getArea()
  }
  assert.ok(Math.abs(area - 100) < 1e-6)
})

test('a painted map: roads join up, a river runs out to sea, plots stay grass', () => {
  const cells = []
  for (let q = -3; q <= 3; q++) for (let r = -3; r <= 3; r++) {
    if ((Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2 > 3) continue
    cells.push([q, r, r === 0 ? 'road' : q === 3 && r < 0 ? 'river' : q === -2 && r === 2 ? 'peaks' : 'grass'])
  }
  const footprint = [{ q: 0, r: 0 }]
  const board = layoutFromMap({ version: 1, cells }, footprint)
  // The plot cell was painted road; it is grass, and the roads either side of it end there.
  assert.equal(board.get('0,0').kind, 'grass')
  assert.equal(board.get('1,0').kind, 'road')
  assert.equal(board.get('2,0').angles.length, 2)
  // The river's top end is on the shore, so it opens out to the sea there.
  const top = board.get('3,-3')
  assert.equal(top.kind, 'river')
  assert.equal(top.angles.length, 2)
  assert.equal(board.get('-2,2').decor.kind, 'peaks')
  assert.ok([...board.values()].some((c) => c.kind === 'coast'))
  assert.equal(board.has('5,5'), false) // unpainted is sea
  assert.deepEqual(unmatched({ cells }, footprint), [])
  // A lone river tile in the middle of the land has nowhere to run.
  assert.equal(unmatched({ cells: [...cells.filter(([q, r]) => !(q === 0 && r === 1)), [0, 1, 'river']] }).length, 1)
})

test('a full painted town grows: the wall moves out a ring and stays closed', async () => {
  const { growTown, townRoom, townGrowth, layoutFromMap } = await import('../src/world/hexboard.js')
  const map = JSON.parse(readFileSync(new URL('../public/maps/medieval.json', import.meta.url)))
  assert.equal(townRoom(map), 7)
  assert.equal(townGrowth(map, 7), 0)
  const k = townGrowth(map, 8)
  assert.equal(k, 1)
  const grown = growTown(map, k)
  assert.ok(townRoom(grown) >= 8)
  // Every wall cell still links up to two others: no gaps opened in it.
  const board = layoutFromMap(grown, [{ q: -2, r: 1 }])
  const walls = [...board.values()].filter((c) => c.kind === 'road')
  assert.ok(walls.length > 13)
  assert.ok(walls.every((c) => c.angles.length >= 2))
})
