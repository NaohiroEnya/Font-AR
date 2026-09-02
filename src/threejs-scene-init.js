// 8th Wall XR Camera Pipeline Module: lets the user tap the ground to fix text in real space.
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
const CONTACT_SAMPLE_STEP = 0.15 // meters between points sampled along the rod each frame when
                                  // checking for contact -- roughly the rod's own diameter, so a
                                  // touch shouldn't be able to slip between two sample points

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
// automatically follow the group's placement and facing -- no extra transform math needed here,
// and they're removed along with the text for free when the group is deleted. References are
// kept on userData so the run-timer logic can find them later without re-traversing children.
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
const markerWorldPos = new THREE.Vector3()
const closestOnRod = new THREE.Vector3()
const isRodTouchingMarker = (rodLine, marker) => {
  if (!marker) {
    return false
  }
  marker.getWorldPosition(markerWorldPos)
  rodLine.closestPointToPoint(markerWorldPos, true, closestOnRod)
  return closestOnRod.distanceTo(markerWorldPos) <= MARKER_TOUCH_DISTANCE
}

export const initScenePipelineModule = () => {
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
  const placedTexts = [] // groups currently placed in the scene, for tap-to-delete
  const textBoxes = new Map() // group -> world-space Box3, cached once since placed text doesn't move
  const probeRod = createProbeRod()

  const getInputText = () => document.getElementById('text-input').value.trim() || 'AR'

  const placeTextAt = async ({scene, camera}, point) => {
    const group = await createTextMesh(getInputText())
    group.position.copy(point)
    group.quaternion.copy(camera.quaternion) // face the viewer at the moment it's placed
    addStartGoalMarkers(group)
    scene.add(group)
    placedTexts.push(group)
    textBoxes.set(group, new THREE.Box3().setFromObject(group))
  }

  const removeText = (scene, group) => {
    scene.remove(group)
    placedTexts.splice(placedTexts.indexOf(group), 1)
    textBoxes.delete(group)
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

  // Samples points along the rod segment and checks each one (cheaply, via its cached bounding
  // box first) against every placed text's actual solid volume.
  const sampleCount = Math.ceil(PROBE_LENGTH / CONTACT_SAMPLE_STEP)
  const isRodTouchingAnyText = () => {
    const point = new THREE.Vector3()

    for (let i = 0; i <= sampleCount; i += 1) {
      point.lerpVectors(rodNear, rodFar, i / sampleCount)
      for (const group of placedTexts) {
        const mesh = group.children[0]
        if (!mesh) continue // empty group, e.g. blank input
        if (textBoxes.get(group).containsPoint(point) && isPointInsideMesh(point, mesh)) {
          return true
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

  const updateContactStatus = () => {
    const touching = isRodTouchingAnyText()
    if (touching === lastTouching) {
      return
    }
    lastTouching = touching
    statusEl.textContent = touching ? 'SAFE' : 'OUT'
    statusEl.classList.toggle('safe', touching)
    statusEl.classList.toggle('out', !touching)
  }

  // Run state: touching any start marker (re)starts the clock; touching any goal marker while
  // running stops it and freezes the elapsed time. Goal touches are ignored before a run has
  // started. With multiple texts placed at once, any start/goal works interchangeably for now --
  // there's no per-text course tracking yet.
  let runState = 'idle' // 'idle' | 'running' | 'cleared'
  let runStartedAt = 0
  let clearedElapsedMs = 0
  const timerEl = document.getElementById('timer-status')

  const formatSeconds = (ms) => (ms / 1000).toFixed(1) + 's'
  let lastTimerText = null

  const setTimerText = (text, cleared) => {
    if (text === lastTimerText) {
      return // avoid rewriting the DOM every frame while the displayed value hasn't changed
    }
    lastTimerText = text
    timerEl.textContent = text
    timerEl.classList.toggle('cleared', cleared)
  }

  const updateRunState = () => {
    const touchingStart = placedTexts.some((group) => isRodTouchingMarker(rodLine, group.userData.startMarker))
    const touchingGoal = placedTexts.some((group) => isRodTouchingMarker(rodLine, group.userData.goalMarker))

    if (touchingStart) {
      runState = 'running'
      runStartedAt = performance.now()
    } else if (touchingGoal && runState === 'running') {
      runState = 'cleared'
      clearedElapsedMs = performance.now() - runStartedAt
    }

    if (runState === 'idle') {
      setTimerText('スタートに触れて計測開始', false)
    } else if (runState === 'running') {
      setTimerText(formatSeconds(performance.now() - runStartedAt), false)
    } else {
      setTimerText(`CLEAR! ${formatSeconds(clearedElapsedMs)}`, true)
    }
  }

  return {
    name: 'textplacement',

    onStart: ({canvas}) => {
      const {scene, camera, renderer} = XR8.Threejs.xrScene()
      liveCamera = camera
      loadFont() // kick off the font fetch/parse now, so it's likely ready by the first tap

      initXrScene({scene, camera, renderer})

      canvas.addEventListener('touchmove', (event) => {
        event.preventDefault()
      })

      XR8.XrController.updateCameraProjectionMatrix(
        {origin: camera.position, facing: camera.quaternion}
      )

      canvas.addEventListener('touchstart', async (event) => {
        if (event.touches.length !== 1) {
          return
        }

        const touch = event.touches[0]
        pointer.x = (touch.clientX / window.innerWidth) * 2 - 1
        pointer.y = -(touch.clientY / window.innerHeight) * 2 + 1
        raycaster.setFromCamera(pointer, camera)

        // Tapping an already-placed text deletes it; otherwise tapping the ground places a new one.
        const [textHit] = raycaster.intersectObjects(placedTexts, true)
        if (textHit) {
          removeText(scene, textHit.object.parent)
          return
        }

        const [groundHit] = raycaster.intersectObject(ground)
        if (groundHit) {
          await placeTextAt({scene, camera}, groundHit.point)
        }
      }, true)
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
      updateContactStatus()
      updateRunState()
    },
  }
}
