import './PdfReader.css'

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { ChevronLeft, ChevronRight, Crop, Loader2 } from 'lucide-react'
// Legacy build: the modern build requires very recent JS features
// (e.g. Map.prototype.getOrInsertComputed) missing in Safari/Firefox.
// Type-only import: pdf.js must never load during SSR (see usePdfDocument).
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  TextLayer,
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import { loadPdfjs } from './usePdfDocument'
import type { ImagePart, TextPart } from 'ai'
import { cn } from '@/lib/utils'
import type {
  PartOptions,
  ReaderHandle,
  VisiblePageInfo,
} from '@/components/reader-shared/types'
import {
  computeSpreadLayout,
  getSpreadRenderWindow,
  getVisiblePageIndices,
  spreadStartFor,
  type ContainerSize,
  type PageMetric,
} from './layout'
import { usePdfDocument } from './usePdfDocument'

export type PdfReaderSettings = {
  spread: 'auto' | 'single' | 'double'
  fit: 'width' | 'page'
  zoom: number
  theme: 'light' | 'sepia' | 'dark'
}

export type PdfReaderProps = {
  bookUrl: string
  bookId: string
  bookTitle?: string
  hasTextLayer?: boolean | null
  initialPage?: number
  initialSettings?: Partial<PdfReaderSettings>
  onReady?: (info: {
    pageCount: number
    title?: string
    author?: string
    hasOutline: boolean
  }) => void
  onLocationChange?: (loc: {
    pageIndex: number
    pageLabel: string
    pageCount: number
    visiblePageIndices: number[]
    visiblePageLabels: string[]
  }) => void
  onSelectionChange?: (sel: PdfSelectionPayload | null) => void
  onAddSelectionToChat?: (sel: PdfSelectionPayload) => void
  onTocChange?: (
    payload: {
      bookId: string
      bookTitle: string
      chapters: Array<{
        title: string
        href: string
        spineIndex: number
        depth: number
      }>
    } | null,
  ) => void
  onSettingsChange?: (s: PdfReaderSettings) => void
  onError?: (err: Error) => void
  className?: string
}

export type PdfSelectionPayload = {
  bookId: string
  bookTitle: string
  startPage: number
  endPage: number
  selectedText: string
  imageDataUrl?: string
}

const DEFAULT_SETTINGS: PdfReaderSettings = {
  spread: 'auto',
  fit: 'page',
  zoom: 1,
  theme: 'light',
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"]'),
  )
}

function textFromContent(
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
) {
  return content.items
    .map((item) => ('str' in item ? item.str : ''))
    .join(' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim()
}

function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return Math.ceil((payload.length * 3) / 4)
}

function pageContainerForNode(node: Node | null): HTMLElement | null {
  const element =
    node instanceof HTMLElement ? node : (node?.parentElement ?? null)
  return element?.closest<HTMLElement>('[data-pdf-page-index]') ?? null
}

function pageIndexFromContainer(container: HTMLElement | null): number | null {
  if (!container) return null
  const raw = container.dataset.pdfPageIndex
  if (raw == null) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

type PageViewProps = {
  pageIndex: number
  width: number
  height: number
  scale: number
  active: boolean
  hasTextLayer: boolean
  getPage: (index: number) => Promise<PDFPageProxy>
  onMetric: (metric: PageMetric) => void
  onRenderStart: (key: string) => void
  onRenderEnd: (key: string) => void
  onError?: (err: Error) => void
  regionRect?: PdfRegionRect | null
}

type PdfRegionRect = {
  pageIndex: number
  left: number
  top: number
  width: number
  height: number
}

type PdfRegionDrag = {
  pageIndex: number
  startX: number
  startY: number
  currentX: number
  currentY: number
}

function PageView({
  pageIndex,
  width,
  height,
  scale,
  active,
  hasTextLayer,
  getPage,
  onMetric,
  onRenderStart,
  onRenderEnd,
  onError,
  regionRect,
}: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textLayerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null
    let textLayer: TextLayer | null = null
    const key = `${pageIndex}:${scale}:${active ? 'active' : 'preload'}`

    async function render() {
      onRenderStart(key)
      try {
        const page = await getPage(pageIndex)
        if (cancelled) return
        const viewport = page.getViewport({ scale, rotation: page.rotate })
        onMetric({
          index: pageIndex,
          width: viewport.width / scale,
          height: viewport.height / scale,
        })

        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (!canvas || !ctx) return
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr))
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        renderTask = page.render({ canvas, canvasContext: ctx, viewport })
        await renderTask.promise

        const layerContainer = textLayerRef.current
        if (active && hasTextLayer && layerContainer && !cancelled) {
          layerContainer.replaceChildren()
          const [textContent, pdfjs] = await Promise.all([
            page.getTextContent(),
            loadPdfjs(),
          ])
          if (cancelled) return
          textLayer = new pdfjs.TextLayer({
            textContentSource: textContent,
            container: layerContainer,
            viewport,
          })
          await textLayer.render()
        } else if (layerContainer) {
          layerContainer.replaceChildren()
        }
      } catch (err) {
        if (!cancelled)
          onError?.(err instanceof Error ? err : new Error(String(err)))
      } finally {
        onRenderEnd(key)
      }
    }

    void render()

    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
      onRenderEnd(key)
    }
  }, [
    active,
    getPage,
    hasTextLayer,
    onError,
    onMetric,
    onRenderEnd,
    onRenderStart,
    pageIndex,
    scale,
  ])

  return (
    <div
      className={cn(
        'pdfreader-page relative shrink-0 bg-white',
        !active && 'pointer-events-none absolute left-0 top-0 opacity-0',
      )}
      data-pdf-page-index={pageIndex}
      style={{ width, height }}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="pdfreader-text-layer textLayer" />
      {regionRect ? (
        <div
          className="pdfreader-region-rect"
          style={{
            left: regionRect.left,
            top: regionRect.top,
            width: regionRect.width,
            height: regionRect.height,
          }}
        />
      ) : null}
    </div>
  )
}

function useElementSize() {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState<ContainerSize>({ width: 0, height: 0 })
  const ref = useCallback((nextNode: HTMLDivElement | null) => {
    setNode(nextNode)
  }, [])

  useEffect(() => {
    if (!node) return
    let frame = 0
    const measure = () => {
      frame = 0
      const rect = node.getBoundingClientRect()
      setSize((prev) => {
        if (prev.width === rect.width && prev.height === rect.height) {
          return prev
        }
        return { width: rect.width, height: rect.height }
      })
    }
    const scheduleMeasure = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(measure)
    }
    scheduleMeasure()

    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(node)
    window.addEventListener('resize', scheduleMeasure)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', scheduleMeasure)
      observer.disconnect()
    }
  }, [node])

  return [ref, size, node] as const
}

export const PdfReader = forwardRef<ReaderHandle, PdfReaderProps>(
  function PdfReader(
    {
      bookUrl,
      bookId,
      bookTitle,
      hasTextLayer,
      initialPage = 0,
      initialSettings,
      onReady,
      onLocationChange,
      onSelectionChange,
      onAddSelectionToChat,
      onTocChange,
      onSettingsChange,
      onError,
      className,
    },
    ref,
  ) {
    const textLayerEnabled = hasTextLayer === true
    const pdf = usePdfDocument(bookUrl)
    const title = bookTitle || pdf.metadata.title || 'PDF'
    const settings = useMemo<PdfReaderSettings>(
      () => ({
        ...DEFAULT_SETTINGS,
        ...initialSettings,
        spread:
          initialSettings?.spread === 'single' ||
          initialSettings?.spread === 'double' ||
          initialSettings?.spread === 'auto'
            ? initialSettings.spread
            : DEFAULT_SETTINGS.spread,
        fit:
          initialSettings?.fit === 'width' || initialSettings?.fit === 'page'
            ? initialSettings.fit
            : DEFAULT_SETTINGS.fit,
        zoom: clamp(initialSettings?.zoom ?? DEFAULT_SETTINGS.zoom, 0.5, 4),
      }),
      [
        initialSettings?.fit,
        initialSettings?.spread,
        initialSettings?.theme,
        initialSettings?.zoom,
      ],
    )
    const [pageIndex, setPageIndex] = useState(() => Math.max(0, initialPage))
    const [jumpValue, setJumpValue] = useState(String(initialPage + 1))
    const [lastSelection, setLastSelection] =
      useState<PdfSelectionPayload | null>(null)
    const [regionMode, setRegionMode] = useState(false)
    const [regionDrag, setRegionDrag] = useState<PdfRegionDrag | null>(null)
    const [metrics, setMetrics] = useState<Map<number, PageMetric>>(
      () => new Map(),
    )
    const [viewportRef, viewportSize, viewportNode] = useElementSize()
    const pageCacheRef = useRef(new Map<number, PDFPageProxy>())
    const textCacheRef = useRef(new Map<number, string>())
    const pendingRenderKeysRef = useRef(new Set<string>())
    const idleWaitersRef = useRef(new Set<() => void>())
    const readyKeyRef = useRef<string | null>(null)
    const tocKeyRef = useRef<string | null>(null)

    const pageCount = pdf.pageCount
    const pageLabels = pdf.pageLabels
    const safePageIndex = pageCount > 0 ? clamp(pageIndex, 0, pageCount - 1) : 0

    const visiblePageIndices = useMemo(
      () =>
        getVisiblePageIndices(
          safePageIndex,
          pageCount,
          settings,
          metrics,
          viewportSize,
        ),
      [metrics, pageCount, safePageIndex, settings, viewportSize],
    )

    const layout = useMemo(
      () =>
        computeSpreadLayout(
          visiblePageIndices,
          metrics,
          viewportSize,
          settings,
        ),
      [metrics, settings, viewportSize, visiblePageIndices],
    )

    const renderWindow = useMemo(
      () =>
        getSpreadRenderWindow(
          safePageIndex,
          pageCount,
          settings,
          metrics,
          viewportSize,
          1,
        ),
      [metrics, pageCount, safePageIndex, settings, viewportSize],
    )

    const setMetric = useCallback((metric: PageMetric) => {
      setMetrics((prev) => {
        const old = prev.get(metric.index)
        if (old && old.width === metric.width && old.height === metric.height) {
          return prev
        }
        const next = new Map(prev)
        next.set(metric.index, metric)
        return next
      })
    }, [])

    const getPage = useCallback(
      async (index: number) => {
        if (!pdf.doc) throw new Error('PDF document is not loaded')
        const cached = pageCacheRef.current.get(index)
        if (cached) return cached
        const page = await pdf.doc.getPage(index + 1)
        pageCacheRef.current.set(index, page)
        const viewport = page.getViewport({ scale: 1, rotation: page.rotate })
        setMetric({ index, width: viewport.width, height: viewport.height })
        return page
      },
      [pdf.doc, setMetric],
    )

    const flushIdleWaiters = useCallback(() => {
      if (pendingRenderKeysRef.current.size > 0) return
      const waiters = [...idleWaitersRef.current]
      idleWaitersRef.current.clear()
      for (const waiter of waiters) waiter()
    }, [])

    const onRenderStart = useCallback((key: string) => {
      pendingRenderKeysRef.current.add(key)
    }, [])

    const onRenderEnd = useCallback(
      (key: string) => {
        pendingRenderKeysRef.current.delete(key)
        flushIdleWaiters()
      },
      [flushIdleWaiters],
    )

    const waitForIdle = useCallback((timeoutMs = 2000) => {
      if (pendingRenderKeysRef.current.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          idleWaitersRef.current.delete(finish)
          window.clearTimeout(timer)
          resolve()
        }
        const timer = window.setTimeout(finish, timeoutMs)
        idleWaitersRef.current.add(finish)
      })
    }, [])

    const notifyLocation = useCallback(
      (nextPageIndex: number) => {
        if (!pageCount) return
        const indices = getVisiblePageIndices(
          nextPageIndex,
          pageCount,
          settings,
          metrics,
          viewportSize,
        )
        onLocationChange?.({
          pageIndex: indices[0] ?? nextPageIndex,
          pageLabel:
            pageLabels[indices[0] ?? nextPageIndex] ??
            String(nextPageIndex + 1),
          pageCount,
          visiblePageIndices: indices,
          visiblePageLabels: indices.map(
            (idx) => pageLabels[idx] ?? String(idx + 1),
          ),
        })
      },
      [
        metrics,
        onLocationChange,
        pageCount,
        pageLabels,
        settings,
        viewportSize,
      ],
    )

    const commitPageIndex = useCallback(
      (nextIndex: number) => {
        if (!pageCount) return
        const clamped = clamp(nextIndex, 0, pageCount - 1)
        const indices = getVisiblePageIndices(
          clamped,
          pageCount,
          settings,
          metrics,
          viewportSize,
        )
        const first = indices[0] ?? clamped
        setPageIndex(first)
        setJumpValue(String(first + 1))
        notifyLocation(first)
      },
      [metrics, notifyLocation, pageCount, settings, viewportSize],
    )

    const containingOutlineIndex = useCallback(
      (targetPage: number) => {
        if (!pdf.outline.length) return 0
        let match = 0
        for (let i = 0; i < pdf.outline.length; i += 1) {
          if (pdf.outline[i].pageIndex <= targetPage) match = i
        }
        return match
      },
      [pdf.outline],
    )

    const extractPageText = useCallback(
      async (targetPage: number) => {
        const cached = textCacheRef.current.get(targetPage)
        if (cached != null) return cached
        const page = await getPage(targetPage)
        const text = textFromContent(await page.getTextContent())
        textCacheRef.current.set(targetPage, text)
        return text
      },
      [getPage],
    )

    const visibleInfo = useCallback(
      async (stableText: boolean): Promise<VisiblePageInfo | null> => {
        if (!pdf.doc || !pageCount || !visiblePageIndices.length) return null
        const first = visiblePageIndices[0]
        const text = textLayerEnabled
          ? (
              await Promise.all(
                visiblePageIndices.map((idx) =>
                  stableText
                    ? extractPageText(idx)
                    : Promise.resolve(textCacheRef.current.get(idx) ?? ''),
                ),
              )
            )
              .filter(Boolean)
              .join('\n\n')
          : ''
        return {
          href: `page:${first}`,
          spineIndex: containingOutlineIndex(first),
          pageIndex: first,
          chapterTotalPages: pageCount,
          text,
        }
      },
      [
        containingOutlineIndex,
        extractPageText,
        pageCount,
        pdf.doc,
        textLayerEnabled,
        visiblePageIndices,
      ],
    )

    const rasterizePage = useCallback(
      async (targetPage: number) => {
        const page = await getPage(targetPage)
        const base = page.getViewport({ scale: 1, rotation: page.rotate })
        const scale = Math.min(1.5, 2000 / Math.max(base.width, base.height))
        const viewport = page.getViewport({ scale, rotation: page.rotate })
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Canvas 2D context is unavailable')
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
        const renderTask = page.render({ canvas, canvasContext: ctx, viewport })
        await renderTask.promise
        return canvas.toDataURL('image/png')
      },
      [getPage],
    )

    const getPageRangeParts = useCallback(
      async ({
        startPage,
        endPage,
        maxChars,
        maxImages,
        maxImageBytes,
      }: { startPage: number; endPage: number } & PartOptions) => {
        if (!pdf.doc || pageCount <= 0) return null
        const start = clamp(Math.min(startPage, endPage), 0, pageCount - 1)
        const end = clamp(Math.max(startPage, endPage), 0, pageCount - 1)
        if (textLayerEnabled) {
          const parts: TextPart[] = []
          let remaining = maxChars ?? Number.POSITIVE_INFINITY
          for (let idx = start; idx <= end && remaining > 0; idx += 1) {
            const prefix = `[Page ${pageLabels[idx] ?? idx + 1}]\n`
            const text = await extractPageText(idx)
            const body = `${prefix}${text}`.slice(0, remaining)
            remaining -= body.length
            parts.push({ type: 'text', text: body })
          }
          return parts
        }

        const parts: ImagePart[] = []
        let usedBytes = 0
        for (let idx = start; idx <= end; idx += 1) {
          if (maxImages != null && parts.length >= maxImages) break
          const dataUrl = await rasterizePage(idx)
          const bytes = dataUrlByteSize(dataUrl)
          if (maxImageBytes != null && usedBytes + bytes > maxImageBytes) break
          usedBytes += bytes
          parts.push({ type: 'image', image: dataUrl, mediaType: 'image/png' })
        }
        return parts
      },
      [
        extractPageText,
        pageCount,
        pageLabels,
        pdf.doc,
        rasterizePage,
        textLayerEnabled,
      ],
    )

    const getSpineItemRange = useCallback(
      (spineIndex: number) => {
        if (!pageCount) return null
        if (!pdf.outline.length) {
          const page = clamp(spineIndex, 0, pageCount - 1)
          return { start: page, end: page }
        }
        const entry = pdf.outline[spineIndex]
        if (!entry) return null
        const next = pdf.outline
          .slice(spineIndex + 1)
          .find((candidate) => candidate.pageIndex > entry.pageIndex)
        return {
          start: clamp(entry.pageIndex, 0, pageCount - 1),
          end: clamp((next?.pageIndex ?? pageCount) - 1, 0, pageCount - 1),
        }
      },
      [pageCount, pdf.outline],
    )

    useImperativeHandle(
      ref,
      () => ({
        next: () => {
          const first = visiblePageIndices[0] ?? safePageIndex
          commitPageIndex(first === 0 ? 1 : first + visiblePageIndices.length)
        },
        prev: () => {
          const first = visiblePageIndices[0] ?? safePageIndex
          const isDouble = visiblePageIndices.length > 1
          const prevStart = first <= 1 ? 0 : first - (isDouble ? 2 : 1)
          commitPageIndex(spreadStartFor(prevStart, pageCount, isDouble))
        },
        goToHref: (href: string) => {
          const page = href.startsWith('page:')
            ? Number.parseInt(href.slice('page:'.length), 10)
            : Number.parseInt(href, 10)
          if (Number.isFinite(page)) commitPageIndex(page)
        },
        getVisiblePage: () => {
          const first = visiblePageIndices[0]
          if (!pdf.doc || !pageCount || first == null) return null
          const text = textLayerEnabled
            ? visiblePageIndices
                .map((idx) => textCacheRef.current.get(idx) ?? '')
                .filter(Boolean)
                .join('\n\n')
            : ''
          return {
            href: `page:${first}`,
            spineIndex: containingOutlineIndex(first),
            pageIndex: first,
            chapterTotalPages: pageCount,
            text,
          }
        },
        getVisiblePageStable: async (opts) => {
          await waitForIdle(opts?.timeoutMs)
          return visibleInfo(true)
        },
        getVisiblePageParts: async (opts) => {
          const first = visiblePageIndices[0]
          const last = visiblePageIndices[visiblePageIndices.length - 1]
          if (first == null || last == null) return null
          return getPageRangeParts({ startPage: first, endPage: last, ...opts })
        },
        getVisiblePagePartsStable: async (opts) => {
          await waitForIdle(opts?.timeoutMs)
          const first = visiblePageIndices[0]
          const last = visiblePageIndices[visiblePageIndices.length - 1]
          if (first == null || last == null) return null
          return getPageRangeParts({ startPage: first, endPage: last, ...opts })
        },
        getSpineItemText: async ({ spineIndex, maxChars }) => {
          const range = getSpineItemRange(spineIndex)
          if (!range) return null
          let text = ''
          for (let idx = range.start; idx <= range.end; idx += 1) {
            const chunk = await extractPageText(idx)
            text += `${text ? '\n\n' : ''}${chunk}`
            if (maxChars != null && text.length >= maxChars) {
              return text.slice(0, maxChars)
            }
          }
          return text
        },
        getSpineItemParts: async ({ spineIndex, ...opts }) => {
          const range = getSpineItemRange(spineIndex)
          if (!range) return null
          return getPageRangeParts({
            startPage: range.start,
            endPage: range.end,
            ...opts,
          })
        },
        getPageRangeParts,
      }),
      [
        commitPageIndex,
        containingOutlineIndex,
        extractPageText,
        getPageRangeParts,
        getSpineItemRange,
        pageCount,
        pdf.doc,
        safePageIndex,
        textLayerEnabled,
        visibleInfo,
        visiblePageIndices,
        waitForIdle,
      ],
    )

    useEffect(() => {
      if (pdf.error) onError?.(pdf.error)
    }, [onError, pdf.error])

    useEffect(() => {
      onSettingsChange?.(settings)
    }, [onSettingsChange, settings])

    useEffect(() => {
      if (!pdf.doc || !pageCount) return
      const key = `${bookUrl}:${pageCount}:${pdf.metadata.title ?? ''}:${pdf.metadata.author ?? ''}`
      if (readyKeyRef.current === key) return
      readyKeyRef.current = key
      onReady?.({
        pageCount,
        title: pdf.metadata.title,
        author: pdf.metadata.author,
        hasOutline: pdf.outline.length > 0,
      })
      notifyLocation(safePageIndex)
    }, [
      bookUrl,
      notifyLocation,
      onReady,
      pageCount,
      pdf.doc,
      pdf.metadata.author,
      pdf.metadata.title,
      pdf.outline.length,
      safePageIndex,
    ])

    useEffect(() => {
      if (!pdf.doc || !pageCount) return
      const chapters = pdf.outline.map((entry, index) => ({
        title: entry.title,
        href: `page:${entry.pageIndex}`,
        spineIndex: index,
        depth: entry.depth,
      }))
      const key = JSON.stringify(chapters)
      if (tocKeyRef.current === key) return
      tocKeyRef.current = key
      onTocChange?.({ bookId, bookTitle: title, chapters })
    }, [bookId, onTocChange, pageCount, pdf.doc, pdf.outline, title])

    useEffect(() => {
      const pages = getSpreadRenderWindow(
        safePageIndex,
        pageCount,
        settings,
        metrics,
        viewportSize,
        2,
      )
      const keep = new Set(pages)
      for (const [idx, page] of pageCacheRef.current) {
        if (!keep.has(idx)) {
          page.cleanup()
          pageCacheRef.current.delete(idx)
          textCacheRef.current.delete(idx)
        }
      }
    }, [metrics, pageCount, safePageIndex, settings, viewportSize])

    useEffect(() => {
      if (!textLayerEnabled || !visiblePageIndices.length) return
      for (const idx of visiblePageIndices) {
        void extractPageText(idx).catch(() => undefined)
      }
    }, [extractPageText, textLayerEnabled, visiblePageIndices])

    const regionRect = useMemo<PdfRegionRect | null>(() => {
      if (!regionDrag) return null
      const left = Math.min(regionDrag.startX, regionDrag.currentX)
      const top = Math.min(regionDrag.startY, regionDrag.currentY)
      const width = Math.abs(regionDrag.currentX - regionDrag.startX)
      const height = Math.abs(regionDrag.currentY - regionDrag.startY)
      return { pageIndex: regionDrag.pageIndex, left, top, width, height }
    }, [regionDrag])

    const pagePointFromClient = useCallback(
      (clientX: number, clientY: number, pageIndexHint?: number) => {
        const selector =
          pageIndexHint == null
            ? '[data-pdf-page-index]'
            : `[data-pdf-page-index="${pageIndexHint}"]`
        const pageElement =
          pageIndexHint == null
            ? (document
                .elementFromPoint(clientX, clientY)
                ?.closest<HTMLElement>(selector) ?? null)
            : (viewportNode?.querySelector<HTMLElement>(selector) ?? null)
        const pageIndex = pageIndexFromContainer(pageElement)
        if (!pageElement || pageIndex == null) return null
        const rect = pageElement.getBoundingClientRect()
        return {
          pageElement,
          pageIndex,
          x: clamp(clientX - rect.left, 0, rect.width),
          y: clamp(clientY - rect.top, 0, rect.height),
        }
      },
      [viewportNode],
    )

    const cropRegionToDataUrl = useCallback((rect: PdfRegionRect) => {
      const pageElement = viewportNode?.querySelector<HTMLElement>(
        `[data-pdf-page-index="${rect.pageIndex}"]`,
      )
      const canvas = pageElement?.querySelector('canvas') ?? null
      if (!pageElement || !canvas) return null
      const bounds = pageElement.getBoundingClientRect()
      if (bounds.width <= 0 || bounds.height <= 0) return null
      const scaleX = canvas.width / bounds.width
      const scaleY = canvas.height / bounds.height
      const sourceX = Math.max(0, Math.floor(rect.left * scaleX))
      const sourceY = Math.max(0, Math.floor(rect.top * scaleY))
      const sourceWidth = Math.max(1, Math.floor(rect.width * scaleX))
      const sourceHeight = Math.max(1, Math.floor(rect.height * scaleY))
      const output = document.createElement('canvas')
      output.width = Math.min(sourceWidth, canvas.width - sourceX)
      output.height = Math.min(sourceHeight, canvas.height - sourceY)
      const ctx = output.getContext('2d')
      if (!ctx || output.width <= 0 || output.height <= 0) return null
      ctx.drawImage(
        canvas,
        sourceX,
        sourceY,
        output.width,
        output.height,
        0,
        0,
        output.width,
        output.height,
      )
      return output.toDataURL('image/png')
    }, [viewportNode])

    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (isEditableTarget(event.target)) return
        if (event.key === 'Escape' && regionMode) {
          event.preventDefault()
          setRegionMode(false)
          setRegionDrag(null)
          return
        }
        if (event.key === 'ArrowRight' || event.key === 'PageDown') {
          event.preventDefault()
          const first = visiblePageIndices[0] ?? safePageIndex
          commitPageIndex(first === 0 ? 1 : first + visiblePageIndices.length)
        } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
          event.preventDefault()
          const first = visiblePageIndices[0] ?? safePageIndex
          commitPageIndex(first <= 1 ? 0 : first - visiblePageIndices.length)
        } else if (event.key === 'Home') {
          event.preventDefault()
          commitPageIndex(0)
        } else if (event.key === 'End') {
          event.preventDefault()
          commitPageIndex(pageCount - 1)
        }
      }
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }, [
      commitPageIndex,
      pageCount,
      regionMode,
      safePageIndex,
      visiblePageIndices,
    ])

    const finishRegionSelection = useCallback(
      (rect: PdfRegionRect | null) => {
        setRegionDrag(null)
        if (!rect || rect.width < 12 || rect.height < 12) return
        const imageDataUrl = cropRegionToDataUrl(rect)
        if (!imageDataUrl) return
        const payload: PdfSelectionPayload = {
          bookId,
          bookTitle: title,
          startPage: rect.pageIndex,
          endPage: rect.pageIndex,
          selectedText: '',
          imageDataUrl,
        }
        setLastSelection(payload)
        onSelectionChange?.(payload)
        onAddSelectionToChat?.(payload)
        setRegionMode(false)
      },
      [
        bookId,
        cropRegionToDataUrl,
        onAddSelectionToChat,
        onSelectionChange,
        title,
      ],
    )

    useEffect(() => {
      if (!regionDrag) return
      const handleMouseMove = (event: MouseEvent) => {
        event.preventDefault()
        const point = pagePointFromClient(
          event.clientX,
          event.clientY,
          regionDrag.pageIndex,
        )
        if (!point) return
        setRegionDrag((prev) =>
          prev ? { ...prev, currentX: point.x, currentY: point.y } : prev,
        )
      }
      const handleMouseUp = (event: MouseEvent) => {
        event.preventDefault()
        const point = pagePointFromClient(
          event.clientX,
          event.clientY,
          regionDrag.pageIndex,
        )
        const nextDrag = point
          ? { ...regionDrag, currentX: point.x, currentY: point.y }
          : regionDrag
        const left = Math.min(nextDrag.startX, nextDrag.currentX)
        const top = Math.min(nextDrag.startY, nextDrag.currentY)
        const width = Math.abs(nextDrag.currentX - nextDrag.startX)
        const height = Math.abs(nextDrag.currentY - nextDrag.startY)
        finishRegionSelection({
          pageIndex: nextDrag.pageIndex,
          left,
          top,
          width,
          height,
        })
      }
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }, [finishRegionSelection, pagePointFromClient, regionDrag])

    const handleRegionMouseDown = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        if (!regionMode) return false
        if (event.button !== 0) return true
        const point = pagePointFromClient(event.clientX, event.clientY)
        if (!point) return true
        event.preventDefault()
        event.stopPropagation()
        setLastSelection(null)
        onSelectionChange?.(null)
        setRegionDrag({
          pageIndex: point.pageIndex,
          startX: point.x,
          startY: point.y,
          currentX: point.x,
          currentY: point.y,
        })
        return true
      },
      [onSelectionChange, pagePointFromClient, regionMode],
    )

    const handleMouseUp = useCallback(() => {
      if (regionMode) return
      if (!textLayerEnabled) return
      const selection = window.getSelection()
      const selectedText = selection?.toString().trim() ?? ''
      if (!selection || !selectedText) {
        setLastSelection(null)
        onSelectionChange?.(null)
        return
      }
      const startPage = pageIndexFromContainer(
        pageContainerForNode(selection.anchorNode),
      )
      const endPage = pageIndexFromContainer(
        pageContainerForNode(selection.focusNode),
      )
      if (startPage == null || endPage == null) return
      const payload: PdfSelectionPayload = {
        bookId,
        bookTitle: title,
        startPage: Math.min(startPage, endPage),
        endPage: Math.max(startPage, endPage),
        selectedText,
      }
      setLastSelection(payload)
      onSelectionChange?.(payload)
    }, [bookId, onSelectionChange, regionMode, textLayerEnabled, title])

    const submitJump = useCallback(() => {
      const parsed = Number.parseInt(jumpValue, 10)
      if (Number.isFinite(parsed)) commitPageIndex(parsed - 1)
    }, [commitPageIndex, jumpValue])

    const themeClass =
      settings.theme === 'dark'
        ? 'pdfreader-theme-dark bg-neutral-950 text-neutral-100'
        : settings.theme === 'sepia'
          ? 'pdfreader-theme-sepia bg-[#ece3d2] text-stone-900'
          : 'pdfreader-theme-light bg-neutral-100 text-neutral-950'

    if (pdf.loading) {
      return (
        <div
          className={cn(
            'flex h-full items-center justify-center',
            themeClass,
            className,
          )}
        >
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )
    }

    if (pdf.error) {
      return (
        <div
          className={cn(
            'flex h-full items-center justify-center p-6',
            themeClass,
            className,
          )}
        >
          <div className="max-w-md rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            {pdf.error.message}
          </div>
        </div>
      )
    }

    return (
      <div
        className={cn(
          'pdfreader-root flex h-full min-h-0 flex-col',
          themeClass,
          className,
        )}
      >
        <div
          ref={viewportRef}
          className={cn(
            'pdfreader-viewport relative min-h-0 flex-1 overflow-hidden',
            regionMode && 'cursor-crosshair select-none',
          )}
          onMouseDown={handleRegionMouseDown}
          onMouseUp={handleMouseUp}
        >
          <div
            className="pdfreader-spread absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center"
            style={{
              gap: layout.gap,
              width: layout.width,
              height: layout.height,
            }}
          >
            {renderWindow.map((idx) => {
              const active = visiblePageIndices.includes(idx)
              const pageLayout = layout.pages.find((page) => page.index === idx)
              const metric = metrics.get(idx) ?? {
                index: idx,
                width: 612,
                height: 792,
              }
              const width = active
                ? (pageLayout?.width ?? metric.width * layout.scale)
                : metric.width * layout.scale
              const height = active
                ? (pageLayout?.height ?? metric.height * layout.scale)
                : metric.height * layout.scale
              return (
                <PageView
                  key={idx}
                  pageIndex={idx}
                  width={width}
                  height={height}
                  scale={layout.scale}
                  active={active}
                  hasTextLayer={textLayerEnabled}
                  getPage={getPage}
                  onMetric={setMetric}
                  onRenderStart={onRenderStart}
                  onRenderEnd={onRenderEnd}
                  onError={onError}
                  regionRect={regionRect?.pageIndex === idx ? regionRect : null}
                />
              )
            })}
          </div>
        </div>
        <div className="pdfreader-toolbar">
          <div className="pdfreader-toolbarGroup">
            <button
              type="button"
              className={cn(
                'pdfreader-iconButton',
                regionMode && 'pdfreader-iconButtonActive',
              )}
              onClick={() => {
                setRegionDrag(null)
                setRegionMode((prev) => !prev)
              }}
              aria-label="Select region"
              aria-pressed={regionMode}
              title="Select region"
            >
              <Crop className="h-4 w-4" />
            </button>
          </div>
          <div className="pdfreader-toolbarGroup">
            <button
              type="button"
              className="pdfreader-iconButton"
              onClick={() =>
                commitPageIndex(
                  (visiblePageIndices[0] ?? safePageIndex) -
                    visiblePageIndices.length,
                )
              }
              aria-label="Previous page"
              title="Previous page"
              disabled={(visiblePageIndices[0] ?? safePageIndex) <= 0}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <form
              className="pdfreader-pageControl"
              onSubmit={(event) => {
                event.preventDefault()
                submitJump()
              }}
            >
              <input
                className="pdfreader-pageInput"
                value={jumpValue}
                onChange={(event) => setJumpValue(event.target.value)}
                onBlur={submitJump}
                aria-label="Page number"
              />
              <span className="pdfreader-pageTotal">
                / {pageLabels[pageCount - 1] ?? pageCount}
              </span>
            </form>
            <button
              type="button"
              className="pdfreader-iconButton"
              onClick={() =>
                commitPageIndex(
                  (visiblePageIndices[0] ?? safePageIndex) +
                    visiblePageIndices.length,
                )
              }
              aria-label="Next page"
              title="Next page"
              disabled={
                (visiblePageIndices[visiblePageIndices.length - 1] ??
                  safePageIndex) >=
                pageCount - 1
              }
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          {lastSelection ? (
            <button
              type="button"
              className="pdfreader-addSelectionButton"
              onClick={() => onAddSelectionToChat?.(lastSelection)}
            >
              Add selection
            </button>
          ) : null}
        </div>
      </div>
    )
  },
)
