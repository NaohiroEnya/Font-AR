// 8th Wall XR Camera Pipeline Module: lets the user tap the ground to fix text in real space,
// select a placed text to drag-reposition or resize it, and play an "operation game" pass at it
// with a probe rod fixed to the device.
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

// True if the segment [near, far] intersects `box` at all (either endpoint already inside, or
// the segment passes through it). Used as the rod/text contact check: as long as any part of the
// rod is still within a placed text's overall bounding box, it counts as touching -- not just
// while it's against actual stroke material -- so passing through the gap between two characters,
// or through a hole inside one (回's center, say), stays safe rather than reading as an instant
// exit. Only crossing all the way out of the box counts as leaving that text.
const segBoxDir = new THREE.Vector3()
const segBoxRay = new THREE.Ray()
const segBoxHit = new THREE.Vector3()
const isSegmentTouchingBox = (near, far, box) => {
  if (box.containsPoint(near) || box.containsPoint(far)) {
    return true
  }
  segBoxDir.subVectors(far, near)
  const length = segBoxDir.length()
  segBoxDir.normalize()
  segBoxRay.set(near, segBoxDir)
  if (!segBoxRay.intersectBox(box, segBoxHit)) {
    return false
  }
  return near.distanceTo(segBoxHit) <= length
}

const MARKER_RADIUS = 0.12
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
// space constant, so without this it stayed fixed at ~19cm regardless of how small the text (and
// its marker) had been resized -- on a text shrunk to e.g. 0.3x, that left a "safe" halo several
// times wider than the marker was actually drawn, matching contact only near the marker's default
// size rather than however big it currently, visibly is.
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
  // Plane used both as the raycast target for tap placement/dragging and as a shadow-catcher:
  // it's invisible except where a placed text object blocks the light, so text reads as sitting
  // on the ground rather than floating.
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

  // Computed from the text mesh alone (group.children[0]), not the whole group: the group can
  // also carry UI-only children -- the selection ring, while a text is selected -- and including
  // those inflated this box hugely (a wide/flat ring's own bounding box extends far past the
  // actual glyph's shallow extruded depth), leaving a giant stale "safe" zone around any text that
  // had ever been selected, even long after deselecting it. Markers are left out too: they sit
  // embedded just inside the mesh's own edge by construction, so this box already covers them,
  // and their own contact is checked separately (isRodTouchingMarker) regardless.
  //
  // Box3.setFromObject(mesh) internally does mesh.updateWorldMatrix(false, false) -- it refreshes
  // the mesh's own matrix but, unlike calling it on the group directly, does NOT walk up to
  // refresh the group's matrixWorld first. Right after changing group.position/quaternion/scale
  // (here, or in setSelectedScale/touchmove) nothing else has necessarily re-run a scene-wide
  // matrix update yet, so that read the group's matrixWorld from before the change -- explicitly
  // forcing the parent chain here first keeps this correct regardless of timing.
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
    addStartGoalMarkers(group)
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
  // camera's position/quaternion only need to be applied once per frame.
  const rodNearLocal = new THREE.Vector3(0, PROBE_Y_OFFSET, -PROBE_NEAR)
  const rodFarLocal = new THREE.Vector3(0, PROBE_Y_OFFSET, -(PROBE_NEAR + PROBE_LENGTH))
  const rodNear = new THREE.Vector3()
  const rodFar = new THREE.Vector3()
  const rodLine = new THREE.Line3(rodNear, rodFar)
  const updateRodSegment = (camera) => {
    rodNear.copy(rodNearLocal).applyQuaternion(camera.quaternion).add(camera.position)
    rodFar.copy(rodFarLocal).applyQuaternion(camera.quaternion).add(camera.position)
  }

  const isRodTouchingAnyText = () =>
    placedTexts.some((group) => {
      const box = textBoxes.get(group)
      return box && isSegmentTouchingBox(rodNear, rodFar, box)
    })

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

  // The game-over overlay darkens the whole screen (camera feed still faintly visible through
  // it) and blocks taps on the placement/selection panels underneath until dismissed. Continuing
  // just returns runState to 'idle' -- it doesn't touch the placed text objects or the text
  // input's value, so the course stays put and whatever was typed is still there to reuse.
  const gameoverOverlayEl = document.getElementById('gameover-overlay')
  const gameoverTimeEl = document.getElementById('gameover-time')
  document.getElementById('gameover-continue').addEventListener('click', () => {
    runState = 'idle'
    gameoverOverlayEl.hidden = true
  })

  const updateRunState = (safe, touchingStart, touchingGoal) => {
    if (touchingStart) {
      runState = 'running'
      runStartedAt = performance.now()
    } else if (touchingGoal && runState === 'running') {
      runState = 'cleared'
      finalElapsedMs = performance.now() - runStartedAt
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
      const touchingGoal = placedTexts.some((group) => isRodTouchingMarker(rodLine, group.userData.goalMarker, group.scale.x))
      // Short-circuits before the more expensive sampled text check when a marker is already touched.
      const safe = touchingStart || touchingGoal || isRodTouchingAnyText()

      updateContactStatus(safe)
      updateRunState(safe, touchingStart, touchingGoal)
    },
  }

  return {pipelineModule, setSelectedScale, deleteSelected, deselect}
}
