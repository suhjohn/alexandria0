// EPUB Rendering Engine
// Handles sandboxed iframe rendering, pagination, and scroll modes

import type {
  SpineItem,
  ReaderSettings,
  ReaderTheme,
  PaginationInfo,
  ViewportSize,
  Location,
} from '../types'
import { EpubResourceResolver } from '../core/resources'
import { CfiGenerator, CfiResolver } from '../cfi'

const MARGIN_SIZES = {
  small: 16,
  medium: 32,
  large: 64,
}

const FONT_FAMILIES = {
  publisher: 'inherit',
  serif: 'Georgia, "Times New Roman", serif',
  'sans-serif': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  monospace: 'Consolas, Monaco, "Courier New", monospace',
}

export interface RendererOptions {
  container: HTMLElement
  resourceResolver: EpubResourceResolver
  spineItems: SpineItem[]
  settings: ReaderSettings
  onLocationChange?: (location: Location) => void
  onLinkClick?: (href: string, isInternal: boolean) => void
  onSelectionChange?: (selection: Selection | null, cfi: string | null) => void
}

export class EpubRenderer {
  private container: HTMLElement
  private resourceResolver: EpubResourceResolver
  private spineItems: SpineItem[]
  private settings: ReaderSettings

  private currentSpineIndex: number = 0
  private iframe: HTMLIFrameElement | null = null
  private iframeContainer: HTMLElement | null = null
  private pagination: PaginationInfo | null = null
  private scrollElement: HTMLElement | null = null
  private containerResizeObserver: ResizeObserver | null = null
  private contentResizeObserver: ResizeObserver | null = null
  private pendingLocationUpdate: number | null = null
  private pendingPaginationUpdate: number | null = null
  private pendingPaginationPreserveLocation: boolean = false
  private pendingPaginationReapplySettings: boolean = false

  private cfiGenerator: CfiGenerator
  private cfiResolver: CfiResolver

  private onLocationChange?: (location: Location) => void
  private onLinkClick?: (href: string, isInternal: boolean) => void
  private onSelectionChange?: (selection: Selection | null, cfi: string | null) => void

  private isRendering: boolean = false
  private pendingNavigation: { spineIndex: number; elementId?: string; cfi?: string } | null = null

  constructor(options: RendererOptions) {
    this.container = options.container
    this.resourceResolver = options.resourceResolver
    this.spineItems = options.spineItems
    this.settings = options.settings
    this.onLocationChange = options.onLocationChange
    this.onLinkClick = options.onLinkClick
    this.onSelectionChange = options.onSelectionChange

    this.cfiGenerator = new CfiGenerator(this.spineItems)
    this.cfiResolver = new CfiResolver(this.spineItems)

    this.setupContainer()
  }

  private setupContainer(): void {
    // Don't clear container - React manages it
    // Just create our iframe container if it doesn't exist
    if (this.iframeContainer && this.iframeContainer.parentNode === this.container) {
      return
    }

    // Create iframe container
    this.iframeContainer = document.createElement('div')
    this.iframeContainer.className = 'epub-renderer-container'
    this.iframeContainer.style.cssText = `
      position: absolute;
      inset: 0;
      overflow: hidden;
    `

    this.container.appendChild(this.iframeContainer)
  }

  async display(spineIndex: number = 0, cfi?: string): Promise<void> {
    if (this.isRendering) {
      this.pendingNavigation = { spineIndex, cfi }
      return
    }

    this.isRendering = true

    try {
      const spineItem = this.spineItems[spineIndex]
      if (!spineItem) {
        throw new Error(`Invalid spine index: ${spineIndex}`)
      }

      this.currentSpineIndex = spineIndex

      // Create or reuse iframe
      await this.createIframe(spineItem)

      // Wait for content to load and apply settings
      await this.waitForIframeLoad()
      this.attachDocumentListeners()
      await this.applySettings()

      // Calculate pagination if in paginated mode
      if (this.settings.mode === 'paginated') {
        await this.updatePagination()
      } else {
        this.pagination = null
      }

      // Navigate to CFI if provided
      if (cfi) {
        await this.goToCfi(cfi)
      }

      // Update location
      this.updateLocation()

      // Check for pending navigation
      if (this.pendingNavigation) {
        const pending = this.pendingNavigation
        this.pendingNavigation = null
        this.isRendering = false
        await this.display(pending.spineIndex, pending.cfi)
        return
      }
    } finally {
      this.isRendering = false
    }
  }

  private async createIframe(spineItem: SpineItem): Promise<void> {
    // Remove old iframe
    if (this.iframe) {
      this.teardownDocument()
      this.iframe.remove()
    }

    // Create new iframe
    this.iframe = document.createElement('iframe')
    this.iframe.className = 'epub-content-frame'

    // Sandbox attributes - NO scripts allowed
    this.iframe.setAttribute(
      'sandbox',
      'allow-same-origin'
    )

    this.iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    `

    // Get content document
    const { blobUrl } = await this.resourceResolver.createContentDocument(spineItem.href, true)
    this.iframe.src = blobUrl

    // Add to container
    this.iframeContainer?.appendChild(this.iframe)

    // Document listeners are attached after load in display()
  }

  private handleLinkClick(href: string): void {
    // Check if it's an internal link
    if (href.startsWith('#')) {
      // Fragment-only link within current document
      this.goToFragment(href.slice(1))
      this.onLinkClick?.(href, true)
      return
    }

    // Check if it's a link to another spine item
    const spineIndex = this.spineItems.findIndex((item) => {
      const itemHref = item.href.split('#')[0]
      const linkHref = href.split('#')[0]
      return itemHref === linkHref || itemHref.endsWith(linkHref)
    })

    if (spineIndex !== -1) {
      const fragment = href.split('#')[1]
      this.display(spineIndex).then(() => {
        if (fragment) {
          this.goToFragment(fragment)
        }
      })
      this.onLinkClick?.(href, true)
      return
    }

    // External link
    this.onLinkClick?.(href, false)
  }

  private async waitForIframeLoad(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.iframe) {
        resolve()
        return
      }

      if (this.iframe.contentDocument?.readyState === 'complete') {
        resolve()
        return
      }

      this.iframe.addEventListener('load', () => resolve(), { once: true })
    })
  }

  private getScrollElement(doc: Document): HTMLElement {
    const scrollingElement = doc.scrollingElement as HTMLElement | null
    if (scrollingElement) return scrollingElement
    if (doc.documentElement) return doc.documentElement
    return doc.body
  }

  private teardownDocument(): void {
    if (this.scrollElement) {
      this.scrollElement.removeEventListener('scroll', this.handleScroll)
      this.scrollElement = null
    }

    if (this.containerResizeObserver) {
      this.containerResizeObserver.disconnect()
      this.containerResizeObserver = null
    }

    if (this.contentResizeObserver) {
      this.contentResizeObserver.disconnect()
      this.contentResizeObserver = null
    }

    if (this.pendingLocationUpdate !== null) {
      window.cancelAnimationFrame(this.pendingLocationUpdate)
      this.pendingLocationUpdate = null
    }

    if (this.pendingPaginationUpdate !== null) {
      window.cancelAnimationFrame(this.pendingPaginationUpdate)
      this.pendingPaginationUpdate = null
      this.pendingPaginationPreserveLocation = false
      this.pendingPaginationReapplySettings = false
    }
  }

  private attachDocumentListeners(): void {
    const doc = this.iframe?.contentDocument
    if (!doc) return

    // Handle link clicks
    doc.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      const anchor = target.closest('a')

      if (anchor) {
        const href = anchor.getAttribute('href')
        if (href) {
          e.preventDefault()
          this.handleLinkClick(href)
        }
      }
    })

    // Handle selection changes
    doc.addEventListener('selectionchange', () => {
      const selection = doc.getSelection()
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const cfi = this.cfiGenerator.generateFromSelection(selection, this.currentSpineIndex)
        this.onSelectionChange?.(selection, cfi)
      } else {
        this.onSelectionChange?.(null, null)
      }
    })

    // Handle keyboard navigation within iframe
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        this.prev()
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        this.next()
      }
    })

    // Scroll handling
    this.scrollElement = this.getScrollElement(doc)
    this.scrollElement.addEventListener('scroll', this.handleScroll, { passive: true })

    // Observe viewport + content size changes to keep pagination accurate
    if (typeof ResizeObserver !== 'undefined') {
      if (this.iframeContainer) {
        this.containerResizeObserver = new ResizeObserver(() => {
          this.schedulePaginationUpdate(true, true)
        })
        this.containerResizeObserver.observe(this.iframeContainer)
      }

      if (doc.body) {
        this.contentResizeObserver = new ResizeObserver(() => {
          this.schedulePaginationUpdate(true)
        })
        this.contentResizeObserver.observe(doc.body)
      }
    }
  }

  private handleScroll = (): void => {
    if (this.settings.mode === 'paginated' && this.pagination) {
      this.syncCurrentPageFromScroll()
    }
    this.scheduleLocationUpdate()
  }

  private scheduleLocationUpdate(): void {
    if (this.pendingLocationUpdate !== null) return
    this.pendingLocationUpdate = window.requestAnimationFrame(() => {
      this.pendingLocationUpdate = null
      this.updateLocation()
    })
  }

  private schedulePaginationUpdate(preserveLocation: boolean, reapplySettings: boolean = false): void {
    if (this.settings.mode !== 'paginated') {
      this.scheduleLocationUpdate()
      return
    }

    this.pendingPaginationPreserveLocation =
      this.pendingPaginationPreserveLocation || preserveLocation
    this.pendingPaginationReapplySettings =
      this.pendingPaginationReapplySettings || reapplySettings

    if (this.pendingPaginationUpdate !== null) return
    this.pendingPaginationUpdate = window.requestAnimationFrame(() => {
      const preserve = this.pendingPaginationPreserveLocation
      const shouldReapplySettings = this.pendingPaginationReapplySettings
      this.pendingPaginationUpdate = null
      this.pendingPaginationPreserveLocation = false
      this.pendingPaginationReapplySettings = false
      if (shouldReapplySettings) {
        const preservedCfi = preserve ? this.getCurrentCfi() : null
        void this.applySettingsAndSync(preservedCfi)
        return
      }
      const preservedCfi = preserve ? this.getCurrentCfi() : null
      void this.updatePagination(preservedCfi)
    })
  }

  private syncCurrentPageFromScroll(): void {
    if (!this.pagination) return
    const doc = this.iframe?.contentDocument
    if (!doc) return
    if (!this.scrollElement) {
      this.scrollElement = this.getScrollElement(doc)
    }
    if (!this.scrollElement) return

    const pageSize = this.pagination.columnWidth + this.pagination.columnGap
    if (pageSize <= 0) return

    const scrollLeft = this.scrollElement.scrollLeft
    const page = Math.round(scrollLeft / pageSize)
    this.pagination.currentPage = Math.min(
      Math.max(0, page),
      this.pagination.totalPages - 1
    )
    this.pagination.scrollLeft = scrollLeft
  }

  private async applySettings(): Promise<void> {
    const doc = this.iframe?.contentDocument
    if (!doc) return

    const theme = this.getTheme()
    const margin = MARGIN_SIZES[this.settings.marginSize]
    const fontFamily = FONT_FAMILIES[this.settings.fontFamily]

    // Create style element for overrides
    let styleEl = doc.getElementById('epub-reader-styles')
    if (!styleEl) {
      styleEl = doc.createElement('style')
      styleEl.id = 'epub-reader-styles'
      doc.head?.appendChild(styleEl)
    }

    const isPaginated = this.settings.mode === 'paginated'
    const viewport = this.getViewport()
    const contentWidth = Math.max(1, viewport.width - margin * 2)
    const contentHeight = Math.max(1, viewport.height - margin * 2)

    styleEl.textContent = `
      :root {
        --epub-bg: ${theme.backgroundColor};
        --epub-text: ${theme.textColor};
        --epub-link: ${theme.linkColor};
        --epub-selection: ${theme.selectionColor};
      }

      html, body {
        background: var(--epub-bg) !important;
        color: var(--epub-text) !important;
        margin: 0 !important;
        padding: 0 !important;
        ${isPaginated ? `
          width: ${contentWidth}px !important;
          height: ${contentHeight}px !important;
          column-width: ${contentWidth}px !important;
          column-gap: ${margin * 2}px !important;
          column-fill: auto !important;
          overflow: hidden !important;
          padding: ${margin}px !important;
        ` : `
          max-width: 800px !important;
          margin: 0 auto !important;
          padding: ${margin}px !important;
          overflow-y: auto !important;
          overflow-x: hidden !important;
        `}
      }

      body {
        ${this.settings.fontFamily !== 'publisher' ? `font-family: ${fontFamily} !important;` : ''}
        font-size: ${this.settings.fontSize}rem !important;
        line-height: ${this.settings.lineHeight} !important;
        text-align: ${this.settings.textAlign} !important;
      }

      p {
        margin-bottom: ${this.settings.paragraphSpacing}em !important;
      }

      a {
        color: var(--epub-link) !important;
      }

      ::selection {
        background: var(--epub-selection) !important;
      }

      img, svg, video {
        max-width: 100% !important;
        height: auto !important;
      }

      /* Ensure images don't break columns */
      ${isPaginated ? `
        img, svg, video, figure {
          break-inside: avoid !important;
          page-break-inside: avoid !important;
        }
      ` : ''}
    `
  }

  private getTheme(): ReaderTheme {
    const themes: Record<string, ReaderTheme> = {
      light: {
        name: 'light',
        backgroundColor: '#ffffff',
        textColor: '#1a1a1a',
        linkColor: '#0066cc',
        selectionColor: 'rgba(0, 102, 204, 0.3)',
      },
      sepia: {
        name: 'sepia',
        backgroundColor: '#f4ecd8',
        textColor: '#5b4636',
        linkColor: '#7b5a3c',
        selectionColor: 'rgba(123, 90, 60, 0.3)',
      },
      dark: {
        name: 'dark',
        backgroundColor: '#1a1a1a',
        textColor: '#e0e0e0',
        linkColor: '#6699cc',
        selectionColor: 'rgba(102, 153, 204, 0.3)',
      },
    }

    return themes[this.settings.theme] || themes.light
  }

  private getViewport(): ViewportSize {
    return {
      width: this.iframeContainer?.clientWidth || 800,
      height: this.iframeContainer?.clientHeight || 600,
    }
  }

  private async updatePagination(preservedCfi: string | null = null): Promise<void> {
    const doc = this.iframe?.contentDocument
    if (!doc) return
    if (!this.scrollElement) {
      this.scrollElement = this.getScrollElement(doc)
    }

    const viewport = this.getViewport()
    const margin = MARGIN_SIZES[this.settings.marginSize]
    const columnWidth = Math.max(1, viewport.width - margin * 2)
    const columnGap = Math.max(0, margin * 2)
    const pageSize = columnWidth + columnGap
    if (pageSize <= 0) return

    const scrollElement = this.scrollElement
    const previousScrollWidth = this.getScrollWidth(doc, scrollElement)
    const previousScrollLeft = scrollElement.scrollLeft
    await this.waitForLayout()
    if (this.iframe?.contentDocument !== doc) return

    const scrollWidth = this.getScrollWidth(doc, scrollElement)
    const totalPages = Math.max(1, Math.ceil(scrollWidth / pageSize))

    this.pagination = {
      currentPage: 0,
      totalPages,
      columnWidth,
      columnGap,
      scrollLeft: scrollElement.scrollLeft,
    }

    if (preservedCfi) {
      await this.goToCfi(preservedCfi)
      return
    }

    if (previousScrollWidth > 0 && scrollWidth > 0) {
      const ratio = previousScrollLeft / previousScrollWidth
      const targetScrollLeft = Math.round(ratio * scrollWidth)
      const alignedPage = Math.min(
        Math.max(0, Math.round(targetScrollLeft / pageSize)),
        totalPages - 1
      )
      const alignedScrollLeft = alignedPage * pageSize
      scrollElement.scrollLeft = alignedScrollLeft
      this.pagination.scrollLeft = alignedScrollLeft
    }

    this.syncCurrentPageFromScroll()
    this.updateLocation()
  }

  private getScrollWidth(doc: Document, scrollElement: HTMLElement): number {
    const bodyWidth = doc.body?.scrollWidth ?? 0
    const docWidth = doc.documentElement?.scrollWidth ?? 0
    return Math.max(scrollElement.scrollWidth, bodyWidth, docWidth)
  }

  private async waitForLayout(): Promise<void> {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
  }

  async next(): Promise<void> {
    if (this.settings.mode === 'paginated') {
      await this.nextPage()
    } else {
      await this.scrollNext()
    }
  }

  async prev(): Promise<void> {
    if (this.settings.mode === 'paginated') {
      await this.prevPage()
    } else {
      await this.scrollPrev()
    }
  }

  private async nextPage(): Promise<void> {
    if (!this.pagination) return

    if (this.pagination.currentPage < this.pagination.totalPages - 1) {
      this.pagination.currentPage++
      this.scrollToPage(this.pagination.currentPage)
      this.updateLocation()
    } else {
      // Go to next spine item
      await this.nextSpineItem()
    }
  }

  private async prevPage(): Promise<void> {
    if (!this.pagination) return

    if (this.pagination.currentPage > 0) {
      this.pagination.currentPage--
      this.scrollToPage(this.pagination.currentPage)
      this.updateLocation()
    } else {
      // Go to previous spine item
      await this.prevSpineItem(true)
    }
  }

  private scrollToPage(page: number): void {
    const doc = this.iframe?.contentDocument
    if (!doc || !this.pagination) return

    const scrollElement = this.scrollElement || this.getScrollElement(doc)
    this.scrollElement = scrollElement
    const scrollLeft = page * (this.pagination.columnWidth + this.pagination.columnGap)
    scrollElement.scrollLeft = scrollLeft
    this.pagination.scrollLeft = scrollLeft
  }

  private async scrollNext(): Promise<void> {
    const doc = this.iframe?.contentDocument
    if (!doc) return

    const scrollElement = this.scrollElement || this.getScrollElement(doc)
    this.scrollElement = scrollElement
    const scrollTop = scrollElement.scrollTop
    const scrollHeight = scrollElement.scrollHeight
    const clientHeight = scrollElement.clientHeight || this.getViewport().height

    if (scrollTop + clientHeight >= scrollHeight - 10) {
      // At bottom, go to next spine item
      await this.nextSpineItem()
    } else {
      scrollElement.scrollBy({ top: clientHeight * 0.9, behavior: 'smooth' })
      this.updateLocation()
    }
  }

  private async scrollPrev(): Promise<void> {
    const doc = this.iframe?.contentDocument
    if (!doc) return

    const scrollElement = this.scrollElement || this.getScrollElement(doc)
    this.scrollElement = scrollElement
    const scrollTop = scrollElement.scrollTop
    const viewport = this.getViewport()
    const clientHeight = scrollElement.clientHeight || viewport.height

    if (scrollTop <= 10) {
      // At top, go to previous spine item
      await this.prevSpineItem(true)
    } else {
      scrollElement.scrollBy({ top: -clientHeight * 0.9, behavior: 'smooth' })
      this.updateLocation()
    }
  }

  private async nextSpineItem(): Promise<void> {
    if (this.currentSpineIndex < this.spineItems.length - 1) {
      await this.display(this.currentSpineIndex + 1)
    }
  }

  private async prevSpineItem(goToEnd: boolean = false): Promise<void> {
    if (this.currentSpineIndex > 0) {
      await this.display(this.currentSpineIndex - 1)

      if (goToEnd) {
        // Go to last page/bottom of previous spine item
        if (this.settings.mode === 'paginated' && this.pagination) {
          this.pagination.currentPage = this.pagination.totalPages - 1
          this.scrollToPage(this.pagination.currentPage)
        } else {
          const doc = this.iframe?.contentDocument
          if (doc) {
            const scrollElement = this.scrollElement || this.getScrollElement(doc)
            this.scrollElement = scrollElement
            scrollElement.scrollTop = scrollElement.scrollHeight
          }
        }
        this.updateLocation()
      }
    }
  }

  goToFragment(elementId: string): void {
    const doc = this.iframe?.contentDocument
    if (!doc) return

    const element = doc.getElementById(elementId)
    if (!element) return

    if (this.settings.mode === 'paginated' && this.pagination) {
      // Calculate which page contains this element
      const rect = element.getBoundingClientRect()
      const scrollElement = this.scrollElement || this.getScrollElement(doc)
      this.scrollElement = scrollElement
      const scrollLeft = scrollElement.scrollLeft
      const elementLeft = rect.left + scrollLeft
      const page = Math.floor(elementLeft / (this.pagination.columnWidth + this.pagination.columnGap))

      this.pagination.currentPage = Math.min(page, this.pagination.totalPages - 1)
      this.scrollToPage(this.pagination.currentPage)
    } else {
      element.scrollIntoView({ behavior: 'smooth' })
    }

    this.updateLocation()
  }

  async goToCfi(cfi: string): Promise<void> {
    const spineIndex = this.cfiResolver.getSpineIndex(cfi)

    if (!this.iframe || !this.iframe.contentDocument) {
      if (spineIndex >= 0) {
        await this.display(spineIndex, cfi)
      }
      return
    }

    if (spineIndex !== this.currentSpineIndex && spineIndex >= 0) {
      await this.display(spineIndex, cfi)
      return
    }

    const doc = this.iframe?.contentDocument
    if (!doc) return

    const result = this.cfiResolver.resolve(cfi, doc)
    if (!result) return

    // Find the element containing this node
    let element: Element | null = null
    if (result.node.nodeType === Node.TEXT_NODE) {
      element = result.node.parentElement
    } else if (result.node.nodeType === Node.ELEMENT_NODE) {
      element = result.node as Element
    }

    if (!element) return

    if (this.settings.mode === 'paginated' && this.pagination) {
      const rect = element.getBoundingClientRect()
      const scrollElement = this.scrollElement || this.getScrollElement(doc)
      this.scrollElement = scrollElement
      const scrollLeft = scrollElement.scrollLeft
      const elementLeft = rect.left + scrollLeft
      const page = Math.floor(elementLeft / (this.pagination.columnWidth + this.pagination.columnGap))

      this.pagination.currentPage = Math.min(Math.max(0, page), this.pagination.totalPages - 1)
      this.scrollToPage(this.pagination.currentPage)
    } else {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    this.updateLocation()
  }

  private updateLocation(): void {
    const doc = this.iframe?.contentDocument
    if (!doc) return

    const spineItem = this.spineItems[this.currentSpineIndex]
    if (!spineItem) return

    // Calculate percentage
    let percentage = 0
    if (this.settings.mode === 'paginated' && this.pagination) {
      this.syncCurrentPageFromScroll()
      const pageProgress = this.pagination.currentPage / Math.max(1, this.pagination.totalPages - 1)
      const spineProgress = this.currentSpineIndex / Math.max(1, this.spineItems.length - 1)
      percentage = (spineProgress + pageProgress / this.spineItems.length) * 100
    } else {
      const scrollElement = this.scrollElement || this.getScrollElement(doc)
      this.scrollElement = scrollElement
      const scrollTop = scrollElement.scrollTop
      const scrollHeight = scrollElement.scrollHeight
      const clientHeight = scrollElement.clientHeight
      const scrollProgress = scrollTop / Math.max(1, scrollHeight - clientHeight)
      const spineProgress = this.currentSpineIndex / Math.max(1, this.spineItems.length - 1)
      percentage = (spineProgress + scrollProgress / this.spineItems.length) * 100
    }

    // Generate CFI for current position
    const cfi = this.getCurrentCfi() || ''

    const location: Location = {
      cfi,
      spineIndex: this.currentSpineIndex,
      spineHref: spineItem.href,
      displayedPage: this.settings.mode === 'paginated' ? this.pagination?.currentPage : undefined,
      totalPages: this.settings.mode === 'paginated' ? this.pagination?.totalPages : undefined,
      percentage: Math.min(100, Math.max(0, percentage)),
    }

    this.onLocationChange?.(location)
  }

  private getFirstVisibleElement(): Element | null {
    const doc = this.iframe?.contentDocument
    if (!doc) return null

    const body = doc.body
    if (!body) return null

    const viewport = this.getViewport()
    const sampleX = Math.min(Math.max(1, viewport.width * 0.05), viewport.width - 1)
    const sampleY = Math.min(Math.max(1, viewport.height * 0.05), viewport.height - 1)
    const elementAtPoint = doc.elementFromPoint(sampleX, sampleY)
    if (elementAtPoint) {
      const candidate = elementAtPoint.closest('p, h1, h2, h3, h4, h5, h6, div')
      if (candidate) {
        return candidate
      }
    }

    // Find first visible paragraph or heading
    const elements = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div')

    for (const el of elements) {
      const rect = el.getBoundingClientRect()

      if (this.settings.mode === 'paginated') {
        if (rect.left >= 0 && rect.left < viewport.width) {
          return el
        }
      } else {
        if (rect.top >= 0 && rect.top < viewport.height) {
          return el
        }
      }
    }

    return body.firstElementChild
  }

  private getCurrentCfi(): string | null {
    const visibleElement = this.getFirstVisibleElement()
    if (!visibleElement) return null

    try {
      return this.cfiGenerator.generateFromElement(visibleElement, this.currentSpineIndex)
    } catch {
      return null
    }
  }

  private async applySettingsAndSync(preservedCfi: string | null): Promise<void> {
    await this.applySettings()

    if (this.settings.mode === 'paginated') {
      await this.updatePagination(preservedCfi)
      return
    }

    this.pagination = null

    if (preservedCfi) {
      await this.waitForLayout()
      await this.goToCfi(preservedCfi)
    } else {
      this.updateLocation()
    }
  }

  updateSettings(newSettings: Partial<ReaderSettings>): void {
    const preservedCfi = this.getCurrentCfi()
    this.settings = { ...this.settings, ...newSettings }
    void this.applySettingsAndSync(preservedCfi)
  }

  getCurrentSpineIndex(): number {
    return this.currentSpineIndex
  }

  getDocument(): Document | null {
    return this.iframe?.contentDocument || null
  }

  destroy(): void {
    this.teardownDocument()
    if (this.iframe) {
      this.iframe.remove()
      this.iframe = null
    }
    if (this.iframeContainer) {
      this.iframeContainer.remove()
      this.iframeContainer = null
    }
    this.resourceResolver.revokeAll()
  }
}
