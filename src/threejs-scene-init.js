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
  const probeRod = createProbeRod()

  const getInputText = () => document.getElementById('text-input').value.trim() || 'AR'

  const placeTextAt = async ({scene, camera}, point) => {
    const group = await createTextMesh(getInputText())
    group.position.copy(point)
    group.quaternion.copy(camera.quaternion) // face the viewer at the moment it's placed
    scene.add(group)
    placedTexts.push(group)
  }

  const removeText = (scene, group) => {
    scene.remove(group)
    placedTexts.splice(placedTexts.indexOf(group), 1)
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
    },
  }
}
