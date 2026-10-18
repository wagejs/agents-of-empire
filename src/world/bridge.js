import * as THREE from 'three'

/**
 * A walkway from one island's deck to another's: a plank deck on posts with a rail each side.
 *
 * Laid deck-edge to deck-edge between two world points, at the height of the plots it joins, so
 * the crew walk straight off one island and onto the next. `contains` is what the ground-height
 * lookup asks, so whoever is on it stands on the planks rather than the water below.
 */
const WIDTH = 4
const DECK = 0.22
const RAIL_H = 0.9

let _materials = null
function materials() {
  if (_materials) return _materials
  _materials = {
    deck: new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.85, metalness: 0.05 }),
    rail: new THREE.MeshStandardMaterial({ color: 0x5e4630, roughness: 0.8, metalness: 0.05 }),
  }
  return _materials
}

export function createBridge(from, to, top) {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const length = Math.hypot(dx, dz)
  const group = new THREE.Group()
  group.position.set((from.x + to.x) / 2, 0, (from.z + to.z) / 2)
  group.rotation.y = -Math.atan2(dz, dx)
  const { deck, rail } = materials()

  // Segmented along its length so the world's curve bends it like the ground around it.
  const segs = Math.max(4, Math.ceil(length / 2))
  const plank = new THREE.Mesh(new THREE.BoxGeometry(length, DECK, WIDTH, segs, 1, 1), deck)
  plank.position.y = top - DECK / 2
  plank.castShadow = plank.receiveShadow = true
  group.add(plank)

  for (const side of [-1, 1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(length, 0.12, 0.12, segs, 1, 1), rail)
    bar.position.set(0, top + RAIL_H, (side * WIDTH) / 2)
    group.add(bar)
    const posts = Math.max(2, Math.round(length / 3))
    for (let i = 0; i <= posts; i++) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, RAIL_H + 2, 0.16), rail)
      post.position.set(-length / 2 + (length * i) / posts, top + RAIL_H / 2 - 1, (side * WIDTH) / 2)
      post.castShadow = true
      group.add(post)
    }
  }

  return {
    group,
    /** Whether a world point is on the planks. */
    contains(x, z) {
      const t = ((x - from.x) * dx + (z - from.z) * dz) / (length * length)
      if (t < 0 || t > 1) return false
      const px = from.x + dx * t
      const pz = from.z + dz * t
      return Math.hypot(x - px, z - pz) <= WIDTH / 2
    },
    dispose() {
      group.traverse((o) => o.geometry?.dispose())
    },
  }
}

