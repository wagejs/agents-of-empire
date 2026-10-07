/** The KayKit skeletons merged onto the crew rig: every joint lands on a crew bone. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PropertyBinding } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { SKELETON_TYPES, crewBone, mergeSkeleton } from '../src/agents/skeletons.js'

// Geometry only: the texture needs a browser, and nothing here looks at it.
function parse(file) {
  const glb = readFileSync(new URL(`../public/assets/${file}`, import.meta.url))
  const len = glb.readUInt32LE(12)
  const json = JSON.parse(glb.subarray(20, 20 + len))
  delete json.images
  delete json.textures
  delete json.samplers
  for (const m of json.materials || []) delete m.pbrMetallicRoughness?.baseColorTexture
  const text = Buffer.from(JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4, ' '))
  const rest = glb.subarray(20 + len)
  const header = Buffer.alloc(20)
  header.write('glTF', 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(20 + text.length + rest.length, 8)
  header.writeUInt32LE(text.length, 12)
  header.write('JSON', 16)
  const out = Buffer.concat([header, text, rest])
  return new Promise((res, rej) =>
    new GLTFLoader().parse(out.buffer.slice(out.byteOffset, out.byteOffset + out.length), '', res, rej)
  )
}

const crew = await parse('crew.glb')
const crewBones = []
crew.scene.traverse((o) => o.isSkinnedMesh && !crewBones.length && crewBones.push(...o.skeleton.bones))
const boneIndex = new Map(crewBones.map((b, i) => [b.name, i]))

test('the hand slots ride on the hands', () => {
  // The loader strips the dots out of node names, so compare as it names them.
  const name = (n) => PropertyBinding.sanitizeNodeName(n)
  assert.equal(crewBone(boneIndex, name('handslot.l')), boneIndex.get(name('hand.l')))
  assert.throws(() => crewBone(boneIndex, 'tail'))
})

for (const type of SKELETON_TYPES) {
  test(`the ${type} merges onto the crew rig with glowing eyes`, async () => {
    const gltf = await parse(`skeletons/skeleton_${type}.glb`)
    const geo = mergeSkeleton(gltf.scene, boneIndex)
    const n = geo.attributes.position.count
    const index = geo.attributes.skinIndex.array
    const weight = geo.attributes.skinWeight.array
    for (let i = 0; i < n * 4; i++) assert.ok(index[i] >= 0 && index[i] < crewBones.length)
    for (let v = 0; v < n; v++) {
      const sum = weight[v * 4] + weight[v * 4 + 1] + weight[v * 4 + 2] + weight[v * 4 + 3]
      assert.ok(Math.abs(sum - 1) < 0.01, `vertex ${v} weights sum to ${sum}`)
    }
    const glow = geo.attributes.aGlow.array
    assert.ok(glow.includes(1) && glow.includes(0))
    // Rig_Medium stands about 2.2 units tall; a skeleton baked wrong ends up far off it.
    assert.ok(geo.boundingBox.max.y > 1.5 && geo.boundingBox.max.y < 3.5, `top at ${geo.boundingBox.max.y}`)
  })
}
