import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { atlasTexture, hasPart, part } from './kit.js'
import { withCurve } from '../core/curve.js'

/**
 * The Medieval planet's ground: KayKit hex tiles laid on the plot lattice.
 *
 * Every cell the colony holds (plots and the ship) is grass. Around it:
 *   ring 1 — a road that circles the town,
 *   ring 2 — meadow, with a river cut through it that runs out to the sea at both ends,
 *   ring 3 — meadow again, and the coast where it meets the sea.
 * Past ring 3 is the planet's own sea. Outer meadow cells carry trees, rocks and hills.
 *
 * Layout is pure (`layoutBoard`, `tileFor`) so it runs under node; `createHexBoard` turns
 * it into one merged mesh.
 */

/** Plot lattice cell, centre to corner. Same as plots.js — kept here so this runs in node. */
const CELL = 7.6
/** KayKit tiles are pointy-top with an apothem of 1; ours are flat-top. */
const TILE_SCALE = CELL * (Math.sqrt(3) / 2)
/** How deep a tile is. The pack's are 1 unit; full scale would be a 6.6-unit slab. */
export const TILE_DEPTH = 1.5
/** Where the coast tiles' shoreline sits, in tile units below the top. */
const SHORE = 0.15
/** Decorations stand at the buildings' scale, not the tiles'. */
const DECOR_SCALE = 2.3
const LAND_RINGS = 3

export const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]
const key = (q, r) => `${q},${r}`
export const hexToWorld = (q, r) => ({ x: CELL * 1.5 * q, z: CELL * Math.sqrt(3) * (r + q / 2) })

/** Direction d's angle in degrees: 30, 90, … — where the shared edge's midpoint is. */
const DIR_ANGLE = HEX_DIRS.map(([q, r]) => {
  const { x, z } = hexToWorld(q, r)
  return (Math.round((Math.atan2(z, x) * 180) / Math.PI) + 360) % 360
})

/** The sea level the board is built for, given the height of its top. */
export const boardSeaLevel = (top) => top - SHORE * TILE_DEPTH

/**
 * Which tile edges each model opens onto, measured from the pack's geometry. Edge k is the
 * one whose midpoint is at 60k degrees (x = cos, z = sin) in the tile's own frame.
 */
const ROADS = {
  hex_road_M: [3], hex_road_A: [0, 3], hex_road_B: [3, 5], hex_road_C: [3, 4],
  hex_road_D: [1, 3, 5], hex_road_E: [0, 3, 5], hex_road_F: [0, 1, 3], hex_road_G: [2, 3, 4],
  hex_road_H: [0, 2, 3, 4], hex_road_I: [1, 2, 4, 5], hex_road_J: [0, 1, 2, 3],
  hex_road_K: [1, 2, 3, 4, 5], hex_road_L: [0, 1, 2, 3, 4, 5],
}
const RIVERS = Object.fromEntries(
  Object.entries(ROADS).filter(([n]) => n !== 'hex_road_M').map(([n, e]) => [n.replace('road', 'river'), e])
)
/** The waterless coasts: the edges that face open water. The planet's sea fills them. */
const COASTS = {
  hex_coast_A_waterless: [1], hex_coast_B_waterless: [1, 2],
  hex_coast_C_waterless: [0, 1, 2], hex_coast_D_waterless: [5, 0, 1, 2],
}
const DECOR = {
  trees: ['trees_A_large', 'trees_B_large', 'trees_A_medium', 'trees_B_medium', 'trees_A_small', 'tree_single_A', 'tree_single_B'],
  rocks: ['rock_single_A', 'rock_single_B', 'rock_single_C'],
  hills: ['hills_A_trees', 'hills_B_trees', 'hills_C_trees'],
  peaks: ['mountain_A_grass_trees', 'mountain_B_grass_trees'],
}

/** The connecting tiles, by the kind of cell they are laid on. */
export const TILES = { road: ROADS, river: RIVERS, coast: COASTS }

/** Every model the board can ask for — what the asset build has to pack. */
export const BOARD_MODELS = [
  'hex_grass', ...Object.keys(ROADS), ...Object.keys(RIVERS), ...Object.keys(COASTS), ...Object.values(DECOR).flat(),
]

/**
 * Find a model and a turn that opens exactly onto `angles` (lattice degrees).
 * Returns { model, turn } with `turn` in radians for `rotateY`, or null.
 */
export function tileFor(angles, table) {
  const want = [...angles].sort((a, b) => a - b)
  for (const [model, edges] of Object.entries(table)) {
    if (edges.length !== want.length) continue
    const have = new Set(edges)
    for (let s = 0; s < 6; s++) {
      // rotateY(θ) carries a tile edge at 60k to 60k − θ, so edge k lands on angle a when
      // 60k = a + θ. The lattice is a half-step off the tile, hence the 30.
      const theta = -30 - 60 * s
      if (want.every((a) => have.has((((a + theta) / 60) % 6 + 6) % 6))) return { model, turn: (theta * Math.PI) / 180 }
    }
  }
  return null
}

function mulberry(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One water run around a cell: true when the open edges are a single unbroken arc. */
function oneArc(angles) {
  if (angles.length === 0 || angles.length === 6) return false
  const set = new Set(angles)
  const starts = DIR_ANGLE.filter((a) => set.has(a) && !set.has((a + 300) % 360))
  return starts.length === 1
}

/**
 * Lay the board out around the colony's cells.
 * Returns Map(key → { q, r, ring, kind: 'grass'|'road'|'river'|'coast', angles, decor }).
 */
export function layoutBoard(footprint, seed = 7) {
  const rand = mulberry(seed)
  const ring = new Map()
  let frontier = []
  for (const c of footprint) {
    if (ring.has(key(c.q, c.r))) continue
    ring.set(key(c.q, c.r), 0)
    frontier.push(c)
  }
  for (let d = 1; d <= LAND_RINGS + 1; d++) {
    const next = []
    for (const c of frontier) {
      for (const [dq, dr] of HEX_DIRS) {
        const n = { q: c.q + dq, r: c.r + dr }
        if (ring.has(key(n.q, n.r))) continue
        ring.set(key(n.q, n.r), d)
        next.push(n)
      }
    }
    frontier = next
  }
  const ringOf = (q, r) => ring.get(key(q, r)) ?? Infinity
  const land = (q, r) => ringOf(q, r) <= LAND_RINGS
  const around = (q, r) => HEX_DIRS.map(([dq, dr], d) => ({ q: q + dq, r: r + dr, angle: DIR_ANGLE[d] }))

  const board = new Map()
  for (const [k, d] of ring) {
    if (d > LAND_RINGS) continue
    const [q, r] = k.split(',').map(Number)
    board.set(k, { q, r, ring: d, kind: 'grass', angles: [], decor: null })
  }

  // The ring road: each road cell opens toward its road neighbours.
  for (const cell of board.values()) {
    if (cell.ring !== 1) continue
    cell.angles = around(cell.q, cell.r).filter((n) => ringOf(n.q, n.r) === 1).map((n) => n.angle)
    cell.kind = cell.angles.length ? 'road' : 'grass'
  }

  // The river: in from the sea, along ring 2, and back out. Both mouths are ring-3 cells
  // with the sea right behind them.
  const mouths = [...board.values()].filter(
    (c) => c.ring === LAND_RINGS && around(c.q, c.r).some((n) => !land(n.q, n.r)) &&
      around(c.q, c.r).some((n) => ringOf(n.q, n.r) === LAND_RINGS - 1)
  )
  if (mouths.length > 4) {
    const a = mouths[Math.floor(rand() * mouths.length)]
    const pa = hexToWorld(a.q, a.r)
    // The other mouth a third of the way round, so the river is a bend and not a loop.
    const b = mouths.reduce((best, c) => {
      const p = hexToWorld(c.q, c.r)
      const turn = Math.abs(((Math.atan2(p.z, p.x) - Math.atan2(pa.z, pa.x) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
      const score = Math.abs(turn - 2.1)
      return score < best.score ? { c, score } : best
    }, { c: null, score: Infinity }).c
    const path = b && b !== a ? riverPath(a, b, ringOf, around) : null
    if (path) {
      const sea = (c) => around(c.q, c.r).find((n) => !land(n.q, n.r))
      const full = [sea(path[0]), ...path, sea(path[path.length - 1])]
      for (let i = 1; i < full.length - 1; i++) {
        const cell = board.get(key(full[i].q, full[i].r))
        const link = (o) => around(cell.q, cell.r).find((n) => n.q === o.q && n.r === o.r).angle
        cell.kind = 'river'
        cell.angles = [link(full[i - 1]), link(full[i + 1])]
      }
    }
  }

  // The coast: ring-3 meadow facing the sea.
  for (const cell of board.values()) {
    if (cell.ring !== LAND_RINGS || cell.kind !== 'grass') continue
    const open = around(cell.q, cell.r).filter((n) => !land(n.q, n.r)).map((n) => n.angle)
    if (open.length && open.length <= 4 && oneArc(open)) {
      cell.kind = 'coast'
      cell.angles = open
    }
  }

  // Dress the open meadow. Mountains only out at the edge, where they frame the town.
  for (const cell of board.values()) {
    if (cell.kind !== 'grass' || cell.ring < 2 || rand() > 0.65) continue
    const pick = rand()
    const kind = cell.ring === LAND_RINGS && pick < 0.2 ? 'peaks' : pick < 0.65 ? 'trees' : pick < 0.85 ? 'hills' : 'rocks'
    cell.decor = { kind, seed: Math.floor(rand() * 1e9) }
  }
  return board
}

/** Shortest path from mouth a to mouth b through ring 2. */
function riverPath(a, b, ringOf, around) {
  const inner = (m) => around(m.q, m.r).filter((n) => ringOf(n.q, n.r) === LAND_RINGS - 1)
  const goal = new Set(inner(b).map((n) => key(n.q, n.r)))
  const prev = new Map()
  const queue = inner(a)
  for (const s of queue) prev.set(key(s.q, s.r), null)
  while (queue.length) {
    const c = queue.shift()
    if (goal.has(key(c.q, c.r))) {
      const path = [b]
      for (let at = c; at; at = prev.get(key(at.q, at.r))) path.push(at)
      path.push(a)
      return path.reverse()
    }
    for (const n of around(c.q, c.r)) {
      if (ringOf(n.q, n.r) !== LAND_RINGS - 1 || prev.has(key(n.q, n.r))) continue
      prev.set(key(n.q, n.r), c)
      queue.push(n)
    }
  }
  return null
}

/**
 * The longest triangle edge the board keeps. The world curve bends vertices, not faces: a
 * tile's 7.6-unit top triangles stay flat chords while the neighbour's edge bends, and the
 * crack between them shows the sea. Short edges keep that sag under a hundredth of a unit.
 */
const MAX_EDGE = 1.6

/** Split every triangle at the midpoint of its longest edge until none is over `max`. */
export function subdivide(geometry, max) {
  const src = geometry.index ? geometry.toNonIndexed() : geometry
  const names = Object.keys(src.attributes)
  const out = Object.fromEntries(names.map((n) => [n, []]))
  const sizes = names.map((n) => src.attributes[n].itemSize)
  const vert = (i) => names.map((n, a) => Array.from(src.attributes[n].array.slice(i * sizes[a], (i + 1) * sizes[a])))
  const mid = (u, v) => u.map((attr, a) => attr.map((x, k) => (x + v[a][k]) / 2))
  const len2 = (u, v) => (u[0][0] - v[0][0]) ** 2 + (u[0][1] - v[0][1]) ** 2 + (u[0][2] - v[0][2]) ** 2
  const max2 = max * max
  const stack = []
  for (let i = 0; i < src.attributes.position.count; i += 3) stack.push([vert(i), vert(i + 1), vert(i + 2)])
  while (stack.length) {
    const [a, b, c] = stack.pop()
    const ab = len2(a, b), bc = len2(b, c), ca = len2(c, a)
    const longest = Math.max(ab, bc, ca)
    if (longest <= max2) {
      for (const v of [a, b, c]) v.forEach((attr, k) => out[names[k]].push(...attr))
      continue
    }
    // Keep the winding: split edge xy of triangle (x, y, z) into (x, m, z) and (m, y, z).
    const [x, y, z] = longest === ab ? [a, b, c] : longest === bc ? [b, c, a] : [c, a, b]
    const m = mid(x, y)
    stack.push([x, m, z], [m, y, z])
  }
  const geo = new THREE.BufferGeometry()
  names.forEach((n, a) => geo.setAttribute(n, new THREE.Float32BufferAttribute(out[n], sizes[a])))
  if (src !== geometry) src.dispose()
  return geo
}

/**
 * Build the board as one mesh, its top at `top`. Needs the medieval kit loaded; returns
 * null until it is. `onDecor(x, z)` says whether a decoration may stand at a point.
 */
export function createHexBoard(board, top) {
  if (!hasPart('hex_grass', 'medieval')) return null
  const parts = []
  const m = new THREE.Matrix4()
  const place = (model, x, z, turn, sx, sy, y = top) => {
    if (!hasPart(model, 'medieval')) return
    const geo = part(model, 'medieval')
    geo.applyMatrix4(m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn), new THREE.Vector3(sx, sy, sx)))
    parts.push(geo)
  }
  for (const cell of board.values()) {
    const { x, z } = hexToWorld(cell.q, cell.r)
    const tile = TILES[cell.kind] && tileFor(cell.angles, TILES[cell.kind])
    // Plain grass still takes the half-step turn: the pack is pointy-top, the lattice flat-top.
    place(tile?.model ?? 'hex_grass', x, z, tile?.turn ?? -Math.PI / 6, TILE_SCALE, TILE_DEPTH)
    if (!cell.decor) continue
    const rand = mulberry(cell.decor.seed)
    const list = DECOR[cell.decor.kind]
    const pick = () => list[Math.floor(rand() * list.length)]
    // Hills and mountains are hex plateaus that fill their tile, so they take the tile's
    // scale and one of its six turns. Everything else is drawn at the buildings' scale, so a
    // tile takes up to seven clumps: one in the middle, six around it, each a little off.
    if (cell.decor.kind === 'peaks' || cell.decor.kind === 'hills') {
      const turn = -Math.PI / 6 - (Math.PI / 3) * Math.floor(rand() * 6)
      place(pick(), x, z, turn, TILE_SCALE * 0.95, TILE_SCALE * (cell.decor.kind === 'hills' ? 0.7 : 0.95))
      continue
    }
    const keep = cell.decor.kind === 'trees' ? 0.8 : 0.45
    const grow = cell.decor.kind === 'rocks' ? 3 : 1
    for (let i = 0; i < 7; i++) {
      if (rand() > keep) continue
      const a = (Math.PI / 3) * i + Math.PI / 6
      const d = i === 6 ? 0 : TILE_SCALE * 0.58
      const s = DECOR_SCALE * grow * (0.85 + rand() * 0.4)
      const jx = (rand() - 0.5) * 1.2
      const jz = (rand() - 0.5) * 1.2
      place(pick(), x + Math.cos(a) * d + jx, z + Math.sin(a) * d + jz, rand() * Math.PI * 2, s, s)
    }
  }
  const merged = BufferGeometryUtils.mergeGeometries(parts, false)
  parts.forEach((g) => g.dispose())
  const geo = subdivide(merged, MAX_EDGE)
  merged.dispose()
  const material = new THREE.MeshStandardMaterial({ map: atlasTexture('medieval'), roughness: 0.9, metalness: 0 })
  material.onBeforeCompile = (shader) => withCurve(shader)
  const mesh = new THREE.Mesh(geo, material)
  mesh.name = 'hex-board'
  mesh.receiveShadow = true
  mesh.castShadow = true
  return mesh
}
