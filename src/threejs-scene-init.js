// 8th Wall XR Camera Pipeline Module: lets the user tap the ground to fix text in real space,
// select a placed text to drag-reposition, resize, or delete it, and play an "operation game"
// pass at it with a probe rod fixed to the device.
// XR8.XrController provides real 6DoF SLAM tracking, so text placed here stays anchored to the
// physical location it was tapped on, including depth (distance from the camera) — unlike a
// DeviceOrientation-only approach, which can only react to tilt, not real-world position.
import * as THREE from 'three'

import {createTextMesh, loadFont} from './text-plane'

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
const createProbeRod = () => {
  const geometry = new THREE.CylinderGeometry(PROBE_RADIUS, PROBE_RADIUS, PROBE_LENGTH, 20)
  geometry.rotateX(-Math.PI / 2) // cylinder's axis (Y) now points down the camera's forward axis (-Z)
  geometry.translate(0, PROBE_Y_OFFSET, -(PROBE_NEAR + PROBE_LENGTH / 2))
  const material = new THREE.MeshBasicMaterial({color: 0x2979ff})
  const rod = new THREE.Mesh(geometry, material)
  rod.castShadow = true
  return rod
}

// Casts a ray from `point` and counts how many times it crosses `mesh`. An odd count means the
// point is inside the mesh's solid volume -- true for a ray in any fixed direction through a
// closed (watertight) manifold, which is what THREE.ExtrudeGeometry produces, so this works
// regardless of how the text has been rotated to face the camera. The direction is tilted
// slightly off any axis (rather than a plain "straight up") so it doesn't graze exactly along a
// triangle edge or through a shared vertex -- which, for symmetric glyphs like 回, a purely
// vertical ray through the horizontal center reliably does, double-counting that crossing.
const CAST_DIR = new THREE.Vector3(0.0173, 1, 0.0111).normalize()
const pointRaycaster = new THREE.Raycaster()
const isPointInsideMesh = (point, mesh) => {
  pointRaycaster.set(point, CAST_DIR)
  return pointRaycaster.intersectObject(mesh, false).length % 2 === 1
}

const MARKER_RADIUS = 0.16
const MARKER_TOUCH_DISTANCE = MARKER_RADIUS + PROBE_RADIUS
const CHECKPOINT_COLOR = 0xf5c400

// depthTest: false (plus a high renderOrder) makes the marker always draw on top of whatever
// else is there, including the text mesh itself -- markers sit embedded just inside the text's
// edge for gameplay reasons, and without this they read as half-buried in (or fully hidden by)
// the glyph they're next to, rather than as a clearly visible landmark.
const createMarker = (color) => {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(MARKER_RADIUS, 16, 16),
    new THREE.MeshStandardMaterial({color, emissive: color, emissiveIntensity: 0.8, depthTest: false})
  )
  mesh.castShadow = true
  mesh.renderOrder = 2
  return mesh
}

const LABEL_WORLD_HEIGHT = 0.5 // meters -- a small caption, not competing with the main text
const LABEL_GAP = 0.15 // meters between the top of the main text and the bottom of its label

// A small "START"/"GOAL" caption, built with the same glyph-extrusion pipeline as the main
// placed text, positioned just above it and horizontally centered over the given marker.
const createLabel = async (text, color, x, topY) => {
  const label = await createTextMesh(text, {worldHeight: LABEL_WORLD_HEIGHT, color})
  label.position.set(x, topY + LABEL_GAP, 0)
  return label
}

// Adds start (green) / checkpoint (yellow) / goal (red) markers, plus "START"/"GOAL" labels, as
// children of `group`, at the local points text-plane.js already worked out. As children they
// automatically follow the group's placement, facing, and scale -- no extra transform math
// needed here, and they're removed along with the text for free when the group is deleted.
// References are kept on userData so the run-timer logic can find them later without
// re-traversing children.
const addCourseMarkers = async (group) => {
  const {startLocal, goalLocal, checkpointLocal} = group.userData
  if (!startLocal || !goalLocal) {
    return // e.g. blank input, which produced an empty group
  }
  const start = createMarker(0x2fa36b)
  start.position.copy(startLocal)
  group.add(start)
  group.userData.startMarker = start

  const checkpoint = createMarker(CHECKPOINT_COLOR)
  checkpoint.position.copy(checkpointLocal)
  group.add(checkpoint)
  group.userData.checkpointMarker = checkpoint

  const goal = createMarker(0xe0663d)
  goal.position.copy(goalLocal)
  group.add(goal)
  group.userData.goalMarker = goal

  const topY = group.children[0].geometry.boundingBox.max.y
  const [startLabel, goalLabel] = await Promise.all([
    createLabel('START', 0x2fa36b, startLocal.x, topY),
    createLabel('GOAL', 0xe0663d, goalLocal.x, topY),
  ])
  group.add(startLabel)
  group.add(goalLabel)
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

export const initScenePipelineModule = ({onSelectionChange} = {}) => {
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
  const probeRod = createProbeRod()

  let selectedGroup = null
  let dragTouchId = null // touch identifier currently dragging selectedGroup, or null
  let liveScene = null

  const getInputText = () => document.getElementById('text-input').value.trim() || 'AR'

  // A cheap AABB pre-filter for isRodTouchingAnyText below, not the actual contact boundary --
  // that's still the mesh's exact solid volume (isPointInsideMesh). Computed from the text mesh
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
  }

  const placeTextAt = async ({scene, camera}, point) => {
    const group = await createTextMesh(getInputText())
    group.position.copy(point)
    group.quaternion.copy(camera.quaternion) // face the viewer at the moment it's placed
    await addCourseMarkers(group)
    scene.add(group)
    placedTexts.push(group)
    refreshBox(group)
  }

  const removeText = (scene, group) => {
    scene.remove(group)
    placedTexts.splice(placedTexts.indexOf(group), 1)
    textBoxes.delete(group)
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
    if (!selectedGroup) {
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
  const rodFarLocal = new THREE.Vector3(0, PROBE_Y_OFFSET, -(PROBE_NEAR + PROBE_LENGTH))
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
  const sampleCount = Math.ceil(PROBE_LENGTH / CONTACT_SAMPLE_STEP)
  const isRodTouchingAnyText = () => {
    const point = new THREE.Vector3()
    const testPoint = new THREE.Vector3()

    for (let i = 0; i <= sampleCount; i += 1) {
      point.lerpVectors(rodNear, rodFar, i / sampleCount)
      for (const group of placedTexts) {
        const mesh = group.children[0]
        const box = textBoxes.get(group)
        if (!mesh || !box) continue // empty group (e.g. blank input), or not yet placed

        if (box.containsPoint(point) && isPointInsideMesh(point, mesh)) {
          return true
        }
        for (const angle of radialAngles) {
          testPoint.copy(point)
            .addScaledVector(rodAxisX, Math.cos(angle) * PROBE_RADIUS)
            .addScaledVector(rodAxisY, Math.sin(angle) * PROBE_RADIUS)
          if (box.containsPoint(testPoint) && isPointInsideMesh(testPoint, mesh)) {
            return true
          }
        }
      }
    }
    return false
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

  // Run state: touching any start marker (re)starts the clock and resets the checkpoint; touching
  // the checkpoint while running just remembers that this run has passed it; touching any goal
  // marker while running only clears (and stops the clock) if the checkpoint has been passed this
  // run -- reaching goal without it is a no-op, the run just keeps going. Losing safe contact
  // while running ends the run as a game over instead. Goal/checkpoint touches are ignored before
  // a run has started, and from 'cleared'/'gameover' only touching start again begins a fresh run.
  // With multiple texts placed at once, any start/checkpoint/goal/text works interchangeably for
  // now -- there's no per-text course tracking yet.
  let runState = 'idle' // 'idle' | 'running' | 'cleared' | 'gameover'
  let runStartedAt = 0
  let finalElapsedMs = 0
  let checkpointPassed = false
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

  const clearOverlayEl = document.getElementById('clear-overlay')
  const clearTimeEl = document.getElementById('clear-time')
  document.getElementById('clear-retry').addEventListener('click', () => {
    runState = 'idle'
    clearOverlayEl.hidden = true
  })

  const updateRunState = (safe, touchingStart, touchingCheckpoint, touchingGoal) => {
    if (touchingStart) {
      runState = 'running'
      runStartedAt = performance.now()
      checkpointPassed = false
    } else if (touchingCheckpoint && runState === 'running') {
      checkpointPassed = true
    } else if (touchingGoal && runState === 'running' && checkpointPassed) {
      runState = 'cleared'
      finalElapsedMs = performance.now() - runStartedAt
      clearTimeEl.textContent = formatSeconds(finalElapsedMs)
      clearOverlayEl.hidden = false
    } else if (runState === 'running' && !safe) {
      runState = 'gameover'
      finalElapsedMs = performance.now() - runStartedAt
      gameoverTimeEl.textContent = formatSeconds(finalElapsedMs)
      gameoverOverlayEl.hidden = false
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
  }

  const pipelineModule = {
    name: 'textplacement',

    onStart: ({canvas}) => {
      const {scene, camera, renderer} = XR8.Threejs.xrScene()
      liveCamera = camera
      liveScene = scene
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
          // Walk up from whatever was actually hit to the top-level placedTexts entry it belongs
          // to -- most hits are one level down (the main mesh, a marker), but the START/GOAL
          // labels are a text-mesh group of their own nested inside this one, two levels down.
          let hitGroup = textHit.object
          while (hitGroup && !placedTexts.includes(hitGroup)) {
            hitGroup = hitGroup.parent
          }
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

        const [groundHit] = raycaster.intersectObject(ground)
        if (groundHit) {
          await placeTextAt({scene, camera}, groundHit.point)
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
      const touchingCheckpoint = placedTexts.some((group) => isRodTouchingMarker(rodLine, group.userData.checkpointMarker, group.scale.x))
      const touchingGoal = placedTexts.some((group) => isRodTouchingMarker(rodLine, group.userData.goalMarker, group.scale.x))
      // Short-circuits before the more expensive sampled text check when a marker is already touched.
      const safe = touchingStart || touchingCheckpoint || touchingGoal || isRodTouchingAnyText()

      updateContactStatus(safe)
      updateRunState(safe, touchingStart, touchingCheckpoint, touchingGoal)
    },
  }

  return {pipelineModule, setSelectedScale, deleteSelected, deselect}
}
