// Records a run (START -> CLEAR) as a video. The AR canvas only holds the camera feed and the 3D
// scene, so each frame is copied onto a separate 2D canvas first, with the page's HUD (the
// SAFE/OUT badge and timer, which are DOM elements) painted on top by `drawOverlay`; that 2D
// canvas is what gets recorded. The video lives only in memory, as a File the caller holds on to
// until it's dismissed.

// MP4 first (iOS Safari records it; recent Chrome too), WebM as the fallback for older Chrome/Firefox.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]
const MAX_VIDEO_WIDTH = 720 // downscaled from the (device-pixel) AR canvas to keep encoding light
const FRAME_RATE = 30
const VIDEO_BITS_PER_SECOND = 2_500_000

const pickMimeType = () => {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    return null
  }
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || null
}

export const createRunRecorder = ({getSourceCanvas, drawOverlay}) => {
  const mimeType = pickMimeType()
  let session = null

  const stopTracks = (s) => s.stream.getTracks().forEach((track) => track.stop())

  const discard = () => {
    const s = session
    session = null
    if (!s) {
      return
    }
    s.recorder.ondataavailable = null
    s.recorder.onstop = null
    if (s.recorder.state !== 'inactive') {
      s.recorder.stop()
    }
    stopTracks(s)
  }

  // Begins a fresh recording, throwing away any one still in progress.
  const start = () => {
    discard()
    const source = getSourceCanvas()
    if (!mimeType || !source || !source.width || !source.height) {
      return
    }
    const width = Math.min(source.width, MAX_VIDEO_WIDTH)
    const height = Math.round((width * source.height) / source.width)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const stream = canvas.captureStream(FRAME_RATE)
    const recorder = new MediaRecorder(stream, {mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND})
    const chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data)
      }
    }
    session = {recorder, stream, canvas, ctx: canvas.getContext('2d'), chunks, source}
    recorder.start(1000)
  }

  // Call once per rendered frame, after the AR canvas has been drawn for that frame.
  const captureFrame = () => {
    if (!session) {
      return
    }
    const {ctx, canvas, source} = session
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
    // The HUD is laid out in CSS pixels; the video is in its own pixel size.
    drawOverlay(ctx, canvas.width / (window.innerWidth || canvas.width))
  }

  // Stops the recording and resolves with the finished video as a File (null if nothing was
  // recording or the browser can't record).
  const finish = () =>
    new Promise((resolve) => {
      const s = session
      if (!s) {
        resolve(null)
        return
      }
      captureFrame() // make sure the very last frame (the one that cleared) is in the video
      session = null
      s.recorder.onstop = () => {
        stopTracks(s)
        const baseType = mimeType.split(';')[0]
        const extension = baseType === 'video/mp4' ? 'mp4' : 'webm'
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        resolve(s.chunks.length ? new File(s.chunks, `font-ar-${stamp}.${extension}`, {type: baseType}) : null)
      }
      s.recorder.stop()
    })

  return {supported: !!mimeType, start, captureFrame, finish, discard}
}
