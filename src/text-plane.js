// Builds real 3D solid text (not a flat texture) by parsing actual glyph outlines from a bundled
// font file and extruding them with three.js. A vector outline gives crisp edges at any size and
// a single continuous volume, unlike the earlier canvas-texture + stacked-layers approach, whose
// many overlapping semi-transparent planes both blurred edges and made opacity compound far
// beyond the intended value. The bundled font is a subset of Noto Sans JP -- ASCII, kana, and the
// ~3000 Jouyou/Kyoiku-use kanji -- keeping the download small while covering ordinary Japanese
// input; a character outside that set won't render.
import * as THREE from 'three'
import opentype from 'opentype.js'

import fontUrl from './assets/NotoSansJP-subset.otf?url'

export const TEXT_WORLD_HEIGHT = 2.5 // meters
const TEXT_THICKNESS_RATIO = 0.12 // extrusion depth, as a fraction of worldHeight
const TEXT_OVERALL_OPACITY = 0.8
// Multi-character text packs its glyphs as tight as opentype.js's own letter-spacing option
// allows (a negative value pulls characters closer together), rather than leaving the font's
// default advance width -- this was previously a runtime slider the player could adjust, but
// swapping a placed text's geometry live mid-game made the rod-contact bookkeeping (which
// group is at which array index, which box belongs to it) fragile, so it's now fixed at
// creation time instead, same as everything else about a placed text's shape.
const MAX_TIGHT_LETTER_SPACING = -0.1
const MARKER_EMBED = 0.08 // meters the start/goal markers sit inside the text's left/right edge,
                          // so they're adjacent to (overlapping) the text rather than floating
                          // just outside it

let fontPromise = null
export const loadFont = () => {
  if (!fontPromise) {
    fontPromise = fetch(fontUrl)
      .then((res) => res.arrayBuffer())
      .then((buffer) => opentype.parse(buffer))
  }
  return fontPromise
}

// Splits an opentype.js path into its individual closed contours, converting each to a
// three.js Path so its point-based signed area can be measured. In this font's outlines, a
// negative signed area is a solid (fillable) contour and a positive one is a hole -- empirically
// verified against a character with a nested hole (回), which produced alternating signs at each
// nesting level.
const contoursOf = (otPath) => {
  const contours = []
  let current = null
  otPath.commands.forEach((cmd) => {
    if (cmd.type === 'M') {
      current = new THREE.Path()
      contours.push(current)
    }
    if (!current) {
      return
    }
    if (cmd.type === 'M') current.moveTo(cmd.x, cmd.y)
    else if (cmd.type === 'L') current.lineTo(cmd.x, cmd.y)
    else if (cmd.type === 'C') current.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y)
    else if (cmd.type === 'Q') current.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y)
  })
  return contours.map((path) => {
    const points = path.getPoints()
    let area = 0
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      area += a.x * b.y - b.x * a.y
    }
    return {points, area: area / 2}
  })
}

const pointInPolygon = (point, polygon) => {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]
    const b = polygon[j]
    const crosses = a.y > point.y !== b.y > point.y
    if (crosses && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

// Converts a run of text's glyph outlines into extrudable shapes, attaching each hole contour to
// whichever solid contour geometrically contains it (so e.g. 回's inner solid square sits inside
// its outer frame's hole as its own shape, rather than being merged into one).
const pathToShapes = (otPath) => {
  const contours = contoursOf(otPath)
  const solids = contours.filter((c) => c.area < 0).map((c) => ({shape: new THREE.Shape(c.points), points: c.points}))
  contours
    .filter((c) => c.area >= 0)
    .forEach((hole) => {
      const owner = solids.find((s) => pointInPolygon(hole.points[0], s.points))
      if (owner) {
        owner.shape.holes.push(new THREE.Path(hole.points))
      }
    })
  return solids.map((s) => s.shape)
}

// Builds a group showing `text` as a solid, shadow-casting 3D object sized so its world-space
// height is `worldHeight` meters. The group is centered on X/Z with its bottom at local y=0, so
// placing it at a ground hit point sits it directly on the ground.
export const createTextMesh = async (text, {worldHeight = TEXT_WORLD_HEIGHT, color = '#ff3b30'} = {}) => {
  const font = await loadFont()
  const letterSpacing = text.length > 1 ? MAX_TIGHT_LETTER_SPACING : 0
  const otPath = font.getPath(text, 0, 0, 1, {letterSpacing}) // fontSize=1 -> coordinates are fractions of an em
  const shapes = pathToShapes(otPath)

  const group = new THREE.Group()
  if (shapes.length === 0) {
    return group // e.g. blank input, or a glyph outside the bundled font's coverage
  }

  const box = otPath.getBoundingBox()
  const emHeight = box.y2 - box.y1
  const scale = worldHeight / emHeight

  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: emHeight * TEXT_THICKNESS_RATIO,
    bevelEnabled: false,
  })
  // opentype.js paths are Y-down (like a canvas); flipping Y here both corrects that and applies
  // the em-units-to-meters scale in one step.
  geometry.scale(scale, -scale, scale)
  geometry.computeBoundingBox()
  const bounds = geometry.boundingBox
  geometry.translate(
    -(bounds.min.x + bounds.max.x) / 2,
    -bounds.min.y,
    -(bounds.min.z + bounds.max.z) / 2
  )

  const material = new THREE.MeshStandardMaterial({
    color,
    transparent: true,
    opacity: TEXT_OVERALL_OPACITY,
    side: THREE.DoubleSide,
    roughness: 0.6,
    depthWrite: false, // lets whatever's behind (e.g. the probe rod) still show through faintly
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)

  // Local-space points just inside the text's left/right edges, in reading order -- the caller
  // uses these to place start/goal markers as children of this same group, so they automatically
  // follow wherever the text is placed and rotated without any extra transform math. Embedding
  // them into the text (rather than floating just outside it) keeps them visually attached to it.
  //
  // The bounding box's min/max X aren't necessarily where the glyph actually has material at
  // vertical-center height -- e.g. "A" is widest at its base, not its middle, so its bbox-left
  // edge sits in open air once you're back up at center height. Raycasting inward from just
  // outside the box at that height finds where the outline (the first/last character's edge, in
  // reading order) actually is, falling back to the box edge if that particular scan misses.
  geometry.computeBoundingBox() // translate() above doesn't refresh the cached box itself
  const finalBounds = geometry.boundingBox
  const centerY = (finalBounds.min.y + finalBounds.max.y) / 2
  const width = finalBounds.max.x - finalBounds.min.x
  const embed = Math.min(MARKER_EMBED, width / 4) // don't let start/goal cross for very narrow glyphs

  const edgeRaycaster = new THREE.Raycaster()
  const findEdgeX = (fromLeft) => {
    const dir = new THREE.Vector3(fromLeft ? 1 : -1, 0, 0)
    const startX = fromLeft ? finalBounds.min.x - 1 : finalBounds.max.x + 1
    edgeRaycaster.set(new THREE.Vector3(startX, centerY, 0), dir)
    const [hit] = edgeRaycaster.intersectObject(mesh, false)
    return hit ? hit.point.x : (fromLeft ? finalBounds.min.x : finalBounds.max.x)
  }
  const leftEdgeX = findEdgeX(true)
  const rightEdgeX = findEdgeX(false)

  group.userData.startLocal = new THREE.Vector3(leftEdgeX + embed, centerY, 0)
  group.userData.goalLocal = new THREE.Vector3(rightEdgeX - embed, centerY, 0)
  // The text is already centered on local X=0, so that's the natural midpoint between start and
  // goal for a checkpoint -- no edge-finding needed here, unlike start/goal above.
  group.userData.checkpointLocal = new THREE.Vector3(0, centerY, 0)

  return group
}
