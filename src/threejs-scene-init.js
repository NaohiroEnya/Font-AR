// 8th Wall XR Camera Pipeline Module: lets the user tap the ground to fix text in real space,
// select a placed text to drag-reposition, resize, or delete it, and play an "operation game"
// pass at it with a probe rod fixed to the device.
// XR8.XrController provides real 6DoF SLAM tracking, so text placed here stays anchored to the
// physical location it was tapped on, including depth (distance from the camera) — unlike a
// DeviceOrientation-only approach, which can only react to tilt, not real-world position.
import * as THREE from 'three'

import {createTextMesh, loadFont} from './text-plane'
import {createRunRecorder} from './run-recorder'

const PROBE_RADIUS = 0.07 // meters -- thick enough to read clearly on a phone screen
const PROBE_LENGTH = 4.5
const PROBE_NEAR = 0.2 // gap between the camera and the rod's near end, so small SLAM pose
                        // jitter (which is magnified a lot for geometry right at the lens)
                        // doesn't make the rod visibly shake
const PROBE_Y_OFFSET = -0.45 // camera-local: shifts the whole rod down, so it reads as
                             // emerging from the bottom-center of the screen rather than
                             // dead-center, while staying perfectly parallel to the device
const CONTACT_SAMPLE_STEP = 0.04 // meters between points sampled along the rod's length each
                                  // frame when checking for contact -- finer than the rod's own
                                  // radius, so a thin or steeply-angled stroke can't slip between
                                  // two consecutive length samples
const CONTACT_RADIAL_SAMPLES = 8 // extra points checked around each length sample, at the rod's
                                  // own radius, approximating its actual cylindrical volume --
                                  // without these, only the centerline (an infinitely thin line)
                                  // is tested, so the rod could be visibly half-overlapping a
                                  // stroke along its edge while its exact centerline sits just
                                  // past it, reading as a full miss

// Builds the "operation game" probe: a thin rod that always reads as emerging from the
// bottom-center of the screen and running straight ahead, parallel to the device. Its geometry
// is pre-offset (down + forward) so that syncing this mesh's position/quaternion directly to
// the camera's every frame (see onUpdate below) reproduces that fixed screen position exactly,
// with zero drift regardless of how the device rotates. It's flat-shaded (MeshBasicMaterial) so
// it always reads as a solid, saturated blue instead of going dark when a lit material's visible
// face happens to point away from the scene's fixed directional light. Because it's still a real
// object in the SLAM world-space scene (not a 2D screen overlay), it visually pierces through
// (or is occluded by) text placed in the room as the device moves through space.
const buildRodGeometry = (length) => {
  const geometry = new THREE.CylinderGeometry(PROBE_RADIUS, PROBE_RADIUS, length, 20)
  geometry.rotateX(-Math.PI / 2) // cylinder's axis (Y) now points down the camera's forward axis (-Z)
  geometry.translate(0, PROBE_Y_OFFSET, -(PROBE_NEAR + length / 2))
  return geometry
}

const createProbeRod = (length) => {
  const material = new THREE.MeshBasicMaterial({color: 0x2979ff})
  const rod = new THREE.Mesh(buildRodGeometry(length), material)
  rod.castShadow = true
  return rod
}

// True if `local` (a point already in the text mesh's own local space) is inside the text's solid
// volume: within the extrusion depth, and with a non-zero winding number against the glyph
// outlines (outer contours and holes wind oppositely, so a point in a hole nets to zero). This is
// the same answer a ray-parity test against the extruded mesh would give, but it only walks a few
// hundred outline points -- the mesh test scanned every triangle (thousands, for the more detailed
// fonts) for each of the ~1000 sample points per frame.
const isPointInsideGlyph = (local, glyph) => {
  if (local.z < glyph.zMin || local.z > glyph.zMax) {
    return false
  }
  const {x, y} = local
  let winding = 0
  for (const c of glyph.contours) {
    if (x < c.minX || x > c.maxX || y < c.minY || y > c.maxY) {
      continue
    }
    const p = c.pts
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const y1 = p[j + 1]
      const y2 = p[i + 1]
      if (y1 <= y !== y2 <= y) {
        const x1 = p[j]
        if (x1 + ((y - y1) / (y2 - y1)) * (p[i] - x1) > x) {
          winding += y2 > y1 ? 1 : -1
        }
      }
    }
  }
  return winding !== 0
}

const MARKER_RADIUS = 0.3
const MARKER_TOUCH_DISTANCE = MARKER_RADIUS + PROBE_RADIUS
const createMarker = (color) => {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(MARKER_RADIUS, 16, 16),
    new THREE.MeshStandardMaterial({color, emissive: color, emissiveIntensity: 0.4})
  )
  mesh.castShadow = true
  return mesh
}

// Adds start (green) / goal (red) markers as children of `group`, at the local points
// text-plane.js already worked out (just beyond the text's left/right edge). As children they
// automatically follow the group's placement, facing, and scale -- no extra transform math
// needed here, and they're removed along with the text for free when the group is deleted.
// References are kept on userData so the run-timer logic can find them later without
// re-traversing children.
const addStartGoalMarkers = (group) => {
  const {startLocal, goalLocal} = group.userData
  if (!startLocal || !goalLocal) {
    return // e.g. blank input, which produced an empty group
  }
  const start = createMarker(0x2fa36b)
  start.position.copy(startLocal)
  group.add(start)
  group.userData.startMarker = start

  const goal = createMarker(0xe0663d)
  goal.position.copy(goalLocal)
  group.add(goal)
  group.userData.goalMarker = goal
}

// True if the rod's current segment [near, far] passes within touching distance of `marker`.
// Uses the exact closest point on the segment rather than discrete sampling (unlike the text
// contact check) since a sphere-vs-segment distance has a simple closed form -- no need to
// approximate a solid volume here.
//
// `scale` is the marker's owning group's current scale (from the resize slider): the marker mesh
// itself shrinks/grows correctly as a scaled child, but MARKER_TOUCH_DISTANCE is a plain world-
// space constant, so without this it would stay fixed at ~19cm regardless of how small the text
// (and its marker) had been resized -- on a text shrunk to e.g. 0.3x, that would leave a "safe"
// halo several times wider than the marker was actually drawn.
const markerWorldPos = new THREE.Vector3()
const closestOnRod = new THREE.Vector3()
const isRodTouchingMarker = (rodLine, marker, scale) => {
  if (!marker) {
    return false
  }
  marker.getWorldPosition(markerWorldPos)
  rodLine.closestPointToPoint(markerWorldPos, true, closestOnRod)
  return closestOnRod.distanceTo(markerWorldPos) <= MARKER_TOUCH_DISTANCE * scale
}

const SELECTION_RING_COLOR = 0x2979ff

// A thin flat ring, sized to the selected text's footprint, added as a child of its group so it
// automatically follows that group's position, rotation, and (importantly, for the resize
// slider) scale without any extra transform math.
const createSelectionRing = (group) => {
  const mesh = group.children[0]
  if (!mesh) {
    return null // e.g. blank input, which produced an empty group
  }
  const bounds = mesh.geometry.boundingBox
  const outerRadius = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 0.65 + 0.04
  const geometry = new THREE.RingGeometry(outerRadius * 0.85, outerRadius, 40)
  geometry.rotateX(-Math.PI / 2)
  const material = new THREE.MeshBasicMaterial({
    color: SELECTION_RING_COLOR,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const ring = new THREE.Mesh(geometry, material)
  ring.position.y = 0.003 // just above the ground text sits on, to avoid z-fighting
  ring.renderOrder = 1
  return ring
}

export const initScenePipelineModule = ({onSelectionChange, onClear} = {}) => {
  // Plane used both as the raycast target for tap placement and as a shadow-catcher: it's
  // invisible except where a placed text object blocks the light, so text reads as sitting on
  // the ground rather than floating.
  const groundGeometry = new THREE.PlaneGeometry(2000, 2000)
  groundGeometry.rotateX(-Math.PI / 2)
  const groundMaterial = new THREE.ShadowMaterial()
  groundMaterial.opacity = 0.35
  const ground = new THREE.Mesh(groundGeometry, groundMaterial)
  ground.receiveShadow = true

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const placedTexts = [] // groups currently placed in the scene, for tap-to-select
  const textBoxes = new Map() // group -> world-space Box3, refreshed whenever a group moves/resizes
  const textInverses = new Map() // group -> inverse of its mesh's world matrix, refreshed with the box
  let rodLength = PROBE_LENGTH
  const probeRod = createProbeRod(rodLength)

  let selectedGroup = null
  let dragTouchId = null // touch identifier currently dragging selectedGroup, or null
  let liveScene = null

  const getInputText = () => document.getElementById('text-input').value.trim() || 'AR'
  const getInputFontId = () => document.getElementById('font-select').value || undefined

  // A cheap AABB pre-filter for isRodTouchingAnyText below, not the actual contact boundary --
  // that's still the text's exact solid volume (isPointInsideGlyph). Computed from the text mesh
  // alone (group.children[0]), not the whole group: the group can also carry UI-only children --
  // the selection ring, while a text is selected -- and including those inflated this box hugely
  // (a wide/flat ring's own bounding box extends far past the actual glyph's shallow extruded
  // depth), leaving a giant stale pre-filter around any text that had ever been selected, even
  // long after deselecting it. Markers are left out too: they sit embedded just inside the mesh's
  // own edge by construction, so this box already covers them, and their own contact is checked
  // separately (isRodTouchingMarker) regardless.
  //
  // Box3.setFromObject(mesh) internally does mesh.updateWorldMatrix(false, false) -- it refreshes
  // the mesh's own matrix but, unlike calling it on the group directly, does NOT walk up to
  // refresh the group's matrixWorld first. Right after changing group.position/scale (here, via a
  // touchmove drag, or via setSelectedScale) nothing else has necessarily re-run a scene-wide
  // matrix update yet, so that would read the group's matrixWorld from before the change --
  // explicitly forcing the parent chain here first keeps this correct regardless of timing.
  const refreshBox = (group) => {
    const mesh = group.children[0]
    if (mesh) {
      mesh.updateWorldMatrix(true, false)
    }
    textBoxes.set(group, new THREE.Box3().setFromObject(mesh || group))
    if (mesh) {
      textInverses.set(group, mesh.matrixWorld.clone().invert())
    }
  }

  // In community mode a fixed course ({text, fontId, scale}) is being played instead of whatever's
  // typed into the input; sceneEpoch changes whenever the scene is reset, so a text that was still
  // being built when that happened can tell it's no longer wanted.
  let activeCourse = null
  let sceneEpoch = 0
  let placing = false

  const placeTextAt = async ({scene, camera}, point) => {
    const epoch = sceneEpoch
    const course = activeCourse
    const group = await createTextMesh(
      course ? course.text : getInputText(),
      {fontId: course ? course.fontId : getInputFontId()}
    )
    if (epoch !== sceneEpoch) {
      return
    }
    if (course) {
      group.scale.setScalar(course.scale)
    }
    group.position.copy(point)
    group.quaternion.copy(camera.quaternion) // face the viewer at the moment it's placed
    addStartGoalMarkers(group)
    scene.add(group)
    placedTexts.push(group)
    refreshBox(group)
  }

  const removeText = (scene, group) => {
    scene.remove(group)
    placedTexts.splice(placedTexts.indexOf(group), 1)
    textBoxes.delete(group)
    textInverses.delete(group)
  }

  const deselect = () => {
    if (!selectedGroup) {
      return
    }
    const ring = selectedGroup.userData.selectionRing
    if (ring) {
      selectedGroup.remove(ring)
      ring.geometry.dispose()
      ring.material.dispose()
      delete selectedGroup.userData.selectionRing
    }
    selectedGroup = null
    dragTouchId = null
    if (onSelectionChange) {
      onSelectionChange(null)
    }
  }

  const select = (group) => {
    if (group === selectedGroup) {
      return
    }
    deselect()
    selectedGroup = group
    const ring = createSelectionRing(group)
    if (ring) {
      group.add(ring)
      group.userData.selectionRing = ring
    }
    if (onSelectionChange) {
      onSelectionChange(group)
    }
  }

  const setSelectedScale = (scale) => {
    if (!selectedGroup || activeCourse) { // a course's size is part of the course
      return
    }
    selectedGroup.scale.setScalar(scale)
    refreshBox(selectedGroup) // the cached box is in world space, so a scale change invalidates it
  }

  const deleteSelected = () => {
    if (!selectedGroup || !liveScene) {
      return
    }
    const group = selectedGroup
    deselect()
    removeText(liveScene, group)
  }

  // Recomputes the rod's current world-space centerline from the live camera each frame. Shared
  // by both the text-contact check (sampled) and the marker-contact check (exact), so the
  // camera's position/quaternion only need to be applied once per frame. Also tracks the rod's
  // own local X/Y axes in world space, so isRodTouchingAnyText can offset sample points around
  // the centerline to cover the rod's actual cross-section (see CONTACT_RADIAL_SAMPLES above).
  const rodNearLocal = new THREE.Vector3(0, PROBE_Y_OFFSET, -PROBE_NEAR)
  const rodFarLocal = new THREE.Vector3(0, PROBE_Y_OFFSET, -(PROBE_NEAR + rodLength))
  const rodNear = new THREE.Vector3()
  const rodFar = new THREE.Vector3()
  const rodLine = new THREE.Line3(rodNear, rodFar)
  const rodAxisX = new THREE.Vector3()
  const rodAxisY = new THREE.Vector3()
  const updateRodSegment = (camera) => {
    rodNear.copy(rodNearLocal).applyQuaternion(camera.quaternion).add(camera.position)
    rodFar.copy(rodFarLocal).applyQuaternion(camera.quaternion).add(camera.position)
    rodAxisX.set(1, 0, 0).applyQuaternion(camera.quaternion)
    rodAxisY.set(0, 1, 0).applyQuaternion(camera.quaternion)
  }

  const radialAngles = Array.from(
    {length: CONTACT_RADIAL_SAMPLES},
    (_, i) => (i / CONTACT_RADIAL_SAMPLES) * Math.PI * 2
  )

  // Samples points along the rod's length and, at each one, also around its actual cross-section
  // (not just the centerline), checking each against every placed text's actual solid volume --
  // so leaving the actual glyph shape (a gap between two characters, or the hollow center of one
  // like 回) reads as OUT, while any part of the rod's real volume still touching stroke material
  // anywhere along its length reads SAFE, including a partial edge-on overlap.
  const point = new THREE.Vector3()
  const testPoint = new THREE.Vector3()
  const localPoint = new THREE.Vector3()
  const isInsideText = (worldPoint, box, inverse, glyph) =>
    box.containsPoint(worldPoint) && isPointInsideGlyph(localPoint.copy(worldPoint).applyMatrix4(inverse), glyph)

  const isRodTouchingAnyText = () => {
    const sampleCount = Math.ceil(rodLength / CONTACT_SAMPLE_STEP)

    for (let i = 0; i <= sampleCount; i += 1) {
      point.lerpVectors(rodNear, rodFar, i / sampleCount)
      for (const group of placedTexts) {
        const glyph = group.userData.glyph
        const box = textBoxes.get(group)
        const inverse = textInverses.get(group)
        if (!glyph || !box || !inverse) continue // empty group (e.g. blank input), or not yet placed

        if (isInsideText(point, box, inverse, glyph)) {
          return true
        }
        for (const angle of radialAngles) {
          testPoint.copy(point)
            .addScaledVector(rodAxisX, Math.cos(angle) * PROBE_RADIUS)
            .addScaledVector(rodAxisY, Math.sin(angle) * PROBE_RADIUS)
          if (isInsideText(testPoint, box, inverse, glyph)) {
            return true
          }
        }
      }
    }
    return false
  }

  const setRodLength = (length) => {
    rodLength = length
    rodFarLocal.z = -(PROBE_NEAR + length)
    probeRod.geometry.dispose()
    probeRod.geometry = buildRodGeometry(length)
  }

  const initXrScene = ({scene, camera, renderer}) => {
    renderer.shadowMap.enabled = true
    scene.add(ground)
    scene.add(probeRod)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2)
    directionalLight.position.set(3, 6, 4)
    directionalLight.castShadow = true
    directionalLight.shadow.mapSize.set(2048, 2048)
    const shadowCam = directionalLight.shadow.camera
    shadowCam.left = -10
    shadowCam.right = 10
    shadowCam.top = 10
    shadowCam.bottom = -10
    shadowCam.far = 30
    shadowCam.updateProjectionMatrix()
    scene.add(directionalLight)
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))

    camera.position.set(0, 2, 2)
  }

  let liveCamera = null
  let lastTouching = null
  const statusEl = document.getElementById('contact-status')

  // `safe` covers both real contact with a text's solid volume and contact with one of its
  // start/goal markers -- the markers are part of the course by definition, not just a
  // geometric coincidence of sitting next to the text, so touching one always counts.
  const updateContactStatus = (safe) => {
    if (safe === lastTouching) {
      return
    }
    lastTouching = safe
    statusEl.textContent = safe ? 'SAFE' : 'OUT'
    statusEl.classList.toggle('safe', safe)
    statusEl.classList.toggle('out', !safe)
  }

  // Run state: touching any start marker (re)starts the clock; touching any goal marker while
  // running stops it and freezes the elapsed time as a clear. Losing safe contact while running
  // ends the run as a game over instead. Goal touches are ignored before a run has started, and
  // from 'cleared'/'gameover' only touching start again begins a fresh run. With multiple texts
  // placed at once, any start/goal/text works interchangeably for now -- there's no per-text
  // course tracking yet.
  let runState = 'idle' // 'idle' | 'running' | 'cleared' | 'gameover'
  let runStartedAt = 0
  let finalElapsedMs = 0
  const timerEl = document.getElementById('timer-status')

  const formatSeconds = (ms) => (ms / 1000).toFixed(1) + 's'
  let lastTimerText = null

  const setTimerText = (text, className) => {
    if (text === lastTimerText) {
      return // avoid rewriting the DOM every frame while the displayed value hasn't changed
    }
    lastTimerText = text
    timerEl.textContent = text
    timerEl.classList.remove('cleared', 'gameover')
    if (className) {
      timerEl.classList.add(className)
    }
  }

  // Both overlays darken the whole screen (camera feed still faintly visible through them) and
  // block taps on the placement/selection panels underneath until dismissed. Dismissing either
  // just returns runState to 'idle' -- neither touches the placed text objects or the text
  // input's value, so the course stays put and whatever was typed is still there to reuse.
  const gameoverOverlayEl = document.getElementById('gameover-overlay')
  const gameoverTimeEl = document.getElementById('gameover-time')
  document.getElementById('gameover-continue').addEventListener('click', () => {
    runState = 'idle'
    gameoverOverlayEl.hidden = true
  })

  // Run recording (START -> CLEAR). The SAFE/OUT badge and timer are DOM elements, so they aren't
  // part of the AR canvas; each recorded frame gets them painted on from their live on-screen
  // position, size, colors, and text.
  let liveCanvas = null
  // Background colors are chosen from the elements' state classes rather than read back from the
  // live style, which would catch the CSS color transition part-way through a change.
  const statusColor = () => (statusEl.classList.contains('safe') ? 'rgba(47, 163, 107, 0.9)' : 'rgba(224, 102, 61, 0.9)')
  const timerColor = () => {
    if (timerEl.classList.contains('cleared')) return 'rgba(173, 80, 255, 0.9)'
    if (timerEl.classList.contains('gameover')) return 'rgba(200, 40, 40, 0.92)'
    return 'rgba(0, 0, 0, 0.55)'
  }
  const drawHudPill = (ctx, el, k, background) => {
    const rect = el.getBoundingClientRect()
    if (!rect.width) {
      return
    }
    const style = getComputedStyle(el)
    const x = rect.left * k
    const y = rect.top * k
    const w = rect.width * k
    const h = rect.height * k
    ctx.fillStyle = background
    ctx.beginPath()
    ctx.moveTo(x + h / 2, y)
    ctx.arcTo(x + w, y, x + w, y + h, h / 2)
    ctx.arcTo(x + w, y + h, x, y + h, h / 2)
    ctx.arcTo(x, y + h, x, y, h / 2)
    ctx.arcTo(x, y, x + w, y, h / 2)
    ctx.fill()
    ctx.fillStyle = style.color
    ctx.font = `${style.fontWeight} ${parseFloat(style.fontSize) * k}px ${style.fontFamily}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(el.textContent, x + w / 2, y + h / 2)
  }
  const recorder = createRunRecorder({
    getSourceCanvas: () => liveCanvas,
    drawOverlay: (ctx, k) => {
      drawHudPill(ctx, statusEl, k, statusColor())
      drawHudPill(ctx, timerEl, k, timerColor())
    },
  })

  // The recording of the run that just cleared, held in memory only while the CLEAR screen is up --
  // dismissing it (RETRY) or starting another run drops it, and nothing is ever written anywhere
  // unless the player taps save.
  const clearSaveEl = document.getElementById('clear-save')
  let clearVideo = null
  let clearVideoToken = 0 // so a recording still being finalized can tell its screen was dismissed
  const discardClearVideo = () => {
    clearVideoToken += 1
    clearVideo = null
    clearSaveEl.hidden = true
  }

  const downloadFile = (file) => {
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  // Web pages can't write to the camera roll directly; the share sheet's "Save Video" (iOS) is the
  // way in. It has to be opened from this tap, hence the File being ready beforehand. Browsers
  // without file sharing (desktop) get a plain download instead.
  clearSaveEl.addEventListener('click', async () => {
    const file = clearVideo
    if (!file) {
      return
    }
    if (navigator.canShare && navigator.canShare({files: [file]})) {
      try {
        await navigator.share({files: [file], title: 'Font AR'})
      } catch (error) {
        if (error.name !== 'AbortError') {
          downloadFile(file)
        }
      }
    } else {
      downloadFile(file)
    }
  })

  const clearOverlayEl = document.getElementById('clear-overlay')
  const clearTimeEl = document.getElementById('clear-time')
  const clearBestEl = document.getElementById('clear-best')
  document.getElementById('clear-retry').addEventListener('click', () => {
    runState = 'idle'
    clearOverlayEl.hidden = true
    discardClearVideo()
  })

  let wasTouchingStart = false

  const updateRunState = (safe, touchingStart, touchingGoal) => {
    let justCleared = false
    // A new recording starts each time the rod newly touches START (not every frame it stays
    // there), so going back to START mid-run begins the video over.
    if (touchingStart && !wasTouchingStart) {
      recorder.start()
      discardClearVideo()
    }
    wasTouchingStart = touchingStart

    if (touchingStart) {
      runState = 'running'
      runStartedAt = performance.now()
    } else if (touchingGoal && runState === 'running') {
      runState = 'cleared'
      finalElapsedMs = performance.now() - runStartedAt
      clearTimeEl.textContent = formatSeconds(finalElapsedMs)
      // In community mode the caller records the time and can hand back a line to show under it.
      clearBestEl.textContent = (activeCourse && onClear && onClear({course: activeCourse, elapsedMs: finalElapsedMs})) || ''
      clearOverlayEl.hidden = false
      justCleared = true
    } else if (runState === 'running' && !safe) {
      runState = 'gameover'
      finalElapsedMs = performance.now() - runStartedAt
      gameoverTimeEl.textContent = formatSeconds(finalElapsedMs)
      gameoverOverlayEl.hidden = false
      recorder.discard()
      // Two hard pulses, for impact. The Vibration API isn't implemented in iOS Safari, so this is
      // a silent no-op there (and on desktop); navigator.vibrate may also just return false if the
      // browser decides the page hasn't had enough user interaction yet.
      if (navigator.vibrate) {
        navigator.vibrate([400, 120, 400])
      }
    }

    if (runState === 'idle') {
      setTimerText('スタートに触れて計測開始', null)
    } else if (runState === 'running') {
      setTimerText(formatSeconds(performance.now() - runStartedAt), null)
    } else if (runState === 'cleared') {
      setTimerText(`CLEAR! ${formatSeconds(finalElapsedMs)}`, 'cleared')
    } else {
      setTimerText(`GAME OVER (${formatSeconds(finalElapsedMs)})`, 'gameover')
    }

    // Finished after the HUD text above has switched to "CLEAR!", so the video's last frame shows it.
    if (justCleared) {
      const token = (clearVideoToken += 1)
      clearVideo = null
      clearSaveEl.hidden = false
      clearSaveEl.disabled = true
      if (!recorder.supported) {
        // Say so instead of silently showing no button, so it's clear why there's no video.
        clearSaveEl.textContent = 'この端末は動画保存に非対応です'
        return
      }
      clearSaveEl.textContent = '動画を準備中…'
      recorder.finish().then((file) => {
        if (token !== clearVideoToken) {
          return // dismissed (or another run started) while the video was being finalized
        }
        clearVideo = file
        clearSaveEl.disabled = !file
        clearSaveEl.textContent = file ? '動画を保存' : '動画を保存できませんでした'
      })
    }
  }

  // Clears everything back to a fresh scene: placed texts, selection, run state, overlays, any
  // recording. Used whenever the player moves between modes/screens.
  const resetScene = () => {
    sceneEpoch += 1
    deselect()
    if (liveScene) {
      ;[...placedTexts].forEach((group) => removeText(liveScene, group))
    }
    runState = 'idle'
    wasTouchingStart = false
    recorder.discard()
    discardClearVideo()
    gameoverOverlayEl.hidden = true
    clearOverlayEl.hidden = true
    setTimerText('スタートに触れて計測開始', null)
  }

  // Starts (or, with null, stops) playing a fixed course. Comparable times need the same rod for
  // everyone, so a course always uses the default rod length.
  const setCourse = (course) => {
    resetScene()
    activeCourse = course
    if (course) {
      setRodLength(PROBE_LENGTH)
      loadFont(course.fontId)
    }
  }

  const pipelineModule = {
    name: 'textplacement',

    onStart: ({canvas}) => {
      const {scene, camera, renderer} = XR8.Threejs.xrScene()
      liveCamera = camera
      liveScene = scene
      liveCanvas = canvas
      loadFont() // kick off the font fetch/parse now, so it's likely ready by the first tap

      initXrScene({scene, camera, renderer})

      const setPointerFromTouch = (touch) => {
        pointer.x = (touch.clientX / window.innerWidth) * 2 - 1
        pointer.y = -(touch.clientY / window.innerHeight) * 2 + 1
      }

      XR8.XrController.updateCameraProjectionMatrix(
        {origin: camera.position, facing: camera.quaternion}
      )

      canvas.addEventListener('touchstart', async (event) => {
        if (event.touches.length !== 1) {
          return
        }

        const touch = event.touches[0]
        setPointerFromTouch(touch)
        raycaster.setFromCamera(pointer, camera)

        // Tapping an already-placed text selects it (or, if it's already selected, starts
        // dragging it); tapping empty ground either deselects, or -- if nothing is selected --
        // places a new text using whatever's currently in the text input.
        const [textHit] = raycaster.intersectObjects(placedTexts, true)
        if (textHit) {
          const hitGroup = textHit.object.parent
          if (hitGroup === selectedGroup) {
            dragTouchId = touch.identifier
          } else {
            select(hitGroup)
          }
          return
        }

        if (selectedGroup) {
          deselect()
          return
        }

        // A course is a single text; a second one only after the first is deleted.
        if (placing || (activeCourse && placedTexts.length > 0)) {
          return
        }
        const [groundHit] = raycaster.intersectObject(ground)
        if (groundHit) {
          placing = true
          try {
            await placeTextAt({scene, camera}, groundHit.point)
          } finally {
            placing = false
          }
        }
      }, true)

      canvas.addEventListener('touchmove', (event) => {
        event.preventDefault()

        if (dragTouchId === null) {
          return
        }
        const touch = Array.from(event.touches).find((t) => t.identifier === dragTouchId)
        if (!touch) {
          return
        }
        setPointerFromTouch(touch)
        raycaster.setFromCamera(pointer, camera)
        const [groundHit] = raycaster.intersectObject(ground)
        if (groundHit) {
          selectedGroup.position.copy(groundHit.point)
          refreshBox(selectedGroup) // the cached box is in world space, so moving invalidates it
        }
      }, true)

      const endDrag = () => {
        dragTouchId = null
      }
      canvas.addEventListener('touchend', endDrag, true)
      canvas.addEventListener('touchcancel', endDrag, true)
    },

    // Runs every processed camera frame. Explicitly re-copying the live camera's transform here
    // (rather than relying on the rod being a child of the camera object) keeps the rod's
    // fixed relationship to the device correct even if anything about the camera object's
    // internal update path changes over the session.
    onUpdate: () => {
      if (!liveCamera) {
        return
      }
      probeRod.position.copy(liveCamera.position)
      probeRod.quaternion.copy(liveCamera.quaternion)
      updateRodSegment(liveCamera)

      const touchingStart = placedTexts.some((group) => isRodTouchingMarker(rodLine, group.userData.startMarker, group.scale.x))
      const touchingGoal = placedTexts.some((group) => isRodTouchingMarker(rodLine, group.userData.goalMarker, group.scale.x))
      // Short-circuits before the more expensive sampled text check when a marker is already touched.
      const safe = touchingStart || touchingGoal || isRodTouchingAnyText()

      updateContactStatus(safe)
      updateRunState(safe, touchingStart, touchingGoal)
    },

    // Runs after the camera feed and 3D scene have been drawn for this frame (this module is last
    // in the pipeline), so the AR canvas is complete and can be copied into a recording.
    onRender: () => {
      recorder.captureFrame()
    }
  }

  return {pipelineModule, setSelectedScale, setRodLength, deleteSelected, deselect, resetScene, setCourse}
}
