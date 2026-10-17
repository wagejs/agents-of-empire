import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/**
 * KayKit Skeletons, worn on the crew's own rig.
 *
 * The skeletons are rigged to the same Rig_Medium as the mannequin, with the same bind
 * pose, so they can play the crew's baked animation table as they are. Only two things
 * differ: the joints are listed in a different order, and there are two extra hand slots.
 * So each part's joint indices are renamed into the crew's order, and the hand slots ride
 * on the hands.
 */

export const HEROES = ['rogue', 'warrior', 'mage']
export const SKELETON_TYPES = ['minion', ...HEROES]

const url = (type) => `${import.meta.env.BASE_URL}assets/skeletons/skeleton_${type}.glb`

let loading = null

/** Load and merge every skeleton against the crew rig. Idempotent. */
export function loadSkeletons(rig) {
  if (!loading) {
    const loader = new GLTFLoader()
    loading = Promise.all(SKELETON_TYPES.map((t) => loader.loadAsync(url(t)))).then((gltfs) => {
      const geometries = {}
      let map = null
      gltfs.forEach((gltf, i) => {
        geometries[SKELETON_TYPES[i]] = mergeSkeleton(gltf.scene, rig.boneIndex)
        gltf.scene.traverse((o) => (map ||= o.material?.map || null))
      })
      return { geometries, map, portraits: portraits(gltfs) }
    })
  }
  return loading
}

/** Size of a card portrait, in pixels: the card shows it at 46 CSS px, so this is sharp at 2x. */
const PORTRAIT = 108
/** Where the face sits above the head bone, and how far back the camera stands. Tuned by eye. */
const FACE_LIFT = 0.5
const FACE_DISTANCE = 2.5

/**
 * Head-and-shoulders pictures of each skeleton, for the agent card: one throwaway renderer,
 * two renders per skeleton, then let go. Missing when WebGL is not on offer; the card keeps
 * its face then.
 *
 * The cloth is the repo's colour, which a picture taken once cannot know. So each skeleton
 * comes as a `base` with the cloth in grey and a `mask` of where the cloth shows; the card
 * multiplies the mask's colour in. See `HUD.updateAvatar`.
 */
function portraits(gltfs) {
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
  } catch {
    return {}
  }
  renderer.setSize(PORTRAIT, PORTRAIT, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const uMask = { value: 0 }
  const greyCloth = (shader) => {
    shader.uniforms.uMask = uMask
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uMask;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         vec2 clothCell = floor( vMapUv * vec2( 8.0, 4.0 ) );
         float cloth = step( abs( clothCell.x - ${CLOTH_CELL[0]}.0 ) + abs( clothCell.y - ${CLOTH_CELL[1]}.0 ), 0.5 );
         float clothLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / ${CLOTH_LUM};
         diffuseColor.rgb = mix( diffuseColor.rgb, vec3( clamp( clothLum, 0.2, 1.2 ) ), cloth );`
      )
      .replace(
        '#include <dithering_fragment>',
        '#include <dithering_fragment>\nif ( uMask > 0.5 ) gl_FragColor = vec4( vec3( cloth ), cloth );'
      )
  }
  const snap = () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = PORTRAIT
    canvas.getContext('2d').drawImage(renderer.domElement, 0, 0)
    return canvas
  }
  const out = {}
  gltfs.forEach((gltf, i) => {
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 2)
    sun.position.set(1.5, 3, 4)
    scene.add(sun, gltf.scene)
    gltf.scene.traverse((o) => {
      if (o.material?.map) o.material.onBeforeCompile = greyCloth
    })
    gltf.scene.updateMatrixWorld(true)
    // Framed on the head bone, not the bounding box, so a tall hat does not shove the face down.
    const head = new THREE.Vector3()
    gltf.scene.getObjectByName('head')?.getWorldPosition(head)
    head.y += FACE_LIFT
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50)
    camera.position.set(head.x + FACE_DISTANCE * 0.3, head.y + 0.15, head.z + FACE_DISTANCE)
    camera.lookAt(head)
    uMask.value = 0
    renderer.render(scene, camera)
    const base = snap()
    uMask.value = 1
    renderer.render(scene, camera)
    out[SKELETON_TYPES[i]] = { base, mask: snap() }
    scene.remove(gltf.scene)
  })
  renderer.dispose()
  renderer.forceContextLoss()
  return out
}

/** A skeleton joint's index in the crew rig. The hand slots are the hands. */
export function crewBone(boneIndex, name) {
  const i = boneIndex.get(name) ?? boneIndex.get(name.replace('handslot', 'hand'))
  if (i == null) throw new Error(`skeletons: no crew bone for ${name}`)
  return i
}

/**
 * Merge one skeleton's parts into one skinned geometry in crew joint order.
 *
 * Hats, hoods, capes and helmets are not skinned: they hang off a bone. They are baked at
 * their rest position and weighted fully to that bone, which is the same thing to the
 * shader. `aGlow` marks the eyes, which take the status colour.
 */
export function mergeSkeleton(scene, boneIndex) {
  scene.updateMatrixWorld(true)
  const parts = []
  scene.traverse((o) => {
    if (!o.isMesh) return
    const src = o.geometry
    const n = src.attributes.position.count
    const geo = new THREE.BufferGeometry()
    for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]]) {
      const a = src.getAttribute(name)
      const data = new Float32Array(n * size)
      if (a) for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) data[i * size + k] = a.getComponent(i, k)
      geo.setAttribute(name, new THREE.BufferAttribute(data, size))
    }
    const index = new Float32Array(n * 4)
    const weight = new Float32Array(n * 4)
    if (o.isSkinnedMesh) {
      const joints = o.skeleton.bones.map((b) => crewBone(boneIndex, b.name))
      const si = src.getAttribute('skinIndex')
      const sw = src.getAttribute('skinWeight')
      for (let i = 0; i < n * 4; i++) {
        index[i] = joints[si.getComponent(i >> 2, i & 3)]
        weight[i] = sw.getComponent(i >> 2, i & 3)
      }
    } else {
      let bone = o.parent
      while (bone && !bone.isBone) bone = bone.parent
      if (!bone) throw new Error(`skeletons: ${o.name} hangs off no bone`)
      geo.applyMatrix4(o.matrixWorld)
      const j = crewBone(boneIndex, bone.name)
      for (let i = 0; i < n; i++) {
        index[i * 4] = j
        weight[i * 4] = 1
      }
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(index, 4))
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(weight, 4))
    geo.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(n).fill(/_Eyes$/.test(o.name) ? 1 : 0), 1))
    if (src.index) geo.setIndex(Array.from(src.index.array))
    parts.push(geo.index ? geo : geo.toNonIndexed())
  })
  if (parts.some((g) => !g.index)) parts.forEach((g, i) => (parts[i] = g.index ? g.toNonIndexed() : g))
  const merged = parts.length === 1 ? parts[0] : BufferGeometryUtils.mergeGeometries(parts, false)
  merged.computeBoundingBox()
  return merged
}

/**
 * The crimson cloth swatch of the KayKit atlas (8x4 cells, column 2, row 2 from the top):
 * the mage's hat and robe, the rogue's hood and cape, the warrior's cloak and plume.
 */
export const CLOTH_CELL = [2, 2]
/** That swatch's top luminance in linear space, so its gradient survives the repaint. */
const CLOTH_LUM = 0.11

/**
 * Light the eyes in the instance colour, repaint the cloth in the repo's accent (`aAccent`),
 * and leave the rest of the bones their texture.
 * Goes on top of `decorateSkinned`, so it wraps whatever compile hook is already there.
 */
export function withGlowingEyes(material) {
  const base = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    base?.(shader, renderer)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aGlow;\nattribute vec3 aAccent;\nvarying float vGlow;\nvarying vec3 vAccent;'
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\nvAccent = aAccent;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nvarying vec3 vAccent;')
      .replace(
        '#include <color_fragment>',
        `vec2 clothCell = floor( vMapUv * vec2( 8.0, 4.0 ) );
         float cloth = step( abs( clothCell.x - ${CLOTH_CELL[0]}.0 ) + abs( clothCell.y - ${CLOTH_CELL[1]}.0 ), 0.5 ) * ( 1.0 - vGlow );
         float clothLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / ${CLOTH_LUM};
         diffuseColor.rgb = mix( diffuseColor.rgb, vAccent * clamp( clothLum, 0.2, 1.2 ), cloth );
         diffuseColor.rgb *= mix( vec3( 1.0 ), vColor.rgb, vGlow );`
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vGlow * 1.4;'
      )
  }
  return material
}
