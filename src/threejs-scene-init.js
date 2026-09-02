// 8th Wall XR Camera Pipeline Module: lets the user tap the ground to fix text in real space.
// XR8.XrController provides real 6DoF SLAM tracking, so text placed here stays anchored to the
// physical location it was tapped on, including depth (distance from the camera) — unlike a
// DeviceOrientation-only approach, which can only react to tilt, not real-world position.
import * as THREE from 'three'

import {createTextMesh} from './text-plane'

export const initScenePipelineModule = () => {
  // Invisible plane used only as a raycast target to find where the ground was tapped.
  const groundGeometry = new THREE.PlaneGeometry(2000, 2000)
  groundGeometry.rotateX(-Math.PI / 2)
  const ground = new THREE.Mesh(groundGeometry, new THREE.MeshBasicMaterial({visible: false}))

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  const getInputText = () => document.getElementById('text-input').value.trim() || 'AR'

  const placeTextAt = ({scene, camera}, point) => {
    const mesh = createTextMesh(getInputText())
    mesh.position.copy(point)
    mesh.position.y += 0.25 // lift text above the ground plane
    mesh.quaternion.copy(camera.quaternion) // face the viewer at the moment it's placed
    scene.add(mesh)
  }

  const initXrScene = ({scene, camera}) => {
    scene.add(ground)
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
        const [hit] = raycaster.intersectObject(ground)
        if (hit) {
          placeTextAt({scene, camera}, hit.point)
        }
      }, true)
    },
  }
}
