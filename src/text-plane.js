// Renders a string to a canvas texture, then builds a three.js object with real volume by
// stacking many copies of that texture's alpha-cutout shape along the depth axis. Since every
// layer shares the exact same silhouette, the stack forms a true extruded prism of the text
// shape (like a thick plaque) without needing per-glyph vector font data — which matters here
// because vector text geometry (THREE.TextGeometry) has no built-in Japanese glyph support,
// while canvas text rendering uses whatever fonts the device already has.
import * as THREE from 'three'

const FONT_FAMILY = "'Hiragino Sans', 'Yu Gothic', 'Noto Sans JP', sans-serif"

export const TEXT_WORLD_HEIGHT = 2.5 // meters
const TEXT_THICKNESS = TEXT_WORLD_HEIGHT * 0.12
const TEXT_LAYERS = 14
const TEXT_OPACITY = 0.9

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
    opacity: TEXT_OPACITY,
    alphaTest: 0.4, // cuts away the fully transparent canvas background so layers form a clean extrusion
    side: THREE.DoubleSide,
    roughness: 0.6,
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
