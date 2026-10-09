import {FONTS, DEFAULT_FONT_ID} from './text-plane'

export const MAX_TEXT_LENGTH = 10
export const MAX_NAME_LENGTH = 20
export const SCALE_MIN = 0.5
export const SCALE_MAX = 2
export const SCALE_STEP = 0.25

// A course is just what's needed to rebuild it: the text, the font, and the size. Where it's
// placed in the room isn't part of it (SLAM coordinates don't carry over between sessions), and
// the start/goal positions follow from the text itself, so a course fits in a URL.
//
// Everything here is treated as untrusted input (it can come straight out of a shared link): the
// text is clamped to the allowed length, the font must be one we ship, the size is snapped to a
// step, and the result is only ever put on screen via textContent.
export const normalizeCourse = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const text = Array.from(String(raw.t ?? '').trim()).slice(0, MAX_TEXT_LENGTH).join('')
  if (!text) {
    return null
  }
  const fontId = FONTS.some((f) => f.id === raw.f) ? raw.f : DEFAULT_FONT_ID
  let scale = Number(raw.s)
  if (!Number.isFinite(scale)) {
    scale = 1
  }
  scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(scale / SCALE_STEP) * SCALE_STEP))
  const name = Array.from(String(raw.n ?? '').trim()).slice(0, MAX_NAME_LENGTH).join('') || text
  return {text, fontId, scale, name}
}

// Identity of a course for records: the same text, font, and size is the same course no matter who
// made it or what they called it.
export const courseKey = (course) => `${course.fontId}:${course.scale}:${course.text}`

const toBase64Url = (bytes) => {
  let binary = ''
  bytes.forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value) => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

export const encodeCourse = (course) =>
  toBase64Url(new TextEncoder().encode(JSON.stringify({v: 1, t: course.text, f: course.fontId, s: course.scale, n: course.name})))

export const decodeCourse = (encoded) => {
  try {
    return normalizeCourse(JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))))
  } catch (error) {
    return null
  }
}

export const buildCourseUrl = (course) => {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('c', encodeCourse(course))
  return url.toString()
}

// null when the page wasn't opened from a course link; {invalid: true} when it was but the link is broken.
export const readCourseFromLocation = () => {
  const encoded = new URLSearchParams(window.location.search).get('c')
  if (encoded === null) {
    return null
  }
  return decodeCourse(encoded) || {invalid: true}
}
