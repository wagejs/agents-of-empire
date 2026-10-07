/**
 * Packs every source pack the colony needs into the three glbs it loads.
 *
 * The raw packs are not checked in and the built glbs are, so this is a no-op on a fresh
 * clone — it only has work to do when a pack has been re-downloaded into `assets-src/` or
 * one of the lists below has changed.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync } from 'node:fs'
import { BOARD_MODELS } from '../src/world/hexboard.js'

/**
 * Which of the Forest Nature Pack's 105 models to keep.
 *
 * The pack ships every model in several sizes and colour variants; the colony wants a
 * handful of silhouettes and gets its variety from per-instance scale and rotation instead,
 * so packing the lot would be five times the file for no more to look at.
 */
const FOREST = [
  // Canopies: round, flat-top and fir, each in a common size, plus a rarer large one.
  'Tree_1_A', 'Tree_3_A', 'Tree_4_A', 'Tree_1_C', 'Tree_3_C', 'Tree_4_C',
  'Bush_1_E', 'Bush_3_B',
  'Grass_2_D',
  // Boulders. Painted neutral grey, which is what lets them be tinted per planet.
  'Rock_1_D', 'Rock_2_C', 'Rock_3_E', 'Rock_1_J', 'Rock_2_G', 'Rock_3_L', 'Rock_3_Q',
].map((n) => `${n}_Color1`)

/**
 * The Medieval Hexagon Pack, for the Medieval planet: every building in the four team colours
 * (the colour says what the thread is doing), the construction stages a young thread shows,
 * and the grass hex the plots stand on. Paths are under the pack's `Assets/gltf`.
 */
const MEDIEVAL_TYPES = [
  'home_A', 'home_B', 'tavern', 'blacksmith', 'market', 'well', 'lumbermill', 'mine',
  'barracks', 'archeryrange', 'watermill', 'windmill', 'church', 'castle', 'tower_A', 'tower_B',
]
const MEDIEVAL = [
  ...['blue', 'green', 'red', 'yellow'].flatMap((team) =>
    MEDIEVAL_TYPES.map((type) => `buildings/${team}/building_${type}_${team}`)
  ),
  ...['scaffolding', 'stage_A', 'stage_B', 'stage_C'].map((s) => `buildings/neutral/building_${s}`),
  // The Medieval planet's ground: every tile and decoration the board can lay — hexboard.js.
  ...BOARD_MODELS.map((n) =>
    n.startsWith('hex_road') ? `tiles/roads/${n}`
    : n.startsWith('hex_river') ? `tiles/rivers/${n}`
    : n.startsWith('hex_coast') ? `tiles/coast/waterless/${n}`
    : n === 'hex_grass' ? `tiles/base/${n}`
    : `decoration/nature/${n}`
  ),
]

const STEPS = [
  ['tools/build-kit.mjs', 'assets-src/KayKit_Space_Base_Bits_1.0_FREE/Assets/gltf', 'public/assets/spacebase.glb'],
  ['tools/build-kit.mjs', 'assets-src/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf', 'public/assets/forest.glb', FOREST.join(',')],
  // Kenney's Nature Kit has its own packer: its models are flat-colour primitives rather
  // than atlas-mapped, and the packer bakes those colours into vertices. The list of what
  // is kept, and the recolours that turn an oak into a cherry tree, live in there.
  ['tools/build-nature.mjs', 'assets-src/kenney_nature-kit/Models/GLTF format', 'public/assets/nature.glb'],
  ['tools/build-crew.mjs'],
  ['tools/build-kit.mjs', 'assets-src/KayKit_Medieval_Hexagon_Pack_1.0_FREE/Assets/gltf', 'public/assets/medieval.glb', MEDIEVAL.join(',')],
]

for (const [script, ...args] of STEPS) {
  const run = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}

// The skeletons ship as they come: four small glbs on the crew's own rig. The crew merges
// them at load time — see src/agents/skeletons.js.
mkdirSync('public/assets/skeletons', { recursive: true })
for (const type of ['Minion', 'Rogue', 'Warrior', 'Mage']) {
  cpSync(
    `assets-src/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_${type}.glb`,
    `public/assets/skeletons/skeleton_${type.toLowerCase()}.glb`
  )
}
