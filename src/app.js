// app.js is the main entry point for your three.js 8th Wall app.

import {initScenePipelineModule} from './threejs-scene-init'
import * as THREE from 'three'

window.THREE = THREE

const PLACEMENT_INSTRUCTIONS = '文字を入力して地面をタップすると設置、設置済みの文字をタップすると選択されます'
const SELECTION_INSTRUCTIONS = '選択中の文字をドラッグすると位置を移動できます。スライダーでサイズ・文字間も調整できます'

const instructionsEl = document.getElementById('instructions')
const placementPanel = document.getElementById('placement-panel')
const selectionPanel = document.getElementById('selection-panel')
const selectionSizeInput = document.getElementById('selection-size')
const selectionSpacingInput = document.getElementById('selection-spacing')

const handleSelectionChange = (group) => {
  const selected = !!group
  placementPanel.hidden = selected
  selectionPanel.hidden = !selected
  instructionsEl.textContent = selected ? SELECTION_INSTRUCTIONS : PLACEMENT_INSTRUCTIONS
  if (selected) {
    selectionSizeInput.value = '1'
    selectionSpacingInput.value = '0'
  }
}

const {pipelineModule, setSelectedScale, setSelectedLetterSpacing, deleteSelected, deselect} =
  initScenePipelineModule({onSelectionChange: handleSelectionChange})

selectionSizeInput.addEventListener('input', (event) => {
  setSelectedScale(Number(event.target.value))
})
selectionSpacingInput.addEventListener('input', (event) => {
  setSelectedLetterSpacing(Number(event.target.value))
})
document.getElementById('selection-delete').addEventListener('click', () => {
  deleteSelected()
})
document.getElementById('selection-done').addEventListener('click', () => {
  deselect()
})

const onxrloaded = () => {
  XR8.addCameraPipelineModules([  // Add camera pipeline modules.
    // Existing pipeline modules.
    XR8.GlTextureRenderer.pipelineModule(),      // Draws the camera feed.
    XR8.Threejs.pipelineModule(),                // Creates a ThreeJS AR Scene.
    XR8.XrController.pipelineModule(),           // Enables SLAM tracking.
    LandingPage.pipelineModule(),         // Detects unsupported browsers and gives hints.
    XRExtras.FullWindowCanvas.pipelineModule(),  // Modifies the canvas to fill the window.
    XRExtras.Loading.pipelineModule(),           // Manages the loading screen on startup.
    XRExtras.RuntimeError.pipelineModule(),      // Shows an error image on runtime error.
    // Custom pipeline modules.
    pipelineModule,  // Sets up the threejs camera and scene content.
  ])

  const canvas = document.getElementById('camerafeed')
  // Open the camera and start running the camera run loop.
  XR8.run({canvas})
}

window.XR8 ? onxrloaded() : window.addEventListener('xrloaded', onxrloaded)
