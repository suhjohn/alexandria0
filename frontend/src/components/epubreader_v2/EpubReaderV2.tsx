import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import type {
  EpubReaderV2Location,
  EpubReaderV2BookMetadata,
  EpubReaderV2Publication,
  EpubReaderV2ReadyPayload,
  EpubReaderV2Settings,
  EpubReaderV2TocItem,
  EpubReaderV2ThemePreset,
} from './types'
import { IoCheckmarkCircle, IoSparkles } from 'react-icons/io5'
import { Loader2 } from 'lucide-react'
import { EpubReaderV2Error, THEME_PRESETS } from './types'
import { fetchArrayBufferWithProgress } from './epub/fetcher'
import { loadEpubPublication } from './epub/publication'
import { ZipWorkerClient } from './epub/zipWorkerClient'
import { useElementSize } from './hooks/useElementSize'
import { buildSpineItemSrcDoc } from './rendering/buildSrcDoc'
import {
  applyReaderLayout,
  findPageIndexForElement,
  scrollToPage,
  type AppliedLayout,
} from './rendering/layout'
import { IoList } from 'react-icons/io5'
import { normalizePath, resolveRelativePath, splitHref } from './utils/path'
import { EpubResourceStore } from './rendering/resources'
import { setReaderSettings, useReaderSettings } from '@/lib/reader-settings'
import {
  getBookTransform,
  startBookTransform,
  type TransformStatus,
} from '@/data/books'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

export type EpubReaderV2Handle = {
  next: () => void
  prev: () => void
  goToHref: (href: string) => void
  setSettings: (settings: Partial<EpubReaderV2Settings>) => void
  getSettings: () => EpubReaderV2Settings
  getVisiblePage: () => {
    href: string
    spineIndex: number
    pageIndex: number
    chapterTotalPages: number
    text: string
  } | null
}

export type EpubReaderV2Status =
  | 'idle'
  | 'downloading'
  | 'unpacking'
  | 'parsing'
  | 'rendering'
  | 'ready'
  | 'error'

type ReaderSelectionPayload = {
  bookId: string
  bookTitle: string
  spineIndex: number
  startPage: number
  startIndex: number
  endPage: number
  endIndex: number
  selectedText: string
}

export type EpubReaderV2Props = {
  bookUrl: string
  transformedBookUrl?: string
  transformationData?: Record<string, string[]>
  storageId?: string
  authHeaders?: Record<string, string>
  initialSettings?: Partial<EpubReaderV2Settings>
  onReady?: (meta: EpubReaderV2ReadyPayload) => void
  onStatusChange?: (status: EpubReaderV2Status) => void
  onLocationChange?: (loc: EpubReaderV2Location) => void
  onSelectionChange?: (sel: ReaderSelectionPayload | null) => void
  onAddSelectionToChat?: (sel: ReaderSelectionPayload) => void
  onTocChange?: (
    payload: {
      bookId: string
      bookTitle: string
      metadata?: EpubReaderV2BookMetadata
      chapters: Array<{
        title: string
        href: string
        spineIndex: number
        depth: number
      }>
    } | null,
  ) => void
  pendingNavigation?: {
    id: string
    bookId: string
    spineIndex?: number
    textOffset?: number
    href?: string
  } | null
  onConsumePendingNavigation?: (id: string) => void
  onError?: (err: unknown) => void
  className?: string
  style?: React.CSSProperties
}

type ReaderStatus = EpubReaderV2Status

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function normalizeVisibleText(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function extractVisibleText(options: {
  doc: Document
  layout: AppliedLayout
  flowMode: EpubReaderV2Settings['flowMode']
  pageIndex: number
  maxChars: number
}): string {
  const { doc, layout, flowMode, pageIndex, maxChars } = options
  const viewportEl = layout.viewportEl
  const viewportRect = viewportEl.getBoundingClientRect()
  const root = doc.body ?? doc.documentElement

  const candidates = Array.from(
    root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre'),
  ) as HTMLElement[]

  const pieces: string[] = []
  let used = 0

  const push = (raw: string) => {
    const cleaned = normalizeVisibleText(raw)
    if (!cleaned) return
    const chunk = cleaned.length > 600 ? `${cleaned.slice(0, 600)}…` : cleaned
    if (used + chunk.length > maxChars) {
      const remain = Math.max(0, maxChars - used)
      if (remain > 24) pieces.push(`${chunk.slice(0, remain)}…`)
      used = maxChars
      return
    }
    pieces.push(chunk)
    used += chunk.length + 1
  }

  const margin = 16
  if (flowMode === 'scrolled') {
    for (const el of candidates) {
      if (used >= maxChars) break
      const rect = el.getBoundingClientRect()
      if (rect.height < 1 || rect.width < 1) continue
      const overlaps =
        rect.bottom >= viewportRect.top - margin &&
        rect.top <= viewportRect.bottom + margin
      if (!overlaps) continue
      push(el.innerText || el.textContent || '')
    }
    return pieces.join('\n').slice(0, maxChars).trim()
  }

  const pageLeft = pageIndex * layout.pageWidth
  const pageRight = pageLeft + viewportEl.clientWidth
  for (const el of candidates) {
    if (used >= maxChars) break
    const rect = el.getBoundingClientRect()
    if (rect.height < 1 || rect.width < 1) continue
    const absoluteLeft = rect.left - viewportRect.left + viewportEl.scrollLeft
    const absoluteRight = absoluteLeft + rect.width
    const overlaps =
      absoluteRight >= pageLeft - margin && absoluteLeft <= pageRight + margin
    if (!overlaps) continue
    push(el.innerText || el.textContent || '')
  }
  return pieces.join('\n').slice(0, maxChars).trim()
}

function storageKey(bookId: string) {
  return `mfv2:epubreader_v2:lastLocation:${bookId}`
}

type StoredLocation = {
  spineIndex: number
  pageIndex: number
  scrollTop?: number
  chapterProgress?: number
}

type TranslateVariant = `translate_${string}`
type ReaderVariant = 'original' | 'modernify' | TranslateVariant

function isReaderVariant(v: string): v is ReaderVariant {
  if (v === 'original' || v === 'modernify') return true
  if (!v.startsWith('translate_')) return false
  const suffix = v.slice('translate_'.length)
  if (!suffix) return false
  if (suffix.length > 240) return false
  if (suffix.includes('/') || suffix.includes('\\') || suffix.includes('..'))
    return false
  return true
}

function variantStorageKey(bookId: string) {
  return `mfv2:epubreader_v2:variant:${bookId}`
}

function loadStoredVariant(bookId: string): ReaderVariant | null {
  try {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined')
      return null
    const raw = localStorage.getItem(variantStorageKey(bookId))
    if (!raw) return null
    const trimmed = raw.trim()
    return isReaderVariant(trimmed) ? trimmed : null
  } catch {
    return null
  }
}

function storeVariant(bookId: string, variant: ReaderVariant) {
  try {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined')
      return
    localStorage.setItem(variantStorageKey(bookId), variant)
  } catch {
    // ignore
  }
}

function toVersionedBookId(baseBookId: string, variant: ReaderVariant): string {
  const base = String(baseBookId ?? '').trim()
  if (!base) return ''
  return `${base}@${variant}`
}

function parseVersionedBookId(raw: string): {
  baseBookId: string
  variant: ReaderVariant | null
} {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return { baseBookId: '', variant: null }
  const idx = trimmed.lastIndexOf('@')
  if (idx < 0) return { baseBookId: trimmed, variant: null }
  const baseBookId = trimmed.slice(0, idx)
  const variant = trimmed.slice(idx + 1)
  if (!baseBookId || !isReaderVariant(variant))
    return { baseBookId: trimmed, variant: null }
  return { baseBookId, variant }
}

function variantLabel(variant: ReaderVariant) {
  if (variant === 'modernify') return 'Modernify'
  if (variant === 'original') return 'Original'
  const lang = langFromTranslateVariant(variant)
  return `Translate: ${lang}`
}

function bookTitleWithVariant(baseTitle: string, variant: ReaderVariant) {
  const title = String(baseTitle ?? '').trim() || 'Book'
  return `${title} [${variantLabel(variant)}]`
}

function langFromTranslateVariant(variant: TranslateVariant): string {
  const suffix = variant.slice('translate_'.length)
  if (suffix.startsWith('~')) {
    const encoded = suffix.slice(1)
    try {
      return decodeURIComponent(encoded) || encoded
    } catch {
      return encoded
    }
  }
  // Legacy format: spaces were normalized to underscores.
  const pretty = suffix.replaceAll('_', ' ').trim()
  return pretty || suffix
}

function normalizeTranslateLangInput(raw: string): string | null {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return null
  const normalized = trimmed.split(/\s+/).filter(Boolean).join(' ')
  if (!normalized) return null
  if (normalized.length > 60) return null
  if (
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized.includes('..')
  )
    return null
  return normalized
}

function transformOptionsForVariant(
  variant: ReaderVariant,
): { type?: 'modernify' | 'translate'; lang?: string } | undefined {
  if (variant === 'modernify') return { type: 'modernify' }
  if (variant === 'original') return undefined
  return { type: 'translate', lang: langFromTranslateVariant(variant) }
}

function translateVariantKeyFromLang(lang: string): TranslateVariant {
  const normalized =
    normalizeTranslateLangInput(lang) ?? String(lang ?? '').trim()
  const encoded = encodeURIComponent(normalized).replaceAll('_', '%5F')
  return `translate_~${encoded}` as TranslateVariant
}

function mergeTransformStatus(
  prev: TransformStatus | null | undefined,
  next: TransformStatus,
): TransformStatus {
  if (!prev) return next
  if (next.status === 'not_started' && prev.status !== 'not_started') return prev
  return { ...prev, ...next }
}

function loadStoredLocation(bookId: string): StoredLocation | null {
  try {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined')
      return null
    const raw = localStorage.getItem(storageKey(bookId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (
      typeof parsed?.spineIndex !== 'number' ||
      typeof parsed?.pageIndex !== 'number'
    )
      return null
    const scrollTop =
      typeof parsed?.scrollTop === 'number' ? parsed.scrollTop : undefined
    const chapterProgress =
      typeof parsed?.chapterProgress === 'number' &&
      Number.isFinite(parsed.chapterProgress)
        ? clamp(parsed.chapterProgress, 0, 1)
        : undefined
    return {
      spineIndex: parsed.spineIndex,
      pageIndex: parsed.pageIndex,
      scrollTop,
      chapterProgress,
    }
  } catch {
    return null
  }
}

function storeLocation(bookId: string, loc: StoredLocation) {
  try {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined')
      return
    localStorage.setItem(storageKey(bookId), JSON.stringify(loc))
  } catch {
    // ignore
  }
}

function flattenToc(
  items: EpubReaderV2TocItem[],
  depth: number = 0,
): Array<{ item: EpubReaderV2TocItem; depth: number }> {
  const out: Array<{ item: EpubReaderV2TocItem; depth: number }> = []
  for (const item of items) {
    out.push({ item, depth })
    out.push(...flattenToc(item.children, depth + 1))
  }
  return out
}

function pickInitialVariant(args: {
  baseStorageId: string
  requestedVariant: ReaderVariant | null
  transformationData?: Record<string, string[]>
  transformedBookUrl?: string
}): ReaderVariant {
  const {
    baseStorageId,
    requestedVariant,
    transformationData,
    transformedBookUrl,
  } = args

  const modernifyUrl =
    String(transformationData?.modernify?.[0] ?? '').trim() ||
    String(transformedBookUrl ?? '').trim()
  const fallback: ReaderVariant = modernifyUrl ? 'modernify' : 'original'

  const isVariantAvailable = (variant: ReaderVariant) => {
    if (variant === 'original') return true
    if (variant === 'modernify') return Boolean(modernifyUrl)
    return Boolean(String(transformationData?.[variant]?.[0] ?? '').trim())
  }

  if (requestedVariant && isVariantAvailable(requestedVariant))
    return requestedVariant

  const storedVariant = baseStorageId ? loadStoredVariant(baseStorageId) : null
  if (storedVariant && isVariantAvailable(storedVariant)) return storedVariant

  return fallback
}

type EpubReaderV2InnerProps = Omit<EpubReaderV2Props, 'storageId'> & {
  baseStorageId: string
  initialVariant: ReaderVariant
}

const EpubReaderV2Inner = forwardRef<
  EpubReaderV2Handle,
  EpubReaderV2InnerProps
>(function EpubReaderV2Inner(props, ref) {
  const {
    bookUrl,
    transformedBookUrl,
    transformationData,
    baseStorageId,
    authHeaders,
    initialSettings,
    onReady,
    onStatusChange,
    onLocationChange,
    onSelectionChange,
    onAddSelectionToChat,
    onTocChange,
    pendingNavigation,
    onConsumePendingNavigation,
    onError,
    className,
    style,
  } = props

  const onReadyRef = useRef(onReady)
  const onStatusChangeRef = useRef(onStatusChange)
  const onLocationChangeRef = useRef(onLocationChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onAddSelectionToChatRef = useRef(onAddSelectionToChat)
  const onTocChangeRef = useRef(onTocChange)
  const onConsumePendingNavigationRef = useRef(onConsumePendingNavigation)
  const onErrorRef = useRef(onError)
  onReadyRef.current = onReady
  onStatusChangeRef.current = onStatusChange
  onLocationChangeRef.current = onLocationChange
  onSelectionChangeRef.current = onSelectionChange
  onAddSelectionToChatRef.current = onAddSelectionToChat
  onTocChangeRef.current = onTocChange
  onConsumePendingNavigationRef.current = onConsumePendingNavigation
  onErrorRef.current = onError

  const containerRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const { width: containerWidth, height: containerHeight } =
    useElementSize(containerRef)

  const isMac = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    const platform =
      (navigator as any).userAgentData?.platform ??
      navigator.platform ??
      navigator.userAgent
    return /mac/i.test(String(platform))
  }, [])
  const modIShortcut = isMac ? '⌘I' : 'Ctrl+I'

  const contextMenuTriggerRef = useRef<HTMLDivElement | null>(null)
  const contextMenuSelectionRef = useRef<ReaderSelectionPayload | null>(null)
  const [contextMenuSelectionText, setContextMenuSelectionText] = useState('')

  const [status, setStatus] = useState<ReaderStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{
    loadedBytes: number
    totalBytes?: number
  }>({ loadedBytes: 0 })
  const [reloadToken, setReloadToken] = useState(0)
  const [isBootstrappingView, setIsBootstrappingView] = useState(false)
  const bootstrapTokenRef = useRef(0)

  const setStatusWithNotify = useCallback((next: ReaderStatus) => {
    setStatus(next)
    onStatusChangeRef.current?.(next)
  }, [])

  const [variant, setVariant] = useState<ReaderVariant>(
    () => props.initialVariant,
  )
  const variantRef = useRef<ReaderVariant>(variant)
  variantRef.current = variant

  const [transformStatuses, setTransformStatuses] = useState<
    Record<string, TransformStatus | null>
  >({})
  const transformStatusesRef = useRef(transformStatuses)
  transformStatusesRef.current = transformStatuses
  const transformStartInFlightRef = useRef<Record<string, boolean>>({})
  const transformIdentityRef = useRef<string>('')

  useEffect(() => {
    // Ensure transform state doesn't leak across book switches if this component instance is reused.
    const identity = `${baseStorageId}|${bookUrl}`
    if (transformIdentityRef.current === identity) return
    transformIdentityRef.current = identity
    setTransformStatuses({})
    transformStartInFlightRef.current = {}
    setTranslateLangDraft('')
    setTranslateLangError(null)
  }, [baseStorageId, bookUrl])

  const resolvedVariantUrl = useMemo(() => {
    if (variant === 'original') return ''
    const fromStatus =
      transformStatuses[variant]?.status === 'ready'
        ? String(transformStatuses[variant]?.url ?? '').trim()
        : ''
    if (fromStatus) return fromStatus
    const fromBook = String(transformationData?.[variant]?.[0] ?? '').trim()
    if (fromBook) return fromBook
    if (variant === 'modernify') return String(transformedBookUrl ?? '').trim()
    return ''
  }, [transformStatuses, variant, transformationData, transformedBookUrl])

  const activeBookUrl = useMemo(() => {
    if (variant !== 'original' && resolvedVariantUrl) return resolvedVariantUrl
    return bookUrl
  }, [variant, resolvedVariantUrl, bookUrl])

  useEffect(() => {
    // Auto-focus the container when component mounts or book changes
    if (containerRef.current && status === 'ready') {
      containerRef.current.focus()
    }
  }, [status, activeBookUrl])

  useEffect(() => {
    if (!baseStorageId) return
    storeVariant(baseStorageId, variant)
  }, [baseStorageId, variant])

  useEffect(() => {
    const bookId = baseStorageId
    if (!bookId) return

    let cancelled = false
    ;(async () => {
      try {
        const status = await getBookTransform(bookId, { type: 'modernify' })
        if (cancelled) return
        setTransformStatuses((prev) => ({
          ...prev,
          modernify: mergeTransformStatus(prev.modernify, status),
        }))
      } catch {
        // Ignore transient failures (offline, dev server down, etc.)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [baseStorageId, bookUrl])

  const pollKey = useMemo(() => {
    const running = Object.entries(transformStatuses)
      .filter(([, s]) => s?.status === 'pending' || s?.status === 'running')
      .map(([k]) => k)
      .sort()
    return running.join('|')
  }, [transformStatuses])

  useEffect(() => {
    const bookId = baseStorageId
    if (!bookId) return
    if (!pollKey) return

    const runningKeys = pollKey.split('|').filter(Boolean) as ReaderVariant[]
    let cancelled = false
    let timer: number | null = null

      const tick = async () => {
        try {
          const results = await Promise.all(
            runningKeys.map(async (key) => {
              const opts = transformOptionsForVariant(key)
              const status = await getBookTransform(bookId, opts)
              return { key, status }
            }),
          )
          if (cancelled) return
          const mergedByKey = new Map<ReaderVariant, TransformStatus>()
          for (const r of results) {
            const merged = mergeTransformStatus(
              transformStatusesRef.current[r.key],
              r.status,
            )
            mergedByKey.set(r.key, merged)
          }
          setTransformStatuses((prev) => {
            const next = { ...prev }
            for (const r of results)
              next[r.key] = mergeTransformStatus(prev[r.key], r.status)
            return next
          })
          const stillRunning = runningKeys.some((key) => {
            const status = mergedByKey.get(key) ?? transformStatusesRef.current[key]
            return status?.status === 'pending' || status?.status === 'running'
          })
          if (stillRunning) timer = window.setTimeout(tick, 5000)
        } catch {
          if (cancelled) return
          timer = window.setTimeout(tick, 10_000)
        }
    }

    tick()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [baseStorageId, pollKey])

  const [publication, setPublication] =
    useState<EpubReaderV2Publication | null>(null)
  const publicationRef = useRef<EpubReaderV2Publication | null>(null)
  const persistenceIdRef = useRef<string | null>(null)
  const zipRef = useRef<ZipWorkerClient | null>(null)
  const resourceStoreRef = useRef<EpubResourceStore | null>(null)

  const settings = useReaderSettings(initialSettings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [tocOpen, setTocOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [hudActive, setHudActive] = useState(false)
  const [fontSizeChangeCount, setFontSizeChangeCount] = useState(0)
  const [translateLangDraft, setTranslateLangDraft] = useState('')
  const [translateLangError, setTranslateLangError] = useState<string | null>(
    null,
  )
  const [toast, setToast] = useState<{
    message: string
    tone: 'error' | 'info'
  } | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const showToast = useCallback(
    (message: string, tone: 'error' | 'info' = 'info') => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
      setToast({ message, tone })
      toastTimerRef.current = window.setTimeout(() => setToast(null), 3500)
    },
    [],
  )

  const copyTextToClipboard = useCallback(
    async (text: string) => {
      const value = String(text ?? '')
      if (!value) return
      try {
        await navigator.clipboard.writeText(value)
        showToast('Copied to clipboard.')
        return
      } catch {
        // ignore
      }

      try {
        const el = document.createElement('textarea')
        el.value = value
        el.setAttribute('readonly', 'true')
        el.style.position = 'fixed'
        el.style.opacity = '0'
        el.style.left = '-9999px'
        document.body.appendChild(el)
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
        showToast('Copied to clipboard.')
      } catch {
        showToast('Failed to copy.', 'error')
      }
    },
    [showToast],
  )

  const [spineIndex, setSpineIndex] = useState(0)
  const [pageIndex, setPageIndex] = useState(0)
  const [srcDoc, setSrcDoc] = useState<string>('')
  const locationRef = useRef<StoredLocation>({
    spineIndex: 0,
    pageIndex: 0,
    scrollTop: 0,
  })
  const hudHideTimerRef = useRef<number | null>(null)
  const panelsOpenRef = useRef(false)
  const measureIframeRef = useRef<HTMLIFrameElement>(null)
  const measureLoadRef = useRef<{
    token: number
    resolve: (doc: Document) => void
    reject: (err: unknown) => void
  } | null>(null)
  const measureTokenRef = useRef(0)
  const [spinePageCounts, setSpinePageCounts] = useState<Array<number | null>>(
    [],
  )
  const spinePageCountsRef = useRef<Array<number | null>>([])

  const pendingNavRef = useRef<{
    pageIndex?: number
    scrollTop?: number
    chapterProgress?: number
    forSpineIndex?: number
    forChapterToken?: number
    fragment?: string
    behavior?: ScrollBehavior
    textOffset?: number
    consumeNavigationId?: string
  } | null>(null)
  const pendingVariantRestoreRef = useRef<{
    targetVariant: ReaderVariant
    spineIndex: number
    chapterProgress: number
  } | null>(null)
  const chapterLoadTokenRef = useRef(0)
  const requestedChapterTokenRef = useRef<number | null>(null)
  const loadedChapterTokenRef = useRef<number | null>(null)
  const appliedLayoutRef = useRef<AppliedLayout | null>(null)
  const iframeDocRef = useRef<Document | null>(null)
  const [iframeLoadCount, setIframeLoadCount] = useState(0)
  const [layoutRevision, setLayoutRevision] = useState(0)
  const suppressPersistTokenRef = useRef(0)
  const suppressPersistRef = useRef(false)
  const layoutRestoreRetryCountRef = useRef(0)

  panelsOpenRef.current =
    tocOpen || versionsOpen || settingsOpen || customizeOpen

  const hideHudLater = useCallback(() => {
    if (hudHideTimerRef.current) window.clearTimeout(hudHideTimerRef.current)
    hudHideTimerRef.current = window.setTimeout(() => {
      if (!panelsOpenRef.current) setHudActive(false)
    }, 3000)
  }, [])

  const showHud = useCallback(() => {
    setHudActive(true)
    hideHudLater()
  }, [hideHudLater])

  const goToHrefRef = useRef<(href: string, behavior?: ScrollBehavior) => void>(
    () => {},
  )
  const nextRef = useRef<() => void>(() => {})
  const prevRef = useRef<() => void>(() => {})
  const showHudRef = useRef<() => void>(() => {})

  const getChapterProgressSnapshot = useCallback(() => {
    const layout = appliedLayoutRef.current
    const currentSpineIndex = locationRef.current.spineIndex ?? spineIndex

    if (!layout) {
      return { spineIndex: currentSpineIndex, chapterProgress: 0 }
    }

    if (settingsRef.current.flowMode === 'scrolled') {
      const maxScroll = Math.max(
        0,
        layout.viewportEl.scrollHeight - layout.viewportEl.clientHeight,
      )
      const top = Math.max(0, layout.viewportEl.scrollTop)
      const chapterProgress = maxScroll > 0 ? clamp(top / maxScroll, 0, 1) : 0
      return { spineIndex: currentSpineIndex, chapterProgress }
    }

    const totalPages = Math.max(1, layout.totalPages)
    const denom = Math.max(1, totalPages - 1)
    const raw = layout.viewportEl.scrollLeft / Math.max(1, layout.pageWidth)
    const currentPageIndex = clamp(
      Math.round(raw),
      0,
      Math.max(0, totalPages - 1),
    )
    const chapterProgress = clamp(currentPageIndex / denom, 0, 1)
    return { spineIndex: currentSpineIndex, chapterProgress }
  }, [spineIndex])

    const startModernify = useCallback(async () => {
      const bookId = baseStorageId
      if (!bookId) return
      const key: ReaderVariant = 'modernify'
      if (transformStartInFlightRef.current[key]) return
      transformStartInFlightRef.current[key] = true
      // Optimistically mark as running so the UI reacts immediately.
      const optimisticNow = new Date().toISOString()
      setTransformStatuses((prev) => ({
        ...prev,
        [key]: {
          status: 'pending',
          dest_key: prev[key]?.dest_key ?? '',
          created_at: prev[key]?.created_at ?? optimisticNow,
          updated_at: optimisticNow,
        },
      }))
      try {
        const status = await startBookTransform(bookId, { type: 'modernify' })
        setTransformStatuses((prev) => ({
          ...prev,
          [key]: mergeTransformStatus(prev[key], status),
        }))
        if (status.status === 'error') {
          showToast(
            `Modernify failed: ${status.error ?? 'Unknown error'}`,
            'error',
          )
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start transform'
      showToast(`Modernify failed: ${message}`, 'error')
      setTransformStatuses((prev) => ({
        ...prev,
        [key]: { status: 'error', dest_key: '', error: message },
      }))
    } finally {
      transformStartInFlightRef.current[key] = false
    }
  }, [baseStorageId, showToast])

    const startTranslate = useCallback(
      async (langInput: string) => {
      const bookId = baseStorageId
      if (!bookId) return
      const normalizedLang = normalizeTranslateLangInput(langInput)
      if (!normalizedLang) {
        setTranslateLangError('Enter a language (≤ 60 chars).')
        return
      }

        setTranslateLangError(null)
        const key = translateVariantKeyFromLang(normalizedLang) as ReaderVariant
        if (transformStartInFlightRef.current[key]) return
        transformStartInFlightRef.current[key] = true
        // Optimistically mark as running so the UI reacts immediately.
        const optimisticNow = new Date().toISOString()
        setTransformStatuses((prev) => ({
          ...prev,
          [key]: {
            status: 'pending',
            dest_key: prev[key]?.dest_key ?? '',
            created_at: prev[key]?.created_at ?? optimisticNow,
            updated_at: optimisticNow,
          },
        }))
        try {
          const status = await startBookTransform(bookId, {
            type: 'translate',
            lang: normalizedLang,
          })
          setTransformStatuses((prev) => ({
            ...prev,
            [key]: mergeTransformStatus(prev[key], status),
          }))
          if (status.status === 'error') {
            showToast(
              `Translate failed: ${status.error ?? 'Unknown error'}`,
              'error',
            )
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to start transform'
        showToast(`Translate failed: ${message}`, 'error')
        setTransformStatuses((prev) => ({
          ...prev,
          [key]: { status: 'error', dest_key: '', error: message },
        }))
      } finally {
        transformStartInFlightRef.current[key] = false
      }
    },
      [baseStorageId, showToast],
    )

  const switchVariant = useCallback(
    (
      target: ReaderVariant,
      options?: { preserveChapterProgress?: boolean },
    ) => {
      if (variantRef.current === target) return
      if (target !== 'original') {
        const fromStatus =
          transformStatuses[target]?.status === 'ready'
            ? String(transformStatuses[target]?.url ?? '').trim()
            : ''
        const fromBook = String(transformationData?.[target]?.[0] ?? '').trim()
        const fromLegacy =
          target === 'modernify' ? String(transformedBookUrl ?? '').trim() : ''
        const resolved = fromStatus || fromBook || fromLegacy
        if (!resolved) return
      }

      if (options?.preserveChapterProgress) {
        const snap = getChapterProgressSnapshot()
        const persistenceId = persistenceIdRef.current
        if (persistenceId) {
          storeLocation(persistenceId, {
            ...locationRef.current,
            spineIndex: snap.spineIndex,
            chapterProgress: snap.chapterProgress,
          })
        }
        pendingVariantRestoreRef.current = {
          targetVariant: target,
          spineIndex: snap.spineIndex,
          chapterProgress: snap.chapterProgress,
        }
      } else {
        pendingVariantRestoreRef.current = null
      }

      setVariant(target)
    },
    [
      getChapterProgressSnapshot,
      transformStatuses,
      transformationData,
      transformedBookUrl,
    ],
  )

  const marginPx = useMemo(() => {
    switch (settings.marginSize) {
      case 'small':
        return { horizontal: 24, vertical: 48 }
      case 'large':
        return { horizontal: 100, vertical: 80 }
      default:
        return { horizontal: 60, vertical: 64 }
    }
  }, [settings.marginSize])

  const pageViewport = useMemo(() => {
    const availableWidth = Math.max(0, containerWidth - marginPx.horizontal * 2)
    const availableHeight = Math.max(0, containerHeight - marginPx.vertical * 2)
    // Limit max width for comfortable reading
    const maxWidth = 720
    const finalWidth = Math.min(availableWidth, maxWidth)
    return {
      width: Math.max(1, finalWidth),
      height: Math.max(1, availableHeight),
    }
  }, [containerWidth, containerHeight, marginPx])

  const hudVisible =
    hudActive || tocOpen || versionsOpen || settingsOpen || customizeOpen

  const displayPageNumber =
    settings.flowMode === 'paginated' ? pageIndex + 1 : 1

  const paginationKey = useMemo(() => {
    return [
      publication?.bookId ?? '',
      variant,
      settings.flowMode,
      settings.fontScale,
      settings.lineHeight,
      settings.columnGapPx,
      settings.fontFamily,
      settings.textAlign,
      settings.themePreset,
      settings.marginSize,
      pageViewport.width,
      pageViewport.height,
    ].join('|')
  }, [
    publication?.bookId,
    variant,
    settings.flowMode,
    settings.fontScale,
    settings.lineHeight,
    settings.columnGapPx,
    settings.fontFamily,
    settings.textAlign,
    settings.themePreset,
    settings.marginSize,
    pageViewport.width,
    pageViewport.height,
  ])

  const globalPageInfo = useMemo(() => {
    const spineCount = publication?.spine.length ?? 0
    if (!spineCount)
      return {
        current: displayPageNumber,
        total: null as number | null,
        readyForCurrent: true,
      }
    if (settings.flowMode !== 'paginated')
      return {
        current: 1,
        total: null as number | null,
        readyForCurrent: true,
      }

    const prefix = spinePageCounts.slice(0, spineIndex)
    const prefixKnown = prefix.every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n > 0,
    )
    const current = prefixKnown
      ? (prefix as number[]).reduce((a, b) => a + b, 0) + displayPageNumber
      : displayPageNumber

    const allKnown =
      spinePageCounts.length === spineCount &&
      spinePageCounts.every(
        (n) => typeof n === 'number' && Number.isFinite(n) && n > 0,
      )
    const total = allKnown
      ? (spinePageCounts as number[]).reduce((a, b) => a + b, 0)
      : null
    return {
      current: Math.max(1, current),
      total,
      readyForCurrent: prefixKnown,
    }
  }, [
    publication,
    spinePageCounts,
    spineIndex,
    displayPageNumber,
    settings.flowMode,
  ])

  const updateSettings = useCallback((next: Partial<EpubReaderV2Settings>) => {
    const merged = { ...settingsRef.current, ...next }
    settingsRef.current = merged
    setReaderSettings(merged)
  }, [])

  const applyThemePreset = useCallback(
    (preset: EpubReaderV2ThemePreset) => {
      const config = THEME_PRESETS[preset]
      updateSettings({
        themePreset: preset,
        theme: config.theme,
        fontFamily: config.fontFamily,
      })
    },
    [updateSettings],
  )

  const setLocation = useCallback(
    (next: {
      spineIndex: number
      pageIndex: number
      chapterTotalPages: number
      href: string
    }) => {
      const denom = Math.max(1, next.chapterTotalPages - 1)
      const chapterProgress = clamp(next.pageIndex / denom, 0, 1)
      locationRef.current = {
        spineIndex: next.spineIndex,
        pageIndex: next.pageIndex,
        scrollTop: 0,
        chapterProgress,
      }
      setSpineIndex(next.spineIndex)
      setPageIndex(next.pageIndex)
      const persistenceId = persistenceIdRef.current
      if (persistenceId) {
        storeLocation(persistenceId, {
          spineIndex: next.spineIndex,
          pageIndex: next.pageIndex,
          scrollTop: 0,
          chapterProgress,
        })
      }
      onLocationChangeRef.current?.({
        spineIndex: next.spineIndex,
        pageIndex: next.pageIndex,
        chapterTotalPages: next.chapterTotalPages,
        href: next.href,
      })
    },
    [],
  )

  const loadSpine = useCallback(
    async (
      nextSpineIndex: number,
      options?: {
        pageIndex?: number
        scrollTop?: number
        chapterProgress?: number
        fragment?: string
        behavior?: ScrollBehavior
        textOffset?: number
        consumeNavigationId?: string
      },
    ) => {
      const publication = publicationRef.current
      if (!publication) return
      const zip = zipRef.current
      const store = resourceStoreRef.current
      if (!zip || !store) return

      const item = publication.spine[nextSpineIndex]
      if (!item) return

      const token = ++chapterLoadTokenRef.current
      setStatus((s) =>
        s === 'downloading' || s === 'unpacking' || s === 'parsing'
          ? s
          : 'rendering',
      )
      requestedChapterTokenRef.current = token
      pendingNavRef.current = options
        ? {
            ...options,
            forSpineIndex: nextSpineIndex,
            forChapterToken: token,
          }
        : null
      try {
        const xhtmlText = await store.readText(item.href)
        const nextSrcDoc = await buildSpineItemSrcDoc({
          spineItemPath: item.href,
          xhtmlText,
          resourceStore: store,
        })
        if (token !== chapterLoadTokenRef.current) return
        setSrcDoc(nextSrcDoc)
        setSpineIndex(nextSpineIndex)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to render chapter'
        setError(message)
        setStatusWithNotify('error')
        onErrorRef.current?.(err)
      }
    },
    [activeBookUrl],
  )

  const setScrollLocation = useCallback(
    (next: {
      spineIndex: number
      scrollTop: number
      chapterProgress?: number
      href: string
    }) => {
      const chapterProgress =
        typeof next.chapterProgress === 'number' &&
        Number.isFinite(next.chapterProgress)
          ? clamp(next.chapterProgress, 0, 1)
          : undefined
      locationRef.current = {
        spineIndex: next.spineIndex,
        pageIndex: 0,
        scrollTop: next.scrollTop,
        chapterProgress,
      }
      setSpineIndex(next.spineIndex)
      setPageIndex(0)
      const persistenceId = persistenceIdRef.current
      if (persistenceId) {
        storeLocation(persistenceId, {
          spineIndex: next.spineIndex,
          pageIndex: 0,
          scrollTop: next.scrollTop,
          chapterProgress,
        })
      }
      onLocationChangeRef.current?.({
        spineIndex: next.spineIndex,
        pageIndex: 0,
        chapterTotalPages: 1,
        href: next.href,
      })
    },
    [],
  )

  const goToAnchorInCurrentDoc = useCallback(
    (fragment: string, behavior?: ScrollBehavior) => {
      const doc = iframeDocRef.current
      const layout = appliedLayoutRef.current
      if (!doc || !layout) return false

      const target =
        doc.getElementById(fragment) ||
        doc.querySelector(`[name="${CSS.escape(fragment)}"]`) ||
        doc.querySelector(`[id="${CSS.escape(fragment)}"]`)
      if (!target) return false
      const href = publication?.spine[spineIndex]?.href ?? ''
      if (settings.flowMode === 'scrolled') {
        target.scrollIntoView({
          behavior: behavior ?? 'auto',
          block: 'start',
        })
        setScrollLocation({
          spineIndex,
          scrollTop: layout.viewportEl.scrollTop,
          href,
        })
        return true
      }

      const nextPageIndex = findPageIndexForElement({
        layout,
        element: target,
      })
      scrollToPage({
        layout,
        pageIndex: nextPageIndex,
        behavior: behavior ?? 'auto',
      })
      setLocation({
        spineIndex,
        pageIndex: nextPageIndex,
        chapterTotalPages: layout.totalPages,
        href,
      })
      return true
    },
    [
      publication,
      spineIndex,
      settings.flowMode,
      setLocation,
      setScrollLocation,
    ],
  )

  const goToHref = useCallback(
    (href: string, behavior?: ScrollBehavior) => {
      if (!publication) return
      const currentSpinePath =
        publication.spine[spineIndex]?.href ?? publication.spine[0]?.href ?? ''
      const normalizedHref = href.trim()
      if (!normalizedHref) return

      const { path, fragment } = splitHref(normalizedHref)
      const rawPath = path
        ? normalizePath(path)
        : normalizePath(currentSpinePath)
      const isKnownRootPath =
        !path ||
        publication.spine.some((s) => normalizePath(s.href) === rawPath) ||
        publication.manifestByPath.has(rawPath)
      const resolvedPath = !path
        ? currentSpinePath
        : isKnownRootPath
          ? rawPath
          : resolveRelativePath(currentSpinePath, path)
      const targetPath = normalizePath(resolvedPath)

      if (targetPath === normalizePath(currentSpinePath)) {
        if (fragment) {
          if (!goToAnchorInCurrentDoc(fragment, behavior)) return
        }
        return
      }

      const nextSpineIndex = publication.spine.findIndex(
        (s) => normalizePath(s.href) === targetPath,
      )
      if (nextSpineIndex === -1) return
      loadSpine(nextSpineIndex, {
        pageIndex: 0,
        fragment: fragment ?? undefined,
        behavior,
      })
      setTocOpen(false)
      setSettingsOpen(false)
    },
    [publication, spineIndex, goToAnchorInCurrentDoc, loadSpine],
  )

  const goToPage = useCallback(
    (nextPageIndex: number, behavior?: ScrollBehavior) => {
      const layout = appliedLayoutRef.current
      if (!layout) return
      const next = clamp(nextPageIndex, 0, layout.totalPages - 1)
      scrollToPage({ layout, pageIndex: next, behavior: behavior ?? 'auto' })
      const href = publication?.spine[spineIndex]?.href ?? ''
      setLocation({
        spineIndex,
        pageIndex: next,
        chapterTotalPages: layout.totalPages,
        href,
      })
    },
    [publication, spineIndex, pageIndex, setLocation],
  )

  const findTextPositionAtOffset = useCallback(
    (doc: Document, offset: number) => {
      const body = doc.body
      if (!body) return null
      const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      let remaining = Math.max(0, Math.floor(offset))
      let lastText: Text | null = null
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        lastText = node
        const len = node.nodeValue?.length ?? 0
        if (remaining <= len) {
          return { node, offset: remaining }
        }
        remaining -= len
      }
      if (lastText) {
        const len = lastText.nodeValue?.length ?? 0
        return { node: lastText, offset: len }
      }
      return null
    },
    [],
  )

  const goToTextOffsetInCurrentDoc = useCallback(
    (textOffset: number, behavior?: ScrollBehavior) => {
      const doc = iframeDocRef.current
      const layout = appliedLayoutRef.current
      if (!doc || !layout) return false

      const pos = findTextPositionAtOffset(doc, textOffset)
      if (!pos) return false

      const el = (pos.node.parentElement ?? doc.body) as Element | null
      if (!el) return false

      const href = publication?.spine[spineIndex]?.href ?? ''

      if (settings.flowMode === 'scrolled') {
        const viewportRect = layout.viewportEl.getBoundingClientRect()
        const rect = (el as HTMLElement).getBoundingClientRect()
        const targetTop =
          rect.top - viewportRect.top + layout.viewportEl.scrollTop
        layout.viewportEl.scrollTo({
          left: 0,
          top: Math.max(0, targetTop),
          behavior: behavior ?? 'auto',
        })
        setScrollLocation({
          spineIndex,
          scrollTop: layout.viewportEl.scrollTop,
          href,
        })
        return true
      }

      const chapterPageIndex = findPageIndexForElement({
        layout,
        element: el,
      })
      scrollToPage({
        layout,
        pageIndex: chapterPageIndex,
        behavior: behavior ?? 'auto',
      })
      setLocation({
        spineIndex,
        pageIndex: chapterPageIndex,
        chapterTotalPages: layout.totalPages,
        href,
      })
      return true
    },
    [
      publication,
      spineIndex,
      settings.flowMode,
      findTextPositionAtOffset,
      setLocation,
      setScrollLocation,
    ],
  )

  const next = useCallback(() => {
    const layout = appliedLayoutRef.current
    if (!publication || !layout) return

    if (settings.flowMode === 'scrolled') {
      const { viewportEl } = layout
      const remaining =
        viewportEl.scrollHeight - viewportEl.clientHeight - viewportEl.scrollTop
      if (remaining > 2) {
        viewportEl.scrollBy({
          top: viewportEl.clientHeight * 0.9,
          behavior: 'auto',
        })
        return
      }
      const nextSpine = spineIndex + 1
      if (nextSpine < publication.spine.length)
        loadSpine(nextSpine, { pageIndex: 0, behavior: 'auto' })
      return
    }

    if (pageIndex + 1 < layout.totalPages) {
      goToPage(pageIndex + 1)
      return
    }
    const nextSpine = spineIndex + 1
    if (nextSpine < publication.spine.length)
      loadSpine(nextSpine, { pageIndex: 0, behavior: 'auto' })
  }, [
    publication,
    settings.flowMode,
    spineIndex,
    pageIndex,
    goToPage,
    loadSpine,
  ])

  const prev = useCallback(() => {
    const layout = appliedLayoutRef.current
    if (!publication || !layout) return

    if (settings.flowMode === 'scrolled') {
      const { viewportEl } = layout
      if (viewportEl.scrollTop > 2) {
        viewportEl.scrollBy({
          top: -viewportEl.clientHeight * 0.9,
          behavior: 'auto',
        })
        return
      }
      const prevSpine = spineIndex - 1
      if (prevSpine >= 0)
        loadSpine(prevSpine, { pageIndex: 0, behavior: 'auto' })
      return
    }

    if (pageIndex > 0) {
      goToPage(pageIndex - 1)
      return
    }
    const prevSpine = spineIndex - 1
    if (prevSpine >= 0)
      loadSpine(prevSpine, { pageIndex: 1_000_000, behavior: 'auto' })
  }, [
    publication,
    settings.flowMode,
    spineIndex,
    pageIndex,
    goToPage,
    loadSpine,
  ])

  goToHrefRef.current = goToHref
  nextRef.current = next
  prevRef.current = prev
  showHudRef.current = showHud

  useImperativeHandle(
    ref,
    () => ({
      next,
      prev,
      goToHref,
      setSettings: updateSettings,
      getSettings: () => settings,
      getVisiblePage: () => {
        const pub = publicationRef.current
        const doc = iframeDocRef.current
        const layout = appliedLayoutRef.current
        if (!pub || !doc || !layout) return null

        const loc = locationRef.current
        const spineIndex = clamp(
          loc?.spineIndex ?? 0,
          0,
          Math.max(0, pub.spine.length - 1),
        )
        const href = String(pub.spine[spineIndex]?.href ?? '').trim()

        const flowMode = settingsRef.current.flowMode
        const chapterTotalPages =
          flowMode === 'paginated' ? layout.totalPages : 1

        const rawPageIndex =
          flowMode === 'paginated'
            ? layout.viewportEl.scrollLeft / Math.max(1, layout.pageWidth)
            : 0
        const pageIndex =
          flowMode === 'paginated'
            ? clamp(
                Math.round(rawPageIndex),
                0,
                Math.max(0, layout.totalPages - 1),
              )
            : 0

        const text = extractVisibleText({
          doc,
          layout,
          flowMode,
          pageIndex,
          maxChars: 2400,
        })

        return {
          href,
          spineIndex,
          pageIndex,
          chapterTotalPages,
          text,
        }
      },
    }),
    [next, prev, goToHref, updateSettings, settings],
  )

  const handleIframeLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    iframeDocRef.current = doc
    setIframeLoadCount((c) => c + 1)
    setStatus((s) => (s === 'rendering' ? 'ready' : s))
    loadedChapterTokenRef.current = requestedChapterTokenRef.current
  }, [spineIndex])

  useEffect(() => {
    const doc = iframeDocRef.current
    if (!doc) return

    let cancelled = false
    const trigger = () => {
      if (cancelled) return
      setLayoutRevision((r) => r + 1)
    }

    const timers = [
      window.setTimeout(trigger, 200),
      window.setTimeout(trigger, 900),
    ]

    const imageHandlers = new Map<
      HTMLImageElement,
      { load: () => void; error: () => void }
    >()
    const imgs = Array.from(doc.images ?? []).filter((img) => !img.complete)
    for (const img of imgs) {
      const onLoad = () => trigger()
      const onError = () => trigger()
      imageHandlers.set(img, { load: onLoad, error: onError })
      img.addEventListener('load', onLoad)
      img.addEventListener('error', onError)
    }

    try {
      const fonts: any = (doc as any).fonts
      if (fonts?.ready && typeof fonts.ready.then === 'function') {
        fonts.ready.then(() => trigger()).catch(() => undefined)
      }
    } catch {
      // ignore
    }

    return () => {
      cancelled = true
      for (const timer of timers) window.clearTimeout(timer)
      for (const [img, handlers] of imageHandlers) {
        img.removeEventListener('load', handlers.load)
        img.removeEventListener('error', handlers.error)
      }
    }
  }, [iframeLoadCount])

  useLayoutEffect(() => {
    const doc = iframeDocRef.current
    if (!doc) return

    try {
      const bootstrapToken = bootstrapTokenRef.current
      const suppressToken = ++suppressPersistTokenRef.current
      suppressPersistRef.current = true

      const layout = applyReaderLayout({
        doc,
        viewportWidth: pageViewport.width,
        viewportHeight: pageViewport.height,
        settings,
      })
      appliedLayoutRef.current = layout

      const releaseAfterScrollSettles = () => {
        let attempts = 0
        const waitForScroll = () => {
          if (suppressPersistTokenRef.current !== suppressToken) return
          attempts++
          if (attempts > 60) {
            suppressPersistRef.current = false
            if (bootstrapTokenRef.current === bootstrapToken)
              setIsBootstrappingView(false)
            return
          }
          const currentLayout = appliedLayoutRef.current
          if (
            !currentLayout ||
            currentLayout.viewportEl !== layout.viewportEl
          ) {
            suppressPersistRef.current = false
            if (bootstrapTokenRef.current === bootstrapToken)
              setIsBootstrappingView(false)
            return
          }

          if (settings.flowMode === 'scrolled') {
            const expected = Math.max(0, locationRef.current.scrollTop ?? 0)
            if (Math.abs(layout.viewportEl.scrollTop - expected) < 1) {
              suppressPersistRef.current = false
              if (bootstrapTokenRef.current === bootstrapToken)
                setIsBootstrappingView(false)
              return
            }
            window.requestAnimationFrame(waitForScroll)
            return
          }

          const expected =
            Math.max(0, locationRef.current.pageIndex) * currentLayout.pageWidth
          if (Math.abs(layout.viewportEl.scrollLeft - expected) < 2) {
            suppressPersistRef.current = false
            if (bootstrapTokenRef.current === bootstrapToken)
              setIsBootstrappingView(false)
            return
          }
          window.requestAnimationFrame(waitForScroll)
        }

        window.requestAnimationFrame(waitForScroll)
      }

      if (settings.flowMode === 'paginated') {
        const pub = publicationRef.current
        if (pub) {
          const index = spineIndex
          setSpinePageCounts((prev) => {
            if (prev.length !== pub.spine.length) return prev
            if (prev[index] === layout.totalPages) return prev
            const next = prev.slice()
            next[index] = layout.totalPages
            spinePageCountsRef.current = next
            return next
          })
        }
      }

      const pending = pendingNavRef.current
      const loadedToken = loadedChapterTokenRef.current
      const pendingToken = pending?.forChapterToken
      const pendingSpineIndex = pending?.forSpineIndex

      const shouldDeferForToken =
        pendingToken != null &&
        (loadedToken == null || pendingToken !== loadedToken)
      const shouldDeferForSpineIndex =
        pendingSpineIndex != null &&
        Number.isFinite(pendingSpineIndex) &&
        pendingSpineIndex !== spineIndex

      if (pending && (shouldDeferForToken || shouldDeferForSpineIndex)) {
        // Wait for the correct chapter iframe to load before applying pending nav,
        // otherwise we can accidentally consume it against the previous iframe doc.
        return
      }

      const effectivePending = pending

      if (effectivePending?.fragment) {
        const ok = goToAnchorInCurrentDoc(
          effectivePending.fragment,
          effectivePending.behavior,
        )
        if (ok) {
          if (effectivePending.consumeNavigationId) {
            onConsumePendingNavigationRef.current?.(
              effectivePending.consumeNavigationId,
            )
          }
          pendingNavRef.current = null
          releaseAfterScrollSettles()
          return
        }
      }

      if (
        typeof effectivePending?.textOffset === 'number' &&
        Number.isFinite(effectivePending.textOffset)
      ) {
        const ok = goToTextOffsetInCurrentDoc(
          effectivePending.textOffset,
          effectivePending.behavior,
        )
        if (ok) {
          if (effectivePending.consumeNavigationId) {
            onConsumePendingNavigationRef.current?.(
              effectivePending.consumeNavigationId,
            )
          }
          pendingNavRef.current = null
          releaseAfterScrollSettles()
          return
        }
      }

      const href = publication?.spine[spineIndex]?.href ?? ''
      if (settings.flowMode === 'scrolled') {
        let desiredScrollTop =
          effectivePending?.scrollTop ?? locationRef.current.scrollTop ?? 0
        const hasExplicitScrollTop =
          typeof effectivePending?.scrollTop === 'number' &&
          Number.isFinite(effectivePending.scrollTop)
        const chapterProgressToUse =
          typeof effectivePending?.chapterProgress === 'number' &&
          Number.isFinite(effectivePending.chapterProgress)
            ? clamp(effectivePending.chapterProgress, 0, 1)
            : !hasExplicitScrollTop &&
                typeof locationRef.current.chapterProgress === 'number' &&
                Number.isFinite(locationRef.current.chapterProgress)
              ? clamp(locationRef.current.chapterProgress, 0, 1)
              : undefined
        if (typeof chapterProgressToUse === 'number') {
          const maxScroll = Math.max(
            0,
            layout.viewportEl.scrollHeight - layout.viewportEl.clientHeight,
          )
          if (maxScroll <= 0 && chapterProgressToUse > 0) {
            layoutRestoreRetryCountRef.current++
            if (layoutRestoreRetryCountRef.current < 10) {
              window.setTimeout(() => {
                if (suppressPersistTokenRef.current !== suppressToken) return
                setLayoutRevision((r) => r + 1)
              }, 50)
            }
            return
          }
          desiredScrollTop = chapterProgressToUse * maxScroll
        }
        layoutRestoreRetryCountRef.current = 0
        layout.viewportEl.scrollTo({
          left: 0,
          top: Math.max(0, desiredScrollTop),
          behavior: effectivePending?.behavior ?? 'auto',
        })
        setScrollLocation({
          spineIndex,
          scrollTop: layout.viewportEl.scrollTop,
          chapterProgress: chapterProgressToUse,
          href,
        })
        if (effectivePending?.consumeNavigationId) {
          onConsumePendingNavigationRef.current?.(
            effectivePending.consumeNavigationId,
          )
        }
        pendingNavRef.current = null
        releaseAfterScrollSettles()
        return
      }

      let desiredPageIndex =
        effectivePending?.pageIndex ?? locationRef.current.pageIndex
      const hasExplicitPageIndex =
        typeof effectivePending?.pageIndex === 'number' &&
        Number.isFinite(effectivePending.pageIndex)
      const chapterProgressToUse =
        typeof effectivePending?.chapterProgress === 'number' &&
        Number.isFinite(effectivePending.chapterProgress)
          ? clamp(effectivePending.chapterProgress, 0, 1)
          : !hasExplicitPageIndex &&
              typeof locationRef.current.chapterProgress === 'number' &&
              Number.isFinite(locationRef.current.chapterProgress)
            ? clamp(locationRef.current.chapterProgress, 0, 1)
            : undefined
      if (typeof chapterProgressToUse === 'number') {
        const denom = Math.max(1, layout.totalPages - 1)
        desiredPageIndex = Math.round(chapterProgressToUse * denom)
      }
      const shouldRetryPagination =
        layout.totalPages <= 1 &&
        (desiredPageIndex > 0 ||
          (typeof chapterProgressToUse === 'number' &&
            chapterProgressToUse > 0))
      if (shouldRetryPagination) {
        layoutRestoreRetryCountRef.current++
        if (layoutRestoreRetryCountRef.current < 10) {
          window.setTimeout(() => {
            if (suppressPersistTokenRef.current !== suppressToken) return
            setLayoutRevision((r) => r + 1)
          }, 50)
        }
        return
      }
      layoutRestoreRetryCountRef.current = 0

      const nextPageIndex = clamp(desiredPageIndex, 0, layout.totalPages - 1)
      scrollToPage({
        layout,
        pageIndex: nextPageIndex,
        behavior: effectivePending?.behavior ?? 'auto',
      })
      setLocation({
        spineIndex,
        pageIndex: nextPageIndex,
        chapterTotalPages: layout.totalPages,
        href,
      })
      if (effectivePending?.consumeNavigationId) {
        onConsumePendingNavigationRef.current?.(
          effectivePending.consumeNavigationId,
        )
      }
      pendingNavRef.current = null
      releaseAfterScrollSettles()
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to apply layout'
      setError(message)
      setStatusWithNotify('error')
      setIsBootstrappingView(false)
      onErrorRef.current?.(err)
    }
  }, [
    iframeLoadCount,
    layoutRevision,
    pageViewport.width,
    pageViewport.height,
    settings,
    publication,
    spineIndex,
    goToAnchorInCurrentDoc,
    goToTextOffsetInCurrentDoc,
    setLocation,
    setScrollLocation,
  ])

  useEffect(() => {
    const layout = appliedLayoutRef.current
    const persistenceId = persistenceIdRef.current
    if (!layout || !persistenceId) return
    if (settings.flowMode !== 'scrolled') return
    // Only persist scroll changes after initial load is complete
    if (status !== 'ready') return

    const { viewportEl } = layout
    let rafId = 0
    let last = locationRef.current.scrollTop ?? 0

    const persist = () => {
      rafId = 0
      if (suppressPersistRef.current) return
      const persistenceId = persistenceIdRef.current
      const layout = appliedLayoutRef.current
      if (!persistenceId || !layout || layout.viewportEl !== viewportEl) return
      const top = viewportEl.scrollTop
      if (Math.abs(top - last) < 1) return
      last = top
      const maxScroll = Math.max(
        0,
        viewportEl.scrollHeight - viewportEl.clientHeight,
      )
      const chapterProgress = maxScroll > 0 ? clamp(top / maxScroll, 0, 1) : 0
      locationRef.current = {
        spineIndex,
        pageIndex: 0,
        scrollTop: top,
        chapterProgress,
      }
      storeLocation(persistenceId, {
        spineIndex,
        pageIndex: 0,
        scrollTop: top,
        chapterProgress,
      })
    }

    const onScroll = () => {
      if (rafId) return
      rafId = window.requestAnimationFrame(persist)
    }

    viewportEl.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId)
      viewportEl.removeEventListener('scroll', onScroll)
    }
  }, [iframeLoadCount, settings.flowMode, spineIndex, status])

  useEffect(() => {
    const layout = appliedLayoutRef.current
    const persistenceId = persistenceIdRef.current
    if (!layout || !persistenceId) return
    if (settings.flowMode !== 'paginated') return
    // Only persist scroll changes after initial load is complete
    if (status !== 'ready') return

    const { viewportEl } = layout
    let rafId = 0
    let last = locationRef.current.pageIndex

    const persist = () => {
      rafId = 0
      if (suppressPersistRef.current) return
      if (locationRef.current.pageIndex !== last)
        last = locationRef.current.pageIndex
      const persistenceId = persistenceIdRef.current
      const layout = appliedLayoutRef.current
      if (!persistenceId || !layout || layout.viewportEl !== viewportEl) return
      const { pageWidth, totalPages } = layout
      const raw = viewportEl.scrollLeft / pageWidth
      const page = clamp(Math.round(raw), 0, Math.max(0, totalPages - 1))
      if (page === last) return
      last = page
      const denom = Math.max(1, totalPages - 1)
      const chapterProgress = clamp(page / denom, 0, 1)

      locationRef.current = {
        spineIndex,
        pageIndex: page,
        scrollTop: 0,
        chapterProgress,
      }
      setPageIndex(page)
      storeLocation(persistenceId, {
        spineIndex,
        pageIndex: page,
        scrollTop: 0,
        chapterProgress,
      })
    }

    const onScroll = () => {
      if (rafId) return
      rafId = window.requestAnimationFrame(persist)
    }

    viewportEl.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId)
      viewportEl.removeEventListener('scroll', onScroll)
    }
  }, [iframeLoadCount, settings.flowMode, spineIndex, status])

  useEffect(() => {
    const pub = publicationRef.current
    const store = resourceStoreRef.current
    const measureIframe = measureIframeRef.current
    if (!pub || !store || !measureIframe) return
    if (settings.flowMode !== 'paginated') return
    if (!pageViewport.width || !pageViewport.height) return

    let cancelled = false
    const token = ++measureTokenRef.current

    // Reset page counts when pagination settings change
    const blank = new Array(pub.spine.length).fill(null) as Array<number | null>
    spinePageCountsRef.current = blank
    setSpinePageCounts(blank)

    const requestDoc = (srcdoc: string): Promise<Document> => {
      return new Promise((resolve, reject) => {
        if (cancelled) {
          reject(new Error('Cancelled'))
          return
        }
        if (measureLoadRef.current) {
          measureLoadRef.current.reject(new Error('Superseded'))
          measureLoadRef.current = null
        }
        measureLoadRef.current = { token, resolve, reject }
        measureIframe.srcdoc = srcdoc
        window.setTimeout(() => {
          if (measureLoadRef.current?.token === token) {
            measureLoadRef.current.reject(
              new Error('Measure iframe load timeout'),
            )
            measureLoadRef.current = null
          }
        }, 15_000)
      })
    }

    const nextFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const waitForSettledLayout = async (doc: Document) => {
      await nextFrame()
      await nextFrame()
      try {
        const fonts: any = (doc as any).fonts
        if (fonts?.ready)
          await Promise.race([
            fonts.ready,
            new Promise((r) => setTimeout(r, 2500)),
          ])
      } catch {
        // ignore
      }
      const imgs = Array.from(doc.images ?? [])
      const pending = imgs.filter((img) => !img.complete)
      if (pending.length) {
        await Promise.race([
          Promise.allSettled(
            pending.map(
              (img) =>
                new Promise<void>((resolve) => {
                  const done = () => resolve()
                  img.addEventListener('load', done, { once: true })
                  img.addEventListener('error', done, { once: true })
                }),
            ),
          ),
          new Promise((r) => setTimeout(r, 3000)),
        ])
      }
      await nextFrame()
    }

    const schedule = (): Promise<void> => {
      if (typeof (window as any).requestIdleCallback === 'function') {
        return new Promise((resolve) =>
          (window as any).requestIdleCallback(() => resolve(), {
            timeout: 250,
          }),
        )
      }
      return new Promise((resolve) => window.setTimeout(resolve, 0))
    }

    const run = async () => {
      const spineCount = pub.spine.length
      for (let i = 0; i < spineCount; i++) {
        if (cancelled) return
        if (measureTokenRef.current !== token) return
        if (spinePageCountsRef.current[i] != null) continue

        await schedule()
        if (cancelled) return

        try {
          const item = pub.spine[i]
          const xhtmlText = await store.readText(item.href)
          const srcdoc = await buildSpineItemSrcDoc({
            spineItemPath: item.href,
            xhtmlText,
            resourceStore: store,
          })
          const doc = await requestDoc(srcdoc)
          if (cancelled) return
          await waitForSettledLayout(doc)
          if (cancelled) return

          const layout = applyReaderLayout({
            doc,
            viewportWidth: pageViewport.width,
            viewportHeight: pageViewport.height,
            settings,
          })
          const pages = Math.max(1, layout.totalPages)
          if (cancelled) return

          setSpinePageCounts((prev) => {
            if (prev.length !== spineCount) return prev
            if (prev[i] === pages) return prev
            const next = prev.slice()
            next[i] = pages
            spinePageCountsRef.current = next
            return next
          })
        } catch {
          // Ignore individual failures; keep measuring others.
        }
      }
    }

    run()

    return () => {
      cancelled = true
      if (measureLoadRef.current?.token === token) {
        measureLoadRef.current.reject(new Error('Cancelled'))
        measureLoadRef.current = null
      }
    }
  }, [paginationKey])

  useLayoutEffect(() => {
    const doc = iframeDocRef.current
    if (!doc) return

    const win = doc.defaultView
    if (!win) return

    const getChapterTitle = () => {
      const pub = publicationRef.current
      if (!pub) return null
      const href = pub.spine[spineIndex]?.href ?? ''
      if (!href) return null
      const normalizedHref = normalizePath(splitHref(href).path)
      const tocFlat = flattenToc(pub.toc ?? [])
      const item = tocFlat.find(
        ({ item }) =>
          normalizePath(splitHref(item.href).path) === normalizedHref,
      )?.item
      const title = (item?.title ?? '').trim()
      return title || null
    }

    const getSelectionPayload = (): ReaderSelectionPayload | null => {
      const selection = win.getSelection?.()
      if (!selection || selection.isCollapsed) {
        return null
      }

      const layout = appliedLayoutRef.current

      let startEl: Element | null = null
      let endEl: Element | null = null
      let rawStartIndex = 0
      let rawEndIndex = 0
      const selectedText = selection.toString()
      try {
        const range = selection.getRangeAt(0)
        const startNode = range.startContainer
        const endNode = range.endContainer
        startEl =
          (startNode.nodeType === Node.ELEMENT_NODE
            ? (startNode as Element)
            : startNode.parentElement) ?? null
        endEl =
          (endNode.nodeType === Node.ELEMENT_NODE
            ? (endNode as Element)
            : endNode.parentElement) ?? null

        const body = doc.body
        if (body) {
          const beforeStart = doc.createRange()
          beforeStart.setStart(body, 0)
          beforeStart.setEnd(range.startContainer, range.startOffset)
          rawStartIndex = beforeStart.toString().length

          const beforeEnd = doc.createRange()
          beforeEnd.setStart(body, 0)
          beforeEnd.setEnd(range.endContainer, range.endOffset)
          rawEndIndex = beforeEnd.toString().length
        }
      } catch {
        // ignore
      }
      const startIndex = Math.min(rawStartIndex, rawEndIndex)
      const endIndex = Math.max(rawStartIndex, rawEndIndex)
      const safeStart = startEl ?? doc.body ?? doc.documentElement
      const safeEnd = endEl ?? doc.body ?? doc.documentElement

      const chapterTitle = getChapterTitle()
      const baseBookId = baseStorageId || publicationRef.current?.bookId || ''
      const bookId = baseBookId
        ? toVersionedBookId(baseBookId, variantRef.current)
        : ''
      const baseTitle =
        (publicationRef.current?.title ?? '').trim() || chapterTitle || 'Book'
      const bookTitle = bookTitleWithVariant(baseTitle, variantRef.current)

      const chapterStart =
        layout && settingsRef.current.flowMode === 'paginated'
          ? findPageIndexForElement({
              layout,
              element: safeStart,
            }) + 1
          : 1
      const chapterEnd =
        layout && settingsRef.current.flowMode === 'paginated'
          ? findPageIndexForElement({ layout, element: safeEnd }) + 1
          : 1
      const startPage = Math.min(chapterStart, chapterEnd)
      const endPage = Math.max(chapterStart, chapterEnd)

      const prefix = spinePageCountsRef.current.slice(0, spineIndex)
      const prefixKnown = prefix.every(
        (n) => typeof n === 'number' && Number.isFinite(n) && n > 0,
      )
      if (prefixKnown) {
        const base = (prefix as Array<number>).reduce((a, b) => a + b, 0)
        return {
          bookId,
          bookTitle,
          spineIndex,
          startPage: base + startPage,
          startIndex,
          endPage: base + endPage,
          endIndex,
          selectedText,
        }
      }

      return {
        bookId,
        bookTitle,
        spineIndex,
        startPage,
        startIndex,
        endPage,
        endIndex,
        selectedText,
      }
    }

    const publishSelection = () => {
      const cb = onSelectionChangeRef.current
      if (!cb) return null
      const payload = getSelectionPayload()
      cb(payload)
      return payload
    }

    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      const target = event.target as Element | null
      if (!target) return

      const anchor = target.closest('a[href]') as HTMLAnchorElement | null
      if (anchor) {
        const rawHref = (anchor.getAttribute('href') ?? '').trim()
        if (!rawHref || rawHref === '#') {
          event.preventDefault()
          return
        }
        if (
          /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(rawHref) &&
          !rawHref.toLowerCase().startsWith('epubcfi(')
        ) {
          event.preventDefault()
          return
        }
        event.preventDefault()
        showHudRef.current()
        goToHrefRef.current(rawHref, 'auto')
        return
      }

      const selection = win.getSelection?.()
      if (selection && !selection.isCollapsed) {
        publishSelection()
        return
      }

      // Just show/hide HUD on click, don't navigate
      onSelectionChangeRef.current?.(null)
      showHudRef.current()
    }

    const handleContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()

      const payload = getSelectionPayload()
      contextMenuSelectionRef.current = payload
      flushSync(() => {
        setContextMenuSelectionText(payload?.selectedText ?? '')
      })
      onSelectionChangeRef.current?.(payload)

      const triggerEl = contextMenuTriggerRef.current
      if (!triggerEl) return
      const iframeRect = iframeRef.current?.getBoundingClientRect()
      const clientX = (iframeRect?.left ?? 0) + event.clientX
      const clientY = (iframeRect?.top ?? 0) + event.clientY
      triggerEl.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        }),
      )
    }

    const handleMouseMove = () => showHudRef.current()

    let pointerStart: { x: number; y: number; t: number } | null = null
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      pointerStart = {
        x: event.clientX,
        y: event.clientY,
        t: performance.now(),
      }
    }
    const handlePointerUp = (event: PointerEvent) => {
      if (!pointerStart) return
      const dx = event.clientX - pointerStart.x
      const dy = event.clientY - pointerStart.y
      const dt = performance.now() - pointerStart.t
      pointerStart = null

      const selection = win.getSelection?.()
      if (selection && !selection.isCollapsed) {
        publishSelection()
        return
      }

      const absDx = Math.abs(dx)
      const absDy = Math.abs(dy)
      if (absDx < 40 || absDx < absDy || dt > 600) return

      if (dx < 0) nextRef.current()
      else prevRef.current()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (
        event.key === 'ArrowRight' ||
        event.key === 'PageDown' ||
        event.key === ' '
      ) {
        event.preventDefault()
        showHudRef.current()
        nextRef.current()
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        showHudRef.current()
        prevRef.current()
        return
      }
      if (event.key === 'Escape') {
        setTocOpen(false)
        setVersionsOpen(false)
        setSettingsOpen(false)
        setCustomizeOpen(false)
        setHudActive(false)
      }
    }

    doc.addEventListener('click', handleClick, true)
    doc.addEventListener('contextmenu', handleContextMenu, true)
    doc.addEventListener('mousemove', handleMouseMove)
    doc.addEventListener('pointerdown', handlePointerDown, { capture: true })
    doc.addEventListener('pointerup', handlePointerUp, { capture: true })
    doc.addEventListener('keydown', handleKeyDown, true)
    return () => {
      doc.removeEventListener('click', handleClick, true)
      doc.removeEventListener('contextmenu', handleContextMenu, true)
      doc.removeEventListener('mousemove', handleMouseMove)
      doc.removeEventListener('pointerdown', handlePointerDown as any, true)
      doc.removeEventListener('pointerup', handlePointerUp as any, true)
      doc.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [iframeLoadCount])

  const authHeadersKey = useMemo(() => {
    if (!authHeaders) return ''
    return Object.entries(authHeaders)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join('\n')
  }, [authHeaders])

  useEffect(() => {
    return () => {
      if (hudHideTimerRef.current) window.clearTimeout(hudHideTimerRef.current)
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
      if (measureLoadRef.current) {
        measureLoadRef.current.reject(new Error('Unmounted'))
        measureLoadRef.current = null
      }
      resourceStoreRef.current?.revokeAll()
      resourceStoreRef.current = null
      zipRef.current?.dispose()
      zipRef.current = null
      publicationRef.current = null
      spinePageCountsRef.current = []
      if (measureIframeRef.current) {
        try {
          measureIframeRef.current.srcdoc = ''
        } catch {
          // ignore
        }
      }
    }
  }, [])

  useEffect(() => {
    if (!activeBookUrl) return

    let alive = true
    const abort = new AbortController()

    bootstrapTokenRef.current++
    setIsBootstrappingView(true)

    setStatusWithNotify('downloading')
    setError(null)
    setProgress({ loadedBytes: 0, totalBytes: undefined })
    setPublication(null)
    publicationRef.current = null
    persistenceIdRef.current = null
    setSpinePageCounts([])
    spinePageCountsRef.current = []
    setSrcDoc('')
    setSpineIndex(0)
    setPageIndex(0)
    locationRef.current = { spineIndex: 0, pageIndex: 0, scrollTop: 0 }
    appliedLayoutRef.current = null
    iframeDocRef.current = null
    pendingNavRef.current = null
    requestedChapterTokenRef.current = null
    loadedChapterTokenRef.current = null
    chapterLoadTokenRef.current = 0
    layoutRestoreRetryCountRef.current = 0

    resourceStoreRef.current?.revokeAll()
    resourceStoreRef.current = null
    zipRef.current?.dispose()
    zipRef.current = null
    ;(async () => {
      try {
        const epubBuffer = await fetchArrayBufferWithProgress({
          url: activeBookUrl,
          headers: authHeaders,
          signal: abort.signal,
          onProgress: (p) => alive && setProgress(p),
        })
        if (!alive) return
        setStatusWithNotify('unpacking')

        const zip = new ZipWorkerClient()
        zipRef.current = zip
        const availablePaths = await zip.load(epubBuffer)
        if (!alive) return

        setStatusWithNotify('parsing')
        const pub = await loadEpubPublication(zip, activeBookUrl)
        if (!alive) return
        setPublication(pub)
        publicationRef.current = pub
        const blank = new Array(pub.spine.length).fill(null) as Array<
          number | null
        >
        spinePageCountsRef.current = blank
        setSpinePageCounts(blank)

        const mediaTypeByPath = new Map<string, string>()
        for (const [path, v] of pub.manifestByPath.entries())
          mediaTypeByPath.set(path, v.mediaType)
        const store = new EpubResourceStore({
          zip,
          mediaTypeByPath,
          availablePaths,
        })
        resourceStoreRef.current = store

        onReadyRef.current?.({
          bookId: pub.bookId,
          title: pub.title,
          author: pub.author,
          language: pub.language,
          publisher: pub.publisher,
          description: pub.description,
          subjects: pub.subjects,
          date: pub.date,
          identifier: pub.identifier,
          modified: pub.modified,
          spineItemCount: pub.spine.length,
          rendition: pub.rendition,
        })

        const persistenceId = baseStorageId || pub.bookId || ''
        persistenceIdRef.current = persistenceId
        const pendingVariantRestore = pendingVariantRestoreRef.current
        if (
          pendingVariantRestore &&
          pendingVariantRestore.targetVariant === variant
        ) {
          const initialSpine = clamp(
            pendingVariantRestore.spineIndex,
            0,
            Math.max(0, pub.spine.length - 1),
          )
          locationRef.current = {
            spineIndex: initialSpine,
            pageIndex: 0,
            scrollTop: 0,
            chapterProgress: pendingVariantRestore.chapterProgress,
          }
          pendingVariantRestoreRef.current = null
          await loadSpine(initialSpine, {
            chapterProgress: pendingVariantRestore.chapterProgress,
            behavior: 'auto',
          })
        } else {
          let stored = persistenceId ? loadStoredLocation(persistenceId) : null
          if (!stored && baseStorageId) {
            stored =
              loadStoredLocation(
                toVersionedBookId(baseStorageId, 'modernify'),
              ) ??
              loadStoredLocation(toVersionedBookId(baseStorageId, 'original'))
          }
          const initialSpine = clamp(
            stored?.spineIndex ?? 0,
            0,
            Math.max(0, pub.spine.length - 1),
          )
          locationRef.current = {
            spineIndex: initialSpine,
            pageIndex: 0,
            scrollTop: 0,
            chapterProgress: stored?.chapterProgress,
          }
          if (
            typeof stored?.chapterProgress === 'number' &&
            Number.isFinite(stored.chapterProgress)
          ) {
            await loadSpine(initialSpine, {
              chapterProgress: stored.chapterProgress,
              behavior: 'auto',
            })
          } else {
            const initialPage = clamp(stored?.pageIndex ?? 0, 0, 1_000_000)
            const initialScrollTop = clamp(
              stored?.scrollTop ?? 0,
              0,
              1_000_000_000,
            )
            locationRef.current = {
              spineIndex: initialSpine,
              pageIndex: initialPage,
              scrollTop: initialScrollTop,
            }
            await loadSpine(initialSpine, {
              pageIndex: initialPage,
              scrollTop: initialScrollTop,
              behavior: 'auto',
            })
          }
        }
        if (!alive) return
        setStatusWithNotify('ready')
      } catch (err) {
        if (!alive) return
        const message =
          err instanceof EpubReaderV2Error
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Failed to load EPUB'
        setError(message)
        setStatusWithNotify('error')
        setIsBootstrappingView(false)
        onErrorRef.current?.(err)
      }
    })()

    return () => {
      alive = false
      abort.abort()
    }
  }, [
    activeBookUrl,
    baseStorageId,
    variant,
    authHeadersKey,
    reloadToken,
    loadSpine,
  ])

  useEffect(() => {
    if (!pendingNavigation) return

    const bookId = baseStorageId ?? ''
    const pendingBook = parseVersionedBookId(pendingNavigation.bookId ?? '')
    if (bookId && pendingBook.baseBookId && pendingBook.baseBookId !== bookId) {
      return
    }

    if (pendingBook.variant && pendingBook.variant !== variantRef.current) {
      const target = pendingBook.variant
      const fromStatus =
        transformStatuses[target]?.status === 'ready'
          ? String(transformStatuses[target]?.url ?? '').trim()
          : ''
      const fromBook = String(transformationData?.[target]?.[0] ?? '').trim()
      const fromLegacy =
        target === 'modernify' ? String(transformedBookUrl ?? '').trim() : ''
      const resolved =
        target === 'original' ? 'ok' : fromStatus || fromBook || fromLegacy
      if (resolved) {
        pendingVariantRestoreRef.current = null
        switchVariant(target, { preserveChapterProgress: false })
        return
      }
    }

    if (pendingNavigation.href) {
      if (!publication) {
        return
      }
      goToHrefRef.current(pendingNavigation.href, 'auto')
      onConsumePendingNavigationRef.current?.(pendingNavigation.id)
      return
    }

    const textOffset = pendingNavigation.textOffset ?? 0
    if (!Number.isFinite(textOffset)) {
      return
    }

    const targetSpineIndex = pendingNavigation.spineIndex ?? spineIndex
    if (targetSpineIndex !== spineIndex) {
      loadSpine(targetSpineIndex, {
        pageIndex: 0,
        behavior: 'auto',
        textOffset,
        consumeNavigationId: pendingNavigation.id,
      })
      return
    }

    const ok = goToTextOffsetInCurrentDoc(textOffset, 'auto')
    if (ok) {
      onConsumePendingNavigationRef.current?.(pendingNavigation.id)
      return
    }

    pendingNavRef.current = {
      textOffset,
      behavior: 'auto',
      consumeNavigationId: pendingNavigation.id,
    }
    setLayoutRevision((r) => r + 1)
  }, [
    pendingNavigation?.id,
    pendingNavigation?.bookId,
    pendingNavigation?.spineIndex,
    pendingNavigation?.textOffset,
    pendingNavigation?.href,
    publication,
    baseStorageId,
    spineIndex,
    loadSpine,
    goToTextOffsetInCurrentDoc,
    switchVariant,
  ])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (
        event.key === 'ArrowRight' ||
        event.key === 'PageDown' ||
        event.key === ' '
      ) {
        event.preventDefault()
        showHud()
        next()
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        showHud()
        prev()
        return
      }
      if (event.key === 'Escape') {
        setTocOpen(false)
        setVersionsOpen(false)
        setSettingsOpen(false)
        setCustomizeOpen(false)
        setHudActive(false)
      }
    },
    [next, prev, showHud],
  )

  const tocItemsFlat = useMemo(
    () => flattenToc(publication?.toc ?? []),
    [publication],
  )

  const handleTocSelect = useCallback(
    (href: string) => {
      showHud()
      goToHref(href, 'auto')
      setTocOpen(false)
    },
    [goToHref, showHud],
  )

  useEffect(() => {
    const cb = onTocChangeRef.current
    if (!cb) return

    const pub = publication
    if (!pub) {
      cb(null)
      return
    }

    const baseBookId = baseStorageId || pub.bookId || ''
    const bookId = baseBookId ? toVersionedBookId(baseBookId, variant) : ''
    const bookTitle = bookTitleWithVariant((pub.title ?? '').trim(), variant)
    const metadata: EpubReaderV2BookMetadata = {
      title: pub.title,
      author: pub.author,
      language: pub.language,
      publisher: pub.publisher,
      description: pub.description,
      subjects: pub.subjects,
      date: pub.date,
      identifier: pub.identifier,
      modified: pub.modified,
    }

    const chapters = tocItemsFlat
      .map(({ item, depth }) => {
        const href = String(item.href ?? '').trim()
        if (!href) return null
        const title = String(item.title ?? '').trim()
        if (!title) return null

        const path = normalizePath(splitHref(href).path)
        const spineIndex = pub.spine.findIndex(
          (s) => normalizePath(s.href) === path,
        )
        if (spineIndex < 0) return null
        return { title, href, spineIndex, depth }
      })
      .filter(Boolean) as Array<{
      title: string
      href: string
      spineIndex: number
      depth: number
    }>

    cb({ bookId, bookTitle, metadata, chapters })
  }, [publication, baseStorageId, tocItemsFlat, variant])

  const currentHref = publication?.spine[spineIndex]?.href ?? ''
  const chromeTitle = publication?.title ?? 'EPUB'

  const modernifyUrlFromStatus =
    transformStatuses.modernify?.status === 'ready'
      ? String(transformStatuses.modernify?.url ?? '').trim()
      : ''
  const modernifyUrlFromBook =
    String(transformationData?.modernify?.[0] ?? '').trim() ||
    String(transformedBookUrl ?? '').trim()
  const modernifyAvailable = Boolean(
    modernifyUrlFromStatus || modernifyUrlFromBook,
  )
  const modernifyStatus = transformStatuses.modernify?.status ?? null
  const modernifyBusy =
    modernifyStatus === 'pending' || modernifyStatus === 'running'

  const modernifyError =
    modernifyStatus === 'error'
      ? String(transformStatuses.modernify?.error ?? '')
      : ''

  const [modernifyStuck, setModernifyStuck] = useState(false)
  useEffect(() => {
    setModernifyStuck(false)
    if (!modernifyBusy) return
    const createdAt = transformStatuses.modernify?.created_at
    const startedAt = createdAt ? Date.parse(createdAt) : NaN
    if (!Number.isFinite(startedAt)) return
    const thresholdMs = 5 * 60 * 1000
    const remaining = startedAt + thresholdMs - Date.now()
    if (remaining <= 0) {
      setModernifyStuck(true)
      return
    }
    const timer = window.setTimeout(() => setModernifyStuck(true), remaining)
    return () => window.clearTimeout(timer)
  }, [modernifyBusy, transformStatuses.modernify?.created_at])

  const translateVariants = useMemo(() => {
    const out = new Set<string>()
    for (const key of Object.keys(transformationData ?? {})) {
      if (key.startsWith('translate_') && isReaderVariant(key)) out.add(key)
    }
    for (const key of Object.keys(transformStatuses)) {
      if (key.startsWith('translate_') && isReaderVariant(key)) out.add(key)
    }
    return Array.from(out).sort() as TranslateVariant[]
  }, [transformationData, transformStatuses])

  const currentPreset = THEME_PRESETS[settings.themePreset]
  const background = currentPreset.bg
  const fg = currentPreset.fg

  const showOverlay = status !== 'ready' || isBootstrappingView

  const isDark = currentPreset.theme === 'dark'
  const hudFg = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)'
  const hudFgHover = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)'
  const panelBg = isDark
    ? 'rgba(44, 44, 46, 0.95)'
    : 'rgba(255, 255, 255, 0.95)'
  const panelBorder = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        ...style,
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background,
        color: fg,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif',
      }}
      onKeyDown={handleKeyDown}
      onPointerMove={() => showHud()}
      onPointerEnter={() => showHud()}
      tabIndex={0}
      aria-label="EPUB reader"
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={contextMenuTriggerRef}
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              width: 1,
              height: 1,
              pointerEvents: 'none',
              opacity: 0,
            }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            disabled={!contextMenuSelectionText.trim()}
            onSelect={() => void copyTextToClipboard(contextMenuSelectionText)}
          >
            Copy
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!contextMenuSelectionText.trim()}
            onSelect={() => {
              const payload = contextMenuSelectionRef.current
              if (!payload) return
              onAddSelectionToChatRef.current?.(payload)
            }}
          >
            Add to chat
            <ContextMenuShortcut>{modIShortcut}</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <style>{`
        .mfv2-reader__hud {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 10;
        }
        .mfv2-reader__topbar {
          pointer-events: auto;
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          z-index: 14;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          opacity: 0;
          transition: opacity 200ms ease;
        }
        .mfv2-reader__hud.is-visible .mfv2-reader__topbar {
          opacity: 1;
        }
        .mfv2-reader__topbarLeft,
        .mfv2-reader__topbarRight {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .mfv2-reader__btn {
          appearance: none;
          border: none;
          background: transparent;
          color: ${hudFg};
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          user-select: none;
          transition: background-color 150ms ease, color 150ms ease;
        }
        .mfv2-reader__btn:hover {
          background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
        }
        .mfv2-reader__btn.is-active {
          background: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'};
          color: ${hudFgHover};
        }
        .mfv2-reader__iconBtn {
          appearance: none;
          border: none;
          background: transparent;
          color: ${hudFg};
          border-radius: 0.5rem;
          width: 36px;
          height: 36px;
          padding: 0.5rem;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          user-select: none;
          transition: background-color 150ms ease, color 150ms ease;
        }
        .mfv2-reader__iconBtn:hover {
          background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
        }
        .mfv2-reader__iconBtn.is-active {
          background: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'};
          color: ${hudFgHover};
        }
        .mfv2-reader__title {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          text-align: center;
          color: ${isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)'};
          font-weight: 500;
          font-size: 14px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 50%;
          pointer-events: none;
        }
        .mfv2-reader__chevron {
          pointer-events: auto;
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          z-index: 11;
          width: 48px;
          height: 100px;
          border: none;
          background: transparent;
          color: ${isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'};
          display: grid;
          place-items: center;
          font-size: 36px;
          font-weight: 200;
          line-height: 1;
          cursor: pointer;
          transition: color 150ms ease, opacity 200ms ease, background-color 150ms ease;
          opacity: 0;
          border-radius: 0.5rem;
        }
        .mfv2-reader__hud.is-visible .mfv2-reader__chevron {
          opacity: 1;
        }
        .mfv2-reader__chevron:hover {
          color: ${isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)'};
          background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
        }
        .mfv2-reader__chevron:active {
          transform: translateY(-50%) scale(0.98);
        }
        .mfv2-reader__chevron.left { left: 8px; }
        .mfv2-reader__chevron.right { right: 8px; }
        .mfv2-reader__pageIndicator {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          bottom: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          color: ${isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'};
          font-size: 13px;
          font-weight: 400;
          letter-spacing: 0.01em;
          pointer-events: none;
          user-select: none;
          z-index: 10;
        }
        .mfv2-reader__pageIndicator strong {
          font-weight: 400;
        }
        .mfv2-reader__pageIndicatorDetails {
          opacity: 0;
          transition: opacity 200ms ease;
        }
        .mfv2-reader__pageIndicatorDetails.is-visible {
          opacity: 1;
        }

        .mfv2-reader__panelBackdrop {
          position: absolute;
          inset: 0;
          pointer-events: auto;
          background: transparent;
          z-index: 12;
        }

        /* Versions Panel */
        .mfv2-reader__versionsPanel {
          position: absolute;
          top: 56px;
          right: 16px;
          width: 360px;
          z-index: 13;
          background: ${panelBg};
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid ${panelBorder};
          border-radius: 16px;
          padding: 12px;
          pointer-events: auto;
          box-shadow: 0 12px 40px rgba(0,0,0,0.3);
        }
        .mfv2-reader__versionsPanel::before {
          content: '';
          position: absolute;
          top: -8px;
          right: 20px;
          width: 16px;
          height: 16px;
          background: ${panelBg};
          border: 1px solid ${panelBorder};
          border-bottom: none;
          border-right: none;
          transform: rotate(45deg);
        }
        .mfv2-reader__versionsHeader {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          padding: 4px 8px 10px 8px;
        }
        .mfv2-reader__versionsTitle {
          font-size: 13px;
          font-weight: 600;
          color: ${isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)'};
        }
        .mfv2-reader__versionsSub {
          font-size: 12px;
          color: ${isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)'};
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 220px;
          text-align: right;
        }
        .mfv2-reader__versionOption {
          appearance: none;
          width: 100%;
          text-align: left;
          border: none;
          background: transparent;
          color: ${fg};
          border-radius: 0.75rem;
          padding: 10px 12px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 150ms ease;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .mfv2-reader__versionOptionText {
          font-size: 13px;
          font-weight: 500;
          color: ${fg};
        }
        .mfv2-reader__versionOption:hover {
          background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
        }
        .mfv2-reader__versionOption.is-active {
          background: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'};
        }
        .mfv2-reader__versionMeta {
          font-size: 12px;
          font-weight: 500;
          color: ${isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)'};
          flex-shrink: 0;
        }
        .mfv2-reader__versionMetaButton {
          font-size: 12px;
          font-weight: 500;
          color: ${isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)'};
          flex-shrink: 0;
          cursor: pointer;
          transition: color 0.15s ease;
        }
        .mfv2-reader__versionMetaButton:hover {
          color: ${isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)'};
        }
        .mfv2-reader__divider {
          height: 1px;
          width: 100%;
          background: ${panelBorder};
          margin: 10px 0;
        }
        .mfv2-reader__translateRow {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 4px 4px 4px;
        }
        .mfv2-reader__translateLabel {
          flex: 1;
          font-size: 13px;
          font-weight: 600;
          color: ${fg};
          opacity: ${isDark ? 0.85 : 0.9};
          padding-left: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mfv2-reader__translateInput {
          flex: 0 1 160px;
          min-width: 120px;
          height: 38px;
          padding: 0 10px;
          border-radius: 12px;
          border: 1px solid ${panelBorder};
          background: ${isDark ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.6)'};
          color: ${fg};
          font-size: 13px;
        }
        .mfv2-reader__translateInput::placeholder {
          color: ${isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'};
        }
        .mfv2-reader__translateBtn {
          height: 38px;
          padding: 0 12px;
          border-radius: 12px;
          border: 1px solid ${panelBorder};
          background: transparent;
          color: ${fg};
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: background-color 150ms ease;
          flex-shrink: 0;
        }
        .mfv2-reader__translateBtn:hover {
          background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
        }
        .mfv2-reader__translateBtn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .mfv2-reader__hint {
          padding: 0 8px;
          font-size: 12px;
          color: ${isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)'};
        }
        .mfv2-reader__hint.is-error {
          color: ${isDark ? 'rgba(255,120,120,0.9)' : 'rgba(190,0,0,0.8)'};
        }

        /* Settings Panel */
        .mfv2-reader__settingsPanel {
          position: absolute;
          top: 56px;
          right: 16px;
          width: 320px;
          z-index: 13;
          background: ${panelBg};
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid ${panelBorder};
          border-radius: 16px;
          padding: 16px;
          pointer-events: auto;
          box-shadow: 0 12px 40px rgba(0,0,0,0.3);
        }
        .mfv2-reader__settingsPanel::before {
          content: '';
          position: absolute;
          top: -8px;
          right: 20px;
          width: 16px;
          height: 16px;
          background: ${panelBg};
          border: 1px solid ${panelBorder};
          border-bottom: none;
          border-right: none;
          transform: rotate(45deg);
        }
        .mfv2-reader__panelTitle {
          text-align: center;
          font-size: 13px;
          font-weight: 500;
          color: ${isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)'};
          margin-bottom: 16px;
        }
        .mfv2-reader__fontSizeRow {
          display: flex;
          align-items: center;
          border: 1px solid ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'};
          border-radius: 8rem;
          overflow: hidden;
        }
        .mfv2-reader__fontSizeBtn {
          appearance: none;
          flex: 1;
          height: 44px;
          border: none;
          background: transparent;
          color: ${fg};
          font-size: 18px;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 150ms ease, border-color 150ms ease;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .mfv2-reader__fontSizeBtn:first-child {
          border-top-left-radius: 8rem;
          border-bottom-left-radius: 8rem;
        }
        .mfv2-reader__fontSizeBtn:last-child {
          border-top-right-radius: 8rem;
          border-bottom-right-radius: 8rem;
        }
        .mfv2-reader__fontSizeBtn:hover {
          background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
        }
        .mfv2-reader__fontSizeDivider {
          width: 1px;
          height: 24px;
          background: ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)'};
          pointer-events: none;
        }
        .mfv2-reader__fontSizeIndicator {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          height: 16px;
          opacity: 0;
        }
        .mfv2-reader__fontSizeIndicator.is-animating {
          animation: mfv2-fontSizeIndicator 2s ease-out forwards;
        }
        @keyframes mfv2-fontSizeIndicator {
          0% { opacity: 1; }
          65% { opacity: 1; }
          100% { opacity: 0; }
        }
        .mfv2-reader__fontSizeDot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'};
          transition: background-color 100ms ease;
        }
        .mfv2-reader__fontSizeDot.is-active {
          background: ${isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)'};
        }
        .mfv2-reader__presetGrid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
          margin-bottom: 12px;
        }
        .mfv2-reader__presetBtn {
          appearance: none;
          border: 2px solid ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'};
          border-radius: 0.75rem;
          padding: 12px 8px;
          cursor: pointer;
          transition: border-color 150ms ease, background-color 150ms ease;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }
        .mfv2-reader__presetBtn:hover {
          border-color: ${isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'};
        }
        .mfv2-reader__presetBtn.is-active {
          border-color: ${isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.4)'};
          background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
        }
        .mfv2-reader__presetSample {
          font-size: 22px;
          font-weight: 400;
          line-height: 1.2;
        }
        .mfv2-reader__presetName {
          font-size: 11px;
          font-weight: 500;
        }
        .mfv2-reader__customizeBtn {
          appearance: none;
          width: 100%;
          height: 44px;
          border: 1px solid ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'};
          background: transparent;
          color: ${fg};
          border-radius: 8rem;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: background-color 150ms ease, border-color 150ms ease;
        }
        .mfv2-reader__customizeBtn:hover {
          background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
          border-color: ${isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)'};
        }

        /* TOC Panel */
        .mfv2-reader__tocPanel {
          position: absolute;
          top: 56px;
          left: 16px;
          width: min(360px, calc(100% - 32px));
          z-index: 13;
          max-height: calc(100% - 100px);
          overflow: auto;
          background: ${panelBg};
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid ${panelBorder};
          border-radius: 16px;
          padding: 12px;
          pointer-events: auto;
          box-shadow: 0 12px 40px rgba(0,0,0,0.3);
        }
        .mfv2-reader__tocTitle {
          font-size: 13px;
          font-weight: 600;
          color: ${isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)'};
          margin: 0 0 10px 4px;
        }
        .mfv2-reader__tocItem {
          appearance: none;
          width: 100%;
          text-align: left;
          border: none;
          background: transparent;
          color: ${fg};
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          font-size: 13px;
          font-weight: 400;
          line-height: 1.3;
          cursor: pointer;
          transition: background-color 150ms ease;
        }
        .mfv2-reader__tocItem:hover {
          background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
        }
        .mfv2-reader__tocItem.is-active {
          background: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'};
          font-weight: 500;
        }

        /* Customize Panel */
        .mfv2-reader__customizePanel {
          position: absolute;
          inset: 0;
          background: ${panelBg};
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          z-index: 20;
          display: flex;
          flex-direction: column;
          pointer-events: auto;
        }
        .mfv2-reader__customizeHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid ${panelBorder};
        }
        .mfv2-reader__customizeTitle {
          font-size: 16px;
          font-weight: 600;
          color: ${fg};
        }
        .mfv2-reader__doneBtn {
          appearance: none;
          border: none;
          background: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'};
          color: ${fg};
          border-radius: 1rem;
          padding: 0.375rem 0.875rem;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: background-color 150ms ease;
        }
        .mfv2-reader__doneBtn:hover {
          background: ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'};
        }
        .mfv2-reader__customizePreview {
          padding: 24px 20px;
          border-bottom: 1px solid ${panelBorder};
        }
        .mfv2-reader__previewSample {
          font-size: 22px;
          font-weight: 400;
          line-height: 1.2;
          color: ${fg};
          margin-bottom: 12px;
        }
        .mfv2-reader__previewText {
          font-size: 15px;
          line-height: 1.5;
          color: ${isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)'};
        }
        .mfv2-reader__customizeBody {
          flex: 1;
          overflow: auto;
          padding: 20px;
        }
        .mfv2-reader__settingSection {
          margin-bottom: 24px;
        }
        .mfv2-reader__settingSectionTitle {
          font-size: 12px;
          font-weight: 500;
          color: ${isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)'};
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 12px;
        }
        .mfv2-reader__settingRow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 0;
          border-bottom: 1px solid ${panelBorder};
        }
        .mfv2-reader__settingRow:last-child {
          border-bottom: none;
        }
        .mfv2-reader__settingLabel {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 14px;
          color: ${fg};
        }
        .mfv2-reader__settingValue {
          font-size: 14px;
          color: ${isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)'};
        }
        .mfv2-reader__slider {
          width: 100%;
          height: 4px;
          -webkit-appearance: none;
          appearance: none;
          background: ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'};
          border-radius: 2px;
          outline: none;
        }
        .mfv2-reader__slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 20px;
          height: 20px;
          background: ${isDark ? '#fff' : '#333'};
          border-radius: 50%;
          cursor: pointer;
        }
        .mfv2-reader__slider::-moz-range-thumb {
          width: 20px;
          height: 20px;
          background: ${isDark ? '#fff' : '#333'};
          border-radius: 50%;
          cursor: pointer;
          border: none;
        }
        .mfv2-reader__sliderRow {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 0;
        }
        .mfv2-reader__sliderIcon {
          color: ${isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)'};
          width: 20px;
          flex-shrink: 0;
        }
        .mfv2-reader__sliderValue {
          font-size: 13px;
          color: ${isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)'};
          width: 40px;
          text-align: right;
          flex-shrink: 0;
          font-variant-numeric: tabular-nums;
        }
        .mfv2-reader__toggle {
          position: relative;
          width: 50px;
          height: 30px;
          background: ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'};
          border-radius: 15px;
          cursor: pointer;
          transition: background 200ms ease;
        }
        .mfv2-reader__toggle.is-on {
          background: #34c759;
        }
        .mfv2-reader__toggleKnob {
          position: absolute;
          top: 2px;
          left: 2px;
          width: 26px;
          height: 26px;
          background: white;
          border-radius: 50%;
          transition: transform 200ms ease;
          box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }
        .mfv2-reader__toggle.is-on .mfv2-reader__toggleKnob {
          transform: translateX(20px);
        }
        .mfv2-reader__marginBtns {
          display: flex;
          gap: 8px;
        }
        .mfv2-reader__marginBtn {
          appearance: none;
          flex: 1;
          height: 36px;
          border: 1px solid ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'};
          background: transparent;
          color: ${fg};
          border-radius: 0.5rem;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 150ms ease, border-color 150ms ease;
        }
        .mfv2-reader__marginBtn:hover {
          background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
          border-color: ${isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)'};
        }
        .mfv2-reader__marginBtn.is-active {
          background: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'};
          border-color: ${isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.4)'};
        }
        .mfv2-reader__resetBtn {
          appearance: none;
          width: 100%;
          height: 44px;
          border: none;
          background: transparent;
          border-radius: 0.5rem;
          color: ${isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)'};
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          margin-top: 12px;
          transition: background-color 150ms ease, color 150ms ease;
        }
        .mfv2-reader__resetBtn:hover {
          background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
          color: ${fg};
        }

        /* Page Area */
        .mfv2-reader__pageArea {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
        }
        .mfv2-reader__page {
          width: ${pageViewport.width}px;
          height: ${pageViewport.height}px;
          overflow: hidden;
        }
        .mfv2-reader__iframe {
          width: 100%;
          height: 100%;
          border: 0;
          display: block;
          background: transparent;
        }
        .mfv2-reader__overlay {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
          background: ${background};
          opacity: ${showOverlay ? 1 : 0};
          transition: opacity 160ms ease;
        }
        .mfv2-reader__overlayCard {
          pointer-events: auto;
          min-width: 240px;
          max-width: 420px;
          padding: 20px 24px;
          background: ${isDark ? 'rgba(44, 44, 46, 0.95)' : 'rgba(255, 255, 255, 0.95)'};
          border: 1px solid ${panelBorder};
          border-radius: 16px;
          color: ${fg};
          box-shadow: 0 14px 40px rgba(0,0,0,0.25);
        }
        .mfv2-reader__overlayTitle {
          font-weight: 600;
          font-size: 15px;
          margin-bottom: 8px;
        }
        .mfv2-reader__overlayText {
          font-size: 13px;
          color: ${isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)'};
        }
        .mfv2-reader__toast {
          position: absolute;
          left: 50%;
          bottom: 18px;
          transform: translateX(-50%);
          z-index: 50;
          pointer-events: none;
          max-width: min(680px, calc(100% - 24px));
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid ${panelBorder};
          background: ${isDark ? 'rgba(44, 44, 46, 0.96)' : 'rgba(255, 255, 255, 0.96)'};
          color: ${fg};
          font-size: 13px;
          box-shadow: 0 14px 40px rgba(0,0,0,0.25);
          text-align: center;
        }
        .mfv2-reader__toast.is-error {
          border-color: ${isDark ? 'rgba(255, 77, 79, 0.35)' : 'rgba(255, 77, 79, 0.45)'};
          color: ${isDark ? 'rgba(255, 190, 190, 1)' : 'rgba(160, 0, 0, 1)'};
        }
        /* Remove all focus outlines */
        div:focus,
        div:focus-visible,
        button:focus,
        button:focus-visible,
        select:focus,
        select:focus-visible,
        input:focus,
        input:focus-visible,
        [role="button"]:focus,
        [role="button"]:focus-visible {
          outline: none;
          box-shadow: none;
        }
        @media (prefers-reduced-motion: reduce) {
          .mfv2-reader__btn,
          .mfv2-reader__iconBtn,
          .mfv2-reader__chevron,
          .mfv2-reader__topbar,
          .mfv2-reader__overlay,
          .mfv2-reader__pageIndicatorDetails,
          .mfv2-reader__toggle,
          .mfv2-reader__toggleKnob,
          .mfv2-reader__presetBtn {
            transition: none;
          }
        }
      `}</style>

      {toast && (
        <div
          className={`mfv2-reader__toast ${toast.tone === 'error' ? 'is-error' : ''}`}
          role="status"
          aria-live="polite"
        >
          {toast.message}
        </div>
      )}

      <div
        className={`mfv2-reader__hud ${hudVisible ? 'is-visible' : ''}`}
        aria-hidden={!hudVisible}
      >
        <div className="mfv2-reader__topbar">
          <div className="mfv2-reader__topbarLeft">
            <button
              className={`mfv2-reader__iconBtn ${tocOpen ? 'is-active' : ''}`}
              onClick={() => {
                setTocOpen((v) => !v)
                setVersionsOpen(false)
              }}
              type="button"
            >
              <IoList className="w-4 h-4" />
            </button>
          </div>
          <div className="mfv2-reader__title" title={chromeTitle}>
            {chromeTitle}
          </div>
          <div className="mfv2-reader__topbarRight">
            <button
              className={`mfv2-reader__iconBtn ${versionsOpen ? 'is-active' : ''}`}
              type="button"
              onClick={() => {
                setVersionsOpen((v) => !v)
                setTocOpen(false)
                setSettingsOpen(false)
              }}
              title="Choose version"
            >
              <IoSparkles />
            </button>
          </div>
        </div>

        {(tocOpen || versionsOpen || settingsOpen) && !customizeOpen && (
          <div
            className="mfv2-reader__panelBackdrop"
            aria-hidden="true"
            onPointerDown={() => {
              setTocOpen(false)
              setVersionsOpen(false)
              setSettingsOpen(false)
            }}
          />
        )}

        {versionsOpen && (
          <div
            className="mfv2-reader__versionsPanel"
            role="dialog"
            aria-label="Versions"
          >
            <div className="mfv2-reader__versionsHeader">
              <div className="mfv2-reader__versionsTitle">Variants</div>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <button
                className={`mfv2-reader__versionOption ${variant === 'original' ? 'is-active' : ''}`}
                type="button"
                onClick={() => {
                  switchVariant('original', { preserveChapterProgress: true })
                  setVersionsOpen(false)
                }}
              >
                <span>Original</span>
                {variant === 'original' && (
                  <IoCheckmarkCircle
                    className="w-4 h-4"
                    style={{ color: fg }}
                  />
                )}
              </button>
                {modernifyAvailable ? (
                  <button
                    className={`mfv2-reader__versionOption ${variant === 'modernify' ? 'is-active' : ''}`}
                    type="button"
                    disabled={!modernifyAvailable}
                  onClick={() => {
                    switchVariant('modernify', {
                      preserveChapterProgress: true,
                    })
                    setVersionsOpen(false)
                  }}
                >
                  <span>Modernify</span>
                  {variant === 'modernify' && (
                    <IoCheckmarkCircle
                      className="w-4 h-4"
                      style={{ color: fg }}
                    />
                  )}
                </button>
                ) : (
                  <div className="h-10 hover:bg-transparent px-3 w-full flex justify-between items-center">
                    <span className="mfv2-reader__versionOptionText">
                      Modernify
                    </span>
                    <button
                      className="mfv2-reader__versionMetaButton"
                      type="button"
                      disabled={modernifyBusy && !modernifyStuck}
                      title={
                        modernifyBusy && !modernifyStuck
                          ? 'Modernifying…'
                          : modernifyBusy && modernifyStuck
                            ? 'Modernify appears stuck. Restart the job.'
                            : modernifyError || 'Create a modernified version'
                      }
                      onClick={() => {
                        void startModernify()
                      }}
                    >
                      {modernifyBusy && modernifyStuck
                        ? 'Restart'
                        : modernifyBusy
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : modernifyError
                            ? 'Retry'
                            : 'Create'}
                    </button>
                  </div>
                )}
              {translateVariants.map((key) => {
                const fromStatus =
                  transformStatuses[key]?.status === 'ready'
                    ? String(transformStatuses[key]?.url ?? '').trim()
                    : ''
                const fromBook = String(
                  transformationData?.[key]?.[0] ?? '',
                ).trim()
                const available = Boolean(fromStatus || fromBook)

                return (
                  <button
                    key={key}
                    className={`mfv2-reader__versionOption ${variant === key ? 'is-active' : ''}`}
                    type="button"
                    disabled={!available}
                    onClick={() => {
                      switchVariant(key, { preserveChapterProgress: true })
                      setVersionsOpen(false)
                    }}
                    title={
                      available
                        ? `Switch to ${variantLabel(key)}`
                        : 'Translation not ready yet'
                    }
                  >
                    <span>{variantLabel(key)}</span>
                    {variant === key && (
                      <IoCheckmarkCircle
                        className="w-4 h-4"
                        style={{ color: fg }}
                      />
                    )}
                  </button>
                )
              })}
              {baseStorageId && (
                <>
                  <div className="h-10 hover:bg-transparent px-3 w-full flex justify-between items-center">
                    <p className="mfv2-reader__versionOptionText">Translate</p>
                    <input
                      className="mfv2-reader__translateInput"
                      value={translateLangDraft}
                      placeholder="Translate… (e.g. Spanish)"
                      onChange={(e) => {
                        setTranslateLangDraft(e.target.value)
                        setTranslateLangError(null)
                      }}
                    />
                    <button
                      className="mfv2-reader__versionMetaButton"
                      type="button"
                      disabled={!translateLangDraft.trim()}
                      onClick={() => {
                        void startTranslate(translateLangDraft)
                      }}
                    >
                      Create
                    </button>
                  </div>
                  {translateLangError && (
                    <div className="mfv2-reader__hint is-error">
                      {translateLangError}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* TOC Panel */}
        {tocOpen && (
          <TocPanel
            tocItemsFlat={tocItemsFlat}
            currentHref={currentHref}
            onSelectHref={handleTocSelect}
          />
        )}

        {/* Settings Panel - Apple Books Style */}
        {settingsOpen && !customizeOpen && (
          <div
            className="mfv2-reader__settingsPanel"
            role="dialog"
            aria-label="Themes & Settings"
          >
            <div className="mfv2-reader__panelTitle">Themes & Settings</div>

            {/* Font Size Controls */}
            <div className="mfv2-reader__fontSizeRow">
              <button
                className="mfv2-reader__fontSizeBtn"
                type="button"
                onClick={() => {
                  updateSettings({
                    fontScale: Math.max(0.7, settings.fontScale - 0.05),
                  })
                  setFontSizeChangeCount((c) => c + 1)
                }}
                aria-label="Decrease font size"
              >
                <span style={{ fontSize: 14 }}>A</span>
              </button>
              <div
                className="mfv2-reader__fontSizeDivider"
                aria-hidden="true"
              />
              <button
                className="mfv2-reader__fontSizeBtn"
                type="button"
                onClick={() => {
                  updateSettings({
                    fontScale: Math.min(1.5, settings.fontScale + 0.05),
                  })
                  setFontSizeChangeCount((c) => c + 1)
                }}
                aria-label="Increase font size"
              >
                <span style={{ fontSize: 22 }}>A</span>
              </button>
            </div>
            {/* Font Size Level Indicator - 16 levels */}
            <div
              key={fontSizeChangeCount}
              className={`mfv2-reader__fontSizeIndicator ${fontSizeChangeCount > 0 ? 'is-animating' : ''}`}
              aria-hidden="true"
            >
              {Array.from({ length: 16 }, (_, i) => {
                const level = Math.round((settings.fontScale - 0.7) / 0.05)
                return (
                  <div
                    key={i}
                    className={`mfv2-reader__fontSizeDot ${i <= level ? 'is-active' : ''}`}
                  />
                )
              })}
            </div>

            {/* Theme Presets Grid */}
            <div className="mfv2-reader__presetGrid">
              {(Object.keys(THEME_PRESETS) as EpubReaderV2ThemePreset[]).map(
                (preset) => {
                  const config = THEME_PRESETS[preset]
                  return (
                    <button
                      key={preset}
                      type="button"
                      className={`mfv2-reader__presetBtn ${settings.themePreset === preset ? 'is-active' : ''}`}
                      style={{ background: config.bg }}
                      onClick={() => applyThemePreset(preset)}
                      aria-label={config.name}
                    >
                      <span
                        className="mfv2-reader__presetSample"
                        style={{
                          color: config.fg,
                          fontWeight: config.fontWeight,
                        }}
                      >
                        Aa
                      </span>
                      <span
                        className="mfv2-reader__presetName"
                        style={{ color: config.fg, opacity: 0.7 }}
                      >
                        {config.name}
                      </span>
                    </button>
                  )
                },
              )}
            </div>

            {/* Customize Button */}
            <button
              type="button"
              className="mfv2-reader__customizeBtn"
              onClick={() => {
                setCustomizeOpen(true)
                setSettingsOpen(false)
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Customize
            </button>
          </div>
        )}

        {/* Navigation Chevrons */}
        <button
          type="button"
          className="mfv2-reader__chevron left"
          aria-label="Previous page"
          onClick={() => prev()}
          style={{
            opacity: hudVisible ? 1 : 0,
            pointerEvents: hudVisible ? 'auto' : 'none',
          }}
        >
          ‹
        </button>
        <button
          type="button"
          className="mfv2-reader__chevron right"
          aria-label="Next page"
          onClick={() => next()}
          style={{
            opacity: hudVisible ? 1 : 0,
            pointerEvents: hudVisible ? 'auto' : 'none',
          }}
        >
          ›
        </button>
      </div>

      {/* Customize Panel - Full Screen */}
      {customizeOpen && (
        <div className="mfv2-reader__customizePanel">
          <div className="mfv2-reader__customizeHeader">
            <button
              type="button"
              className="mfv2-reader__btn"
              onClick={() => setCustomizeOpen(false)}
            >
              Cancel
            </button>
            <span className="mfv2-reader__customizeTitle">Customize Theme</span>
            <button
              type="button"
              className="mfv2-reader__doneBtn"
              onClick={() => setCustomizeOpen(false)}
            >
              Done
            </button>
          </div>

          <div className="mfv2-reader__customizePreview">
            <div className="mfv2-reader__previewSample">Aa</div>
            <div
              className="mfv2-reader__previewText"
              style={{ lineHeight: settings.lineHeight }}
            >
              The quick brown fox jumps over the lazy dog. Pack my box with five
              dozen liquor jugs.
            </div>
          </div>

          <div className="mfv2-reader__customizeBody">
            {/* Text Section */}
            <div className="mfv2-reader__settingSection">
              <div className="mfv2-reader__settingSectionTitle">Text</div>
              <div className="mfv2-reader__settingRow">
                <span className="mfv2-reader__settingLabel">
                  <span style={{ fontWeight: 600 }}>Aa</span> Font
                </span>
                <select
                  value={settings.fontFamily}
                  onChange={(e) =>
                    updateSettings({
                      fontFamily: e.target
                        .value as EpubReaderV2Settings['fontFamily'],
                    })
                  }
                  style={{
                    appearance: 'none',
                    background: 'transparent',
                    border: 'none',
                    color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)',
                    fontSize: 14,
                    cursor: 'pointer',
                    textAlign: 'right',
                  }}
                >
                  <option value="publisher">Publisher</option>
                  <option value="serif">Serif</option>
                  <option value="sans">Sans</option>
                </select>
              </div>
              <div className="mfv2-reader__settingRow">
                <span className="mfv2-reader__settingLabel">
                  <span style={{ fontWeight: 700 }}>B</span> Bold Text
                </span>
                <div
                  className={`mfv2-reader__toggle ${settings.textAlign === 'justify' ? 'is-on' : ''}`}
                  onClick={() =>
                    updateSettings({
                      textAlign:
                        settings.textAlign === 'justify' ? 'left' : 'justify',
                    })
                  }
                >
                  <div className="mfv2-reader__toggleKnob" />
                </div>
              </div>
            </div>

            {/* Layout Section */}
            <div className="mfv2-reader__settingSection">
              <div className="mfv2-reader__settingSectionTitle">
                Accessibility & Layout Options
              </div>

              {/* Line Spacing */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      opacity: 0.6,
                      textTransform: 'uppercase',
                    }}
                  >
                    Line Spacing
                  </span>
                </div>
                <div className="mfv2-reader__sliderRow">
                  <span className="mfv2-reader__sliderIcon">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <line x1="4" y1="6" x2="20" y2="6" />
                      <line x1="4" y1="12" x2="20" y2="12" />
                      <line x1="4" y1="18" x2="20" y2="18" />
                    </svg>
                  </span>
                  <input
                    type="range"
                    className="mfv2-reader__slider"
                    min={1.2}
                    max={2.2}
                    step={0.05}
                    value={settings.lineHeight}
                    onChange={(e) =>
                      updateSettings({ lineHeight: Number(e.target.value) })
                    }
                  />
                  <span className="mfv2-reader__sliderValue">
                    {settings.lineHeight.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Margins */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      opacity: 0.6,
                      textTransform: 'uppercase',
                    }}
                  >
                    Margins
                  </span>
                </div>
                <div className="mfv2-reader__marginBtns">
                  {(['small', 'medium', 'large'] as const).map((size) => (
                    <button
                      key={size}
                      type="button"
                      className={`mfv2-reader__marginBtn ${settings.marginSize === size ? 'is-active' : ''}`}
                      onClick={() => updateSettings({ marginSize: size })}
                    >
                      {size.charAt(0).toUpperCase() + size.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Reading Mode */}
              <div className="mfv2-reader__settingRow">
                <span className="mfv2-reader__settingLabel">Scrolled Mode</span>
                <div
                  className={`mfv2-reader__toggle ${settings.flowMode === 'scrolled' ? 'is-on' : ''}`}
                  onClick={() =>
                    updateSettings({
                      flowMode:
                        settings.flowMode === 'scrolled'
                          ? 'paginated'
                          : 'scrolled',
                    })
                  }
                >
                  <div className="mfv2-reader__toggleKnob" />
                </div>
              </div>

              {/* Justify Text */}
              <div className="mfv2-reader__settingRow">
                <span className="mfv2-reader__settingLabel">Justify Text</span>
                <div
                  className={`mfv2-reader__toggle ${settings.textAlign === 'justify' ? 'is-on' : ''}`}
                  onClick={() =>
                    updateSettings({
                      textAlign:
                        settings.textAlign === 'justify' ? 'left' : 'justify',
                    })
                  }
                >
                  <div className="mfv2-reader__toggleKnob" />
                </div>
              </div>
            </div>

            {/* Reset Button */}
            <button
              type="button"
              className="mfv2-reader__resetBtn"
              onClick={() => {
                updateSettings({
                  fontScale: 1,
                  lineHeight: 1.6,
                  marginSize: 'medium',
                  textAlign: 'justify',
                  flowMode: 'paginated',
                  fontFamily: 'serif',
                })
              }}
            >
              Reset Theme
            </button>
          </div>
        </div>
      )}

      <div className="mfv2-reader__pageArea" aria-label="Reading area">
        <div className="mfv2-reader__page">
          <iframe
            ref={iframeRef}
            title="Book content"
            className="mfv2-reader__iframe"
            sandbox="allow-same-origin"
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            onLoad={handleIframeLoad}
            style={{
              opacity: isBootstrappingView ? 0 : 1,
              transition: 'opacity 120ms ease',
            }}
          />
        </div>
      </div>

      <iframe
        ref={measureIframeRef}
        title="Pagination measurement"
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        onLoad={() => {
          const doc = measureIframeRef.current?.contentDocument
          const pending = measureLoadRef.current
          if (!pending) return
          if (pending.token !== measureTokenRef.current) return
          if (!doc) {
            pending.reject(new Error('Measure iframe document missing'))
            measureLoadRef.current = null
            return
          }
          pending.resolve(doc)
          measureLoadRef.current = null
        }}
        style={{
          position: 'absolute',
          left: -10000,
          top: -10000,
          width: pageViewport.width,
          height: pageViewport.height,
          visibility: 'hidden',
          pointerEvents: 'none',
          border: 0,
        }}
      />

      <div className="mfv2-reader__pageIndicator" aria-hidden={false}>
        <strong>{globalPageInfo.current}</strong>
        <span
          className={`mfv2-reader__pageIndicatorDetails ${hudVisible ? 'is-visible' : ''}`}
        >
          of <strong>{globalPageInfo.total ?? '…'}</strong>
        </span>
      </div>

      <div className="mfv2-reader__overlay" aria-hidden={!showOverlay}>
        {showOverlay && (
          <div
            className="mfv2-reader__overlayCard"
            role="status"
            aria-live="polite"
          >
            <div className="mfv2-reader__overlayTitle">
              {status === 'downloading'
                ? 'Downloading…'
                : status === 'unpacking'
                  ? 'Unpacking…'
                  : status === 'parsing'
                    ? 'Parsing…'
                    : status === 'rendering'
                      ? 'Rendering…'
                      : status === 'error'
                        ? 'Error'
                        : 'Loading…'}
            </div>
            <div className="mfv2-reader__overlayText">
              {status === 'downloading' && progress.totalBytes
                ? `${Math.round((progress.loadedBytes / progress.totalBytes) * 100)}%`
                : status === 'error'
                  ? (error ?? 'Unknown error')
                  : ''}
            </div>
            {status === 'error' && (
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button
                  className="mfv2-reader__btn"
                  type="button"
                  onClick={() => {
                    setReloadToken((t) => t + 1)
                  }}
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

const TocPanel = React.memo(function TocPanel({
  tocItemsFlat,
  currentHref,
  onSelectHref,
}: {
  tocItemsFlat: Array<{ item: EpubReaderV2TocItem; depth: number }>
  currentHref: string
  onSelectHref: (href: string) => void
}) {
  const activePath = useMemo(() => normalizePath(currentHref), [currentHref])
  const entries = useMemo(
    () =>
      tocItemsFlat.map(({ item, depth }) => ({
        key: `${item.href}:${depth}`,
        href: item.href,
        title: item.title,
        depth,
        path: normalizePath(splitHref(item.href).path),
      })),
    [tocItemsFlat],
  )

  return (
    <div
      className="mfv2-reader__tocPanel"
      role="dialog"
      aria-label="Table of contents"
    >
      <h3 className="mfv2-reader__tocTitle">Contents</h3>
      <div style={{ display: 'grid', gap: 2 }}>
        {entries.length === 0 ? (
          <div style={{ padding: '12px', opacity: 0.6, fontSize: 13 }}>
            No table of contents found.
          </div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.key}
              className={`mfv2-reader__tocItem ${entry.path === activePath ? 'is-active' : ''}`}
              style={{ paddingLeft: 12 + entry.depth * 16 }}
              type="button"
              onClick={() => onSelectHref(entry.href)}
              title={entry.title}
            >
              {entry.title}
            </button>
          ))
        )}
      </div>
    </div>
  )
})

export const EpubReaderV2 = forwardRef<EpubReaderV2Handle, EpubReaderV2Props>(
  function EpubReaderV2(props, ref) {
    const {
      storageId,
      bookUrl,
      transformationData,
      transformedBookUrl,
      ...rest
    } = props
    const parsed = parseVersionedBookId(String(storageId ?? '').trim())
    const baseStorageId = parsed.baseBookId
    const requestedVariant = parsed.variant
    const initialVariant = pickInitialVariant({
      baseStorageId,
      requestedVariant,
      transformationData,
      transformedBookUrl,
    })

    const key = [baseStorageId, bookUrl, requestedVariant ?? ''].join('|')

    return (
      <EpubReaderV2Inner
        key={key}
        ref={ref}
        {...rest}
        bookUrl={bookUrl}
        transformationData={transformationData}
        transformedBookUrl={transformedBookUrl}
        baseStorageId={baseStorageId}
        initialVariant={initialVariant}
      />
    )
  },
)
