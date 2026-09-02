// Renders a string to a canvas texture, then builds a three.js object with real volume by
// stacking many copies of that texture's alpha-cutout shape along the depth axis. Since every
// layer shares the exact same silhouette, the stack forms a true extruded prism of the text
// shape (like a thick plaque) without needing per-glyph vector font data — which matters here
// because vector text geometry (THREE.TextGeometry) has no built-in Japanese glyph support,
// while canvas text rendering uses whatever fonts the device already has.
import * as THREE from 'three'

const FONT_FAMILY = "'Hiragino Sans', 'Yu Gothic', 'Noto Sans JP', sans-serif"

export const TEXT_WORLD_HEIGHT = 5 // meters
const TEXT_THICKNESS = TEXT_WORLD_HEIGHT * 0.12
const TEXT_LAYERS = 14
const TEXT_OVERALL_OPACITY = 0.9 // how opaque the letter should read as a whole, e.g. viewed head-on

// Stacking TEXT_LAYERS semi-transparent surfaces compounds their opacity multiplicatively along
// any viewing ray that passes through several of them (transmittance ≈ (1 - perLayerOpacity)^N)
// -- at 0.9 per layer that compounds to fully opaque well before N=14, hiding the probe rod
// completely instead of letting it show through faintly. Solving (1-p)^N = 1-TARGET for p gives
// the per-layer opacity that reproduces the target overall opacity when viewed straight through
// the whole stack, while parts of the rod behind only a few layers show through even more.
const TEXT_LAYER_OPACITY = 1 - (1 - TEXT_OVERALL_OPACITY) ** (1 / TEXT_LAYERS)
// alphaTest is compared against texture-alpha * material.opacity, so it must stay well below the
// (now much lower) per-layer opacity or every layer would be discarded as if fully transparent.
const TEXT_ALPHA_TEST = TEXT_LAYER_OPACITY * 0.3

const createTextTexture = (text, {fontSize = 160, color = '#ff3b30'} = {}) => {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')

  ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`
  const padding = fontSize * 0.3
  const metrics = ctx.measureText(text)
  canvas.width = Math.ceil(metrics.width + padding * 2)
  canvas.height = Math.ceil(fontSize * 1.4 + padding * 2)

  // Sizing the canvas resets its context, so the font must be re-applied.
  ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillStyle = color
  ctx.fillText(text, canvas.width / 2, canvas.height / 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  return {texture, aspect: canvas.width / canvas.height}
}

// Builds a group showing `text` as a thick, shadow-casting object sized so its world-space
// height is `worldHeight` meters. The group is centered on X/Z with its bottom at local y=0,
// so placing it at a ground hit point sits it directly on the ground.
export const createTextMesh = (text, {worldHeight = TEXT_WORLD_HEIGHT, color = '#ff3b30'} = {}) => {
  const {texture, aspect} = createTextTexture(text, {color})
  const width = worldHeight * aspect

  const geometry = new THREE.PlaneGeometry(width, worldHeight)
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    opacity: TEXT_LAYER_OPACITY,
    alphaTest: TEXT_ALPHA_TEST, // cuts away the fully transparent canvas background so layers form a clean extrusion
    side: THREE.DoubleSide,
    roughness: 0.6,
    // Without this, one layer's depth write can make sibling layers at nearly the same depth
    // fail the depth test and get skipped entirely, so far fewer than 14 layers actually
    // contribute to the blend and the whole stack ends up much more see-through than intended.
    depthWrite: false,
  })

  const group = new THREE.Group()
  for (let i = 0; i < TEXT_LAYERS; i += 1) {
    const layer = new THREE.Mesh(geometry, material)
    layer.position.z = -TEXT_THICKNESS / 2 + (TEXT_THICKNESS * i) / (TEXT_LAYERS - 1)
    layer.position.y = worldHeight / 2
    layer.castShadow = true
    layer.receiveShadow = true
    group.add(layer)
  }

  return group
}
