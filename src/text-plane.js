// Builds real 3D solid text (not a flat texture) by parsing actual glyph outlines from a bundled
// font file and extruding them with three.js. A vector outline gives crisp edges at any size and
// a single continuous volume, unlike the earlier canvas-texture + stacked-layers approach, whose
// many overlapping semi-transparent planes both blurred edges and made opacity compound far
// beyond the intended value. The bundled fonts are subsets -- ASCII, kana, and the ~3000
// Jouyou/Kyoiku-use kanji -- keeping the download small while covering ordinary Japanese input;
// a character outside that set (or missing from a given font) won't render properly.
import * as THREE from 'three'
import opentype from 'opentype.js'

import notoSansUrl from './assets/NotoSansJP-subset.otf?url'
import zenMaruUrl from './assets/ZenMaruGothic-subset.ttf?url'
import delaUrl from './assets/DelaGothicOne-subset.ttf?url'
import notoSerifUrl from './assets/NotoSerifJP-subset.ttf?url'
import zenAntiqueUrl from './assets/ZenAntique-subset.ttf?url'

// Fonts the player can pick from, all open-licence (OFL) Google Fonts families chosen so their
// shapes read as clearly different at a glance. Each is a subset of the same character set
// (ASCII, kana, ~3000 Jouyou/Kyoiku-use kanji) bundled with the app rather than fetched from
// Google at runtime, so the app still has no external font dependency; only the font actually
// in use is downloaded.
export const FONTS = [
  {id: 'noto-sans', group: 'ゴシック', label: 'Noto Sans JP（標準）', url: notoSansUrl},
  {id: 'zen-maru', group: 'ゴシック', label: 'Zen Maru Gothic（丸）', url: zenMaruUrl},
  {id: 'dela-gothic', group: 'ゴシック', label: 'Dela Gothic One（極太）', url: delaUrl},
  {id: 'noto-serif', group: '明朝', label: 'Noto Serif JP（標準）', url: notoSerifUrl},
  {id: 'zen-antique', group: '明朝', label: 'Zen Antique（古風）', url: zenAntiqueUrl},
]
export const DEFAULT_FONT_ID = FONTS[0].id

export const TEXT_WORLD_HEIGHT = 6.25 // meters
const TEXT_THICKNESS_RATIO = 0.12 // extrusion depth, as a fraction of worldHeight
const TEXT_OVERALL_OPACITY = 0.65
// Multi-character text packs its glyphs as tight as opentype.js's own letter-spacing option
// allows (a negative value pulls characters closer together), rather than leaving the font's
// default advance width -- this was previously a runtime slider the player could adjust, but
// swapping a placed text's geometry live mid-game made the rod-contact bookkeeping (which
// group is at which array index, which box belongs to it) fragile, so it's now fixed at
// creation time instead, same as everything else about a placed text's shape.
const MAX_TIGHT_LETTER_SPACING = -0.1
const MARKER_EMBED = 0.2 // meters the start/goal markers sit inside the text's left/right edge,
                          // so they're adjacent to (overlapping) the text rather than floating
                          // just outside it

const fontPromises = new Map()
export const loadFont = (fontId = DEFAULT_FONT_ID) => {
  if (!fontPromises.has(fontId)) {
    const {url} = FONTS.find((f) => f.id === fontId) || FONTS[0]
    fontPromises.set(
      fontId,
      fetch(url)
        .then((res) => res.arrayBuffer())
        .then((buffer) => opentype.parse(buffer))
    )
  }
  return fontPromises.get(fontId)
}

// Splits an opentype.js path into its individual closed contours, converting each to a
// three.js Path so its point-based signed area can be measured. Which sign means "solid" depends
// on the font's outline format (CFF-based .otf and TrueType-based .ttf wind outer contours in
// opposite directions), so pathToShapes works that out per run of text rather than assuming it.
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
  if (contours.length === 0) {
    return {shapes: [], outlines: []}
  }
  // The largest contour in any run of text is always an outer (solid) one -- a hole is by
  // definition inside something bigger -- so its winding direction is this font's "solid" sign.
  const largest = contours.reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a))
  const solidSign = Math.sign(largest.area)
  const isSolid = (c) => c.area * solidSign > 0
  const solids = contours.filter(isSolid).map((c) => ({shape: new THREE.Shape(c.points), points: c.points}))
  const usedOutlines = solids.map((s) => s.points)
  contours
    .filter((c) => !isSolid(c))
    .forEach((hole) => {
      const owner = solids.find((s) => pointInPolygon(hole.points[0], s.points))
      if (owner) {
        owner.shape.holes.push(new THREE.Path(hole.points))
        usedOutlines.push(hole.points)
      }
    })
  return {shapes: solids.map((s) => s.shape), outlines: usedOutlines}
}

// Builds a group showing `text` as a solid, shadow-casting 3D object sized so its world-space
// height is `worldHeight` meters. The group is centered on X/Z with its bottom at local y=0, so
// placing it at a ground hit point sits it directly on the ground.
export const createTextMesh = async (text, {worldHeight = TEXT_WORLD_HEIGHT, color = '#ff3b30', fontId = DEFAULT_FONT_ID} = {}) => {
  const font = await loadFont(fontId)
  const letterSpacing = text.length > 1 ? MAX_TIGHT_LETTER_SPACING : 0
  const otPath = font.getPath(text, 0, 0, 1, {letterSpacing}) // fontSize=1 -> coordinates are fractions of an em
  const {shapes, outlines} = pathToShapes(otPath)

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
  // Captured now: computeBoundingBox() below mutates this same Box3 in place once translated.
  const centerOffsetX = (bounds.min.x + bounds.max.x) / 2
  const baseOffsetY = bounds.min.y
  geometry.translate(
    -centerOffsetX,
    -baseOffsetY,
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

  // The same outlines the mesh was extruded from, mapped into the mesh's final local coordinates
  // (same scale / Y-flip / centering as the geometry above) as flat [x0, y0, x1, y1, ...] arrays,
  // each with its own 2D bounds. Since the text is a straight extrusion, a point is inside the
  // solid exactly when its z is within the extrusion depth and its (x, y) is inside the outlines --
  // which the contact check does with a cheap winding-number test instead of ray-casting against
  // thousands of triangles every frame.
  geometry.computeBoundingBox()
  const depthBounds = geometry.boundingBox
  group.userData.glyph = {
    zMin: depthBounds.min.z,
    zMax: depthBounds.max.z,
    contours: outlines.map((points) => {
      const pts = new Float32Array(points.length * 2)
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      points.forEach((p, i) => {
        const x = p.x * scale - centerOffsetX
        const y = -p.y * scale - baseOffsetY
        pts[i * 2] = x
        pts[i * 2 + 1] = y
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      })
      return {pts, minX, maxX, minY, maxY}
    }),
  }

  // Local-space points just inside the text's corners, placed diagonally opposite each other
  // (start near the bottom-left, goal near the top-right) so the course spans the object's full
  // footprint instead of a single straight line through its vertical center -- the caller uses
  // these to place start/goal markers as children of this same group, so they automatically
  // follow wherever the text is placed and rotated without any extra transform math. Embedding
  // them into the text (rather than floating just outside it) keeps them visually attached to it.
  //
  // The bounding box's min/max X aren't necessarily where the glyph actually has material at a
  // given height -- e.g. "A" is widest at its base, not its middle, so its bbox-left edge sits in
  // open air away from its base. Raycasting inward from just outside the box at that height finds
  // where the outline (the first/last character's edge, in reading order) actually is. Several
  // candidate heights are tried, moving toward vertical-center, in case the corner height itself
  // happens to miss the glyph entirely (e.g. a character with no material near one corner), and
  // if every candidate misses, this falls back to the box's own corner.
  geometry.computeBoundingBox() // translate() above doesn't refresh the cached box itself
  const finalBounds = geometry.boundingBox
  const centerY = (finalBounds.min.y + finalBounds.max.y) / 2
  const height = finalBounds.max.y - finalBounds.min.y
  const width = finalBounds.max.x - finalBounds.min.x
  const embed = Math.min(MARKER_EMBED, width / 4) // don't let start/goal cross for very narrow glyphs
  const CORNER_INSET_RATIO = 0.18 // how far in from the top/bottom edge the diagonal corners sit

  const edgeRaycaster = new THREE.Raycaster()
  const findEdgeXAt = (fromLeft, y) => {
    const dir = new THREE.Vector3(fromLeft ? 1 : -1, 0, 0)
    const startX = fromLeft ? finalBounds.min.x - 1 : finalBounds.max.x + 1
    edgeRaycaster.set(new THREE.Vector3(startX, y, 0), dir)
    const [hit] = edgeRaycaster.intersectObject(mesh, false)
    return hit ? hit.point.x : null
  }
  // Tries the corner height first, then partway toward vertical-center, then center itself.
  const findCornerX = (fromLeft, cornerY) => {
    for (const y of [cornerY, (cornerY + centerY) / 2, centerY]) {
      const x = findEdgeXAt(fromLeft, y)
      if (x !== null) {
        return {x, y}
      }
    }
    return {x: fromLeft ? finalBounds.min.x : finalBounds.max.x, y: cornerY}
  }

  const bottomY = finalBounds.min.y + height * CORNER_INSET_RATIO
  const topY = finalBounds.max.y - height * CORNER_INSET_RATIO
  const start = findCornerX(true, bottomY)
  const goal = findCornerX(false, topY)

  group.userData.startLocal = new THREE.Vector3(start.x + embed, start.y, 0)
  group.userData.goalLocal = new THREE.Vector3(goal.x - embed, goal.y, 0)

  return group
}
