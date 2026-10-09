import {FONTS} from './text-plane'

// Fills a <select> with the available fonts, grouped by gothic/mincho.
export const populateFontSelect = (select) => {
  FONTS.forEach(({id, group, label}, i) => {
    let optgroup = select.querySelector(`optgroup[label="${group}"]`)
    if (!optgroup) {
      optgroup = document.createElement('optgroup')
      optgroup.label = group
      select.appendChild(optgroup)
    }
    const option = document.createElement('option')
    option.value = id
    option.textContent = label
    option.selected = i === 0
    optgroup.appendChild(option)
  })
}

export const fontLabel = (fontId) => (FONTS.find((f) => f.id === fontId) || FONTS[0]).label

// Loads a font into the page (as a CSS web font) so the course editor can show a preview in it.
// Resolves with the font-family name once it's usable.
const previewFaces = new Map()
export const ensurePreviewFont = (fontId) => {
  if (!previewFaces.has(fontId)) {
    const {url} = FONTS.find((f) => f.id === fontId) || FONTS[0]
    const family = `FontAR-${fontId}`
    previewFaces.set(
      fontId,
      new FontFace(family, `url("${url}")`).load().then((face) => {
        document.fonts.add(face)
        return family
      })
    )
  }
  return previewFaces.get(fontId)
}
