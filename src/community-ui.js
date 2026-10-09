import {
  MAX_TEXT_LENGTH, MAX_NAME_LENGTH, SCALE_MIN, SCALE_MAX, SCALE_STEP,
  normalizeCourse, buildCourseUrl,
} from './course'
import {listCreated, addCreated, removeCreated, listPlayed, removePlayed, getBest} from './course-store'
import {populateFontSelect, ensurePreviewFont, fontLabel} from './font-select'

const $ = (id) => document.getElementById(id)

const formatSeconds = (ms) => `${(ms / 1000).toFixed(1)}s`

let toastTimer = null
export const showToast = (message) => {
  const el = $('toast')
  el.textContent = message
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 2600)
}

// Opens the share sheet where the browser has one, otherwise copies the link.
export const shareCourse = async (course) => {
  const url = buildCourseUrl(course)
  const data = {title: 'Font AR', text: `「${course.name}」に挑戦しよう！`, url}
  if (navigator.share) {
    try {
      await navigator.share(data)
      return
    } catch (error) {
      if (error.name === 'AbortError') {
        return
      }
    }
  }
  try {
    await navigator.clipboard.writeText(url)
    showToast('コースのURLをコピーしました')
  } catch (error) {
    window.prompt('このURLを共有してください', url)
  }
}

// The community hub (course lists) and the course editor. Playing a course is up to the caller:
// `onPlay(course)` is called when one is chosen, `onBack()` to return to the mode menu.
export const createCommunityUi = ({onPlay, onBack}) => {
  const hubScreen = $('hub-screen')
  const createScreen = $('create-screen')
  const tabs = {created: $('tab-created'), played: $('tab-played')}
  const list = $('course-list')
  const empty = $('course-empty')
  let activeTab = 'created'

  const button = (label, className, onClick) => {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `mini-button ${className}`
    el.textContent = label
    el.addEventListener('click', onClick)
    return el
  }

  const renderList = () => {
    const isCreated = activeTab === 'created'
    const courses = isCreated ? listCreated() : listPlayed()
    $('hub-new').hidden = !isCreated
    Object.entries(tabs).forEach(([name, el]) => {
      el.classList.toggle('active', name === activeTab)
      el.setAttribute('aria-selected', String(name === activeTab))
    })
    list.replaceChildren()
    empty.hidden = courses.length > 0
    empty.textContent = isCreated
      ? 'まだコースがありません。「新規作成」から作ってみましょう。'
      : 'まだプレイしたコースがありません。共有されたURLを開くと、ここにたまります。'

    courses.forEach((course) => {
      const item = document.createElement('li')
      item.className = 'course-item'

      const main = document.createElement('div')
      main.className = 'course-main'
      const title = document.createElement('div')
      title.className = 'course-title'
      title.textContent = course.name
      const meta = document.createElement('div')
      meta.className = 'course-meta'
      const best = getBest(course)
      meta.textContent = [
        `「${course.text}」`,
        fontLabel(course.fontId),
        `×${course.scale}`,
        best ? `自己ベスト ${formatSeconds(best)}` : '未クリア',
      ].join(' ・ ')
      main.append(title, meta)

      const actions = document.createElement('div')
      actions.className = 'course-actions'
      actions.append(button('プレイ', 'primary', () => onPlay(course, activeTab)))
      if (isCreated) {
        actions.append(button('共有', '', () => shareCourse(course)))
      }
      actions.append(button('削除', 'danger', () => {
        if (!window.confirm(`「${course.name}」を${isCreated ? '削除' : '履歴から削除'}しますか？`)) {
          return
        }
        if (isCreated) {
          removeCreated(course.id)
        } else {
          removePlayed(course)
        }
        renderList()
      }))

      item.append(main, actions)
      list.append(item)
    })
  }

  const showHub = (tab = activeTab) => {
    activeTab = tab
    createScreen.hidden = true
    hubScreen.hidden = false
    renderList()
  }

  const hide = () => {
    hubScreen.hidden = true
    createScreen.hidden = true
  }

  Object.entries(tabs).forEach(([name, el]) => el.addEventListener('click', () => {
    activeTab = name
    renderList()
  }))
  $('hub-back').addEventListener('click', onBack)

  // ---- course editor
  const nameInput = $('create-name')
  const textInput = $('create-text')
  const fontSelect = $('create-font')
  const scaleInput = $('create-scale')
  const scaleValue = $('create-scale-value')
  const preview = $('create-preview')
  nameInput.maxLength = MAX_NAME_LENGTH
  textInput.maxLength = MAX_TEXT_LENGTH
  scaleInput.min = SCALE_MIN
  scaleInput.max = SCALE_MAX
  scaleInput.step = SCALE_STEP
  populateFontSelect(fontSelect)

  const updatePreview = () => {
    scaleValue.textContent = `×${scaleInput.value}`
    preview.textContent = textInput.value.trim() || '文字'
    const fontId = fontSelect.value
    ensurePreviewFont(fontId).then((family) => {
      if (fontSelect.value === fontId) {
        preview.style.fontFamily = `"${family}", sans-serif`
      }
    })
  }
  ;[textInput, fontSelect, scaleInput].forEach((el) => el.addEventListener('input', updatePreview))

  const showCreate = () => {
    nameInput.value = ''
    textInput.value = ''
    fontSelect.selectedIndex = 0
    scaleInput.value = '1'
    hubScreen.hidden = true
    createScreen.hidden = false
    updatePreview()
    textInput.focus()
  }

  $('hub-new').addEventListener('click', showCreate)
  $('create-cancel').addEventListener('click', () => showHub('created'))
  $('create-save').addEventListener('click', () => {
    const course = normalizeCourse({t: textInput.value, f: fontSelect.value, s: scaleInput.value, n: nameInput.value})
    if (!course) {
      showToast('文字を入力してください')
      return
    }
    addCreated(course)
    showHub('created')
    showToast('コースを保存しました。「共有」でURLを送れます')
  })

  return {showHub, hide}
}
