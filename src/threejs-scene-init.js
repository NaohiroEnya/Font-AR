// 8th Wall XR Camera Pipeline Module: lets the user tap the ground to fix text in real space.
// XR8.XrController provides real 6DoF SLAM tracking, so text placed here stays anchored to the
// physical location it was tapped on, including depth (distance from the camera) — unlike a
// DeviceOrientation-only approach, which can only react to tilt, not real-world position.
import * as THREE from 'three'

import {createTextMesh} from './text-plane'

const PROBE_RADIUS = 0.03 // meters
const PROBE_LENGTH = 5

// Builds the "operation game" probe: a thin rod fixed to the center of the screen, extending
// forward from the device. It's added as a child of the camera, so its world position/rotation
// is recomputed from the camera's every frame for free -- no manual per-frame syncing needed.
// Because it's still a real object in the SLAM world-space scene, it visually pierces through
// (or is occluded by) text placed in the room, exactly like probing through a real object.
const createProbeRod = () => {
  const geometry = new THREE.CylinderGeometry(PROBE_RADIUS, PROBE_RADIUS, PROBE_LENGTH, 16)
  geometry.rotateX(-Math.PI / 2) // cylinder's axis (Y) now points down the camera's forward axis (-Z)
  const material = new THREE.MeshStandardMaterial({color: 0x2e86f5, roughness: 0.4, metalness: 0.1})
  const rod = new THREE.Mesh(geometry, material)
  rod.position.z = -PROBE_LENGTH / 2
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

  const getInputText = () => document.getElementById('text-input').value.trim() || 'AR'

  const placeTextAt = ({scene, camera}, point) => {
    const group = createTextMesh(getInputText())
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
    camera.add(createProbeRod())

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

  return {
    name: 'textplacement',

    onStart: ({canvas}) => {
      const {scene, camera, renderer} = XR8.Threejs.xrScene()

      initXrScene({scene, camera, renderer})

      canvas.addEventListener('touchmove', (event) => {
        event.preventDefault()
      })

      XR8.XrController.updateCameraProjectionMatrix(
        {origin: camera.position, facing: camera.quaternion}
      )

      canvas.addEventListener('touchstart', (event) => {
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
          placeTextAt({scene, camera}, groundHit.point)
        }
      }, true)
    },
  }
}
