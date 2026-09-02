// Renders a string to a canvas texture and wraps it in a three.js plane mesh,
// so arbitrary text (including Japanese) can be placed as a real object in the AR scene.
import * as THREE from 'three'

const FONT_FAMILY = "'Hiragino Sans', 'Yu Gothic', 'Noto Sans JP', sans-serif"

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

// Builds a plane mesh showing `text`, sized so its world-space height is `worldHeight` meters.
export const createTextMesh = (text, {worldHeight = 0.5, color = '#ff3b30'} = {}) => {
  const {texture, aspect} = createTextTexture(text, {color})
  const geometry = new THREE.PlaneGeometry(worldHeight * aspect, worldHeight)
  const material = new THREE.MeshBasicMaterial({map: texture, transparent: true, side: THREE.DoubleSide})
  return new THREE.Mesh(geometry, material)
}
