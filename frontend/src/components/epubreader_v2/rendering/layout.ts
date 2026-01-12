import type { EpubReaderV2Settings, EpubReaderV2ThemePreset } from '../types'
import { THEME_PRESETS } from '../types'
import { ensureReaderContainers } from './containers'

export type AppliedLayout = {
  viewportEl: HTMLElement
  contentEl: HTMLElement
  pageWidth: number
  totalPages: number
}

function getZoomScale(doc: Document, fontScale: number): number {
  const win = doc.defaultView
  const supportsZoom =
    typeof win?.CSS?.supports === 'function' && win.CSS.supports('zoom', '1')
  if (!supportsZoom) return 1
  if (!Number.isFinite(fontScale) || fontScale <= 0) return 1
  return fontScale
}

function themeVars(themePreset: EpubReaderV2ThemePreset): {
  bg: string
  fg: string
  link: string
} {
  const preset = THEME_PRESETS[themePreset]
  const isDark = preset.theme === 'dark'
  return {
    bg: preset.bg,
    fg: preset.fg,
    link: isDark ? '#8ab4f8' : '#0b57d0',
  }
}

export function applyReaderLayout(options: {
  doc: Document
  viewportWidth: number
  viewportHeight: number
  settings: EpubReaderV2Settings
  safeArea?: {
    topPx?: number
    bottomPx?: number
  }
}): AppliedLayout {
  const { doc, viewportWidth, viewportHeight, settings } = options
  const rawSafeTopPx = Number(options.safeArea?.topPx ?? 0)
  const rawSafeBottomPx = Number(options.safeArea?.bottomPx ?? 0)
  const safeTopPx = Number.isFinite(rawSafeTopPx)
    ? Math.max(0, rawSafeTopPx)
    : 0
  const safeBottomPx = Number.isFinite(rawSafeBottomPx)
    ? Math.max(0, rawSafeBottomPx)
    : 0
  const zoomScale = getZoomScale(doc, settings.fontScale)

  const root = doc.documentElement
  root.setAttribute('data-mfv2-font-family', settings.fontFamily)
  root.setAttribute('data-mfv2-theme-preset', settings.themePreset)
  root.style.setProperty('--mfv2-vw', `${viewportWidth}px`)
  root.style.setProperty('--mfv2-vh', `${viewportHeight}px`)
  root.style.setProperty('--mfv2-gap', `${settings.columnGapPx}px`)
  root.style.setProperty('--mfv2-font-scale', `${settings.fontScale}`)
  root.style.setProperty('--mfv2-line-height', `${settings.lineHeight}`)
  root.style.setProperty(
    '--mfv2-text-align',
    settings.textAlign === 'auto' ? 'initial' : settings.textAlign,
  )
  // Safe areas are in outer (un-zoomed) pixels. When the browser applies font
  // scaling via `zoom`, convert to the iframe's un-zoomed coordinate space so
  // the effective visible safe area remains stable.
  root.style.setProperty('--mfv2-safe-top', `${safeTopPx / zoomScale}px`)
  root.style.setProperty('--mfv2-safe-bottom', `${safeBottomPx / zoomScale}px`)

  if (settings.fontFamily === 'serif') {
    root.style.setProperty(
      '--mfv2-font-family',
      `Iowan Old Style, Georgia, "Times New Roman", Times, serif`,
    )
  } else if (settings.fontFamily === 'sans') {
    root.style.setProperty(
      '--mfv2-font-family',
      `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif`,
    )
  } else {
    root.style.setProperty('--mfv2-font-family', 'inherit')
  }

  const colors = themeVars(settings.themePreset)
  root.style.setProperty('--mfv2-bg', colors.bg)
  root.style.setProperty('--mfv2-fg', colors.fg)
  root.style.setProperty('--mfv2-link', colors.link)

  const { viewportEl, contentEl, created } = ensureReaderContainers(doc)
  if (created) {
    const body =
      doc.body ?? doc.getElementsByTagName('body')[0] ?? doc.documentElement
    body.style.margin = '0'
    body.style.padding = '0'
    body.style.width = `${viewportWidth}px`
    body.style.height = `${viewportHeight}px`
    body.style.overflow = 'hidden'
  }

  if (settings.flowMode === 'scrolled') {
    viewportEl.style.overflow = 'auto'
    contentEl.style.columnWidth = 'auto'
    contentEl.style.columnGap = '0px'
    contentEl.style.height = 'auto'
    contentEl.style.width = '100%'
  } else {
    const layoutWidth = viewportWidth / zoomScale
    const layoutHeight = viewportHeight / zoomScale
    const layoutGap = settings.columnGapPx / zoomScale
    viewportEl.style.overflow = 'hidden'
    contentEl.style.height = `${layoutHeight}px`
    contentEl.style.columnWidth = `${layoutWidth}px`
    contentEl.style.columnGap = `${layoutGap}px`
    contentEl.style.columnFill = 'auto'
    contentEl.style.width = 'auto'
  }

  viewportEl.style.width = `${viewportWidth}px`
  viewportEl.style.height = `${viewportHeight}px`

  const pageWidth = viewportWidth + settings.columnGapPx
  const totalPages = (() => {
    if (settings.flowMode !== 'paginated') return 1
    // Use the scroll container's width so `zoom`-scaled content is measured in
    // the same coordinate space as `scrollLeft` and `clientWidth`.
    const raw = (viewportEl.scrollWidth + settings.columnGapPx) / pageWidth
    const nearest = Math.max(1, Math.round(raw))
    if (Math.abs(raw - nearest) < 0.02) return nearest
    return Math.max(1, Math.ceil(raw))
  })()

  return { viewportEl, contentEl, pageWidth, totalPages }
}

export function scrollToPage(options: {
  layout: AppliedLayout
  pageIndex: number
  behavior?: ScrollBehavior
}) {
  const { layout, pageIndex, behavior } = options
  const clamped = Math.max(0, Math.min(layout.totalPages - 1, pageIndex))
  const left = clamped * layout.pageWidth
  layout.viewportEl.scrollTo({ left, top: 0, behavior: behavior ?? 'auto' })
}

export function findPageIndexForElement(options: {
  layout: AppliedLayout
  element: Element
}): number {
  const { layout, element } = options
  const rect = element.getBoundingClientRect()
  const viewportRect = layout.viewportEl.getBoundingClientRect()
  const absoluteLeft =
    rect.left - viewportRect.left + layout.viewportEl.scrollLeft
  return Math.max(
    0,
    Math.min(
      layout.totalPages - 1,
      Math.floor(absoluteLeft / layout.pageWidth),
    ),
  )
}
