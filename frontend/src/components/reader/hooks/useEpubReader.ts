// useEpubReader Hook
// React hook for managing EPUB reader state

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Publication,
  Location,
  ReaderSettings,
  ReaderState,
  ReaderError,
  Annotation,
  SearchResult,
  HighlightColor,
} from '../types'
import { epubFetcher } from '../core/fetcher'
import { ZipContainer } from '../core/container'
import { EpubParser } from '../core/parser'
import { EpubResourceResolver } from '../core/resources'
import { EpubRenderer } from '../rendering/renderer'
import { AnnotationManager } from '../annotations'
import { SearchEngine } from '../search'
import { readerStorage } from '../storage'

export interface UseEpubReaderOptions {
  bookUrl: string
  bookId: string
  authHeaders?: Record<string, string>
  initialCfi?: string
  containerRef: React.RefObject<HTMLElement>
  onReady?: (publication: Publication) => void
  onLocationChange?: (location: Location) => void
  onError?: (error: ReaderError) => void
}

export interface UseEpubReaderReturn {
  // State
  state: ReaderState
  publication: Publication | null
  location: Location | null
  settings: ReaderSettings
  annotations: Annotation[]

  // Navigation
  next: () => void
  prev: () => void
  goTo: (target: string | number) => void
  goToSpineItem: (index: number, elementId?: string) => void

  // Settings
  updateSettings: (settings: Partial<ReaderSettings>) => void

  // Annotations
  addBookmark: () => Annotation | null
  addHighlight: (color?: HighlightColor, note?: string) => Annotation | null
  removeAnnotation: (id: string) => void

  // Search
  search: (query: string) => Promise<SearchResult[]>

  // Document access
  getDocument: () => Document | null
}

const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'light',
  fontFamily: 'publisher',
  fontSize: 1.0,
  lineHeight: 1.6,
  marginSize: 'medium',
  textAlign: 'left',
  paragraphSpacing: 1.0,
  mode: 'paginated',
}

export function useEpubReader(options: UseEpubReaderOptions): UseEpubReaderReturn {
  const {
    bookUrl,
    bookId,
    authHeaders,
    initialCfi,
    containerRef,
    onReady,
    onLocationChange,
    onError,
  } = options

  // State
  const [state, setState] = useState<ReaderState>({ status: 'idle' })
  const [publication, setPublication] = useState<Publication | null>(null)
  const [location, setLocation] = useState<Location | null>(null)
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS)
  const [annotations, setAnnotations] = useState<Annotation[]>([])

  // Refs
  const rendererRef = useRef<EpubRenderer | null>(null)
  const resourceResolverRef = useRef<EpubResourceResolver | null>(null)
  const annotationManagerRef = useRef<AnnotationManager | null>(null)
  const searchEngineRef = useRef<SearchEngine | null>(null)
  const zipContainerRef = useRef<ZipContainer | null>(null)

  // Handle location change
  const handleLocationChange = useCallback(
    (newLocation: Location) => {
      setLocation(newLocation)
      onLocationChange?.(newLocation)

      // Persist
      readerStorage.savePosition(
        bookId,
        newLocation.cfi,
        newLocation.spineHref,
        newLocation.percentage
      )
    },
    [bookId, onLocationChange]
  )

  // Initialize
  useEffect(() => {
    let cancelled = false

    async function init() {
      if (!bookUrl || !containerRef.current) return

      try {
        // Load settings
        let resolvedSettings = DEFAULT_SETTINGS
        const storedSettings = await readerStorage.getSettings()
        if (storedSettings) {
          const bookSettings = storedSettings.perBook[bookId]
          resolvedSettings = {
            ...DEFAULT_SETTINGS,
            ...storedSettings.global,
            ...bookSettings,
          }
          setSettings(resolvedSettings)
        }

        // Download
        setState({ status: 'downloading', progress: 0 })
        const result = await epubFetcher.fetch(bookUrl, {
          headers: authHeaders,
          onProgress: (p) => {
            if (!cancelled) {
              setState({ status: 'downloading', progress: p.percentage })
            }
          },
        })

        if (cancelled) return

        // Unpack
        setState({ status: 'unpacking' })
        const container = await ZipContainer.fromBlob(result.blob)
        zipContainerRef.current = container

        if (cancelled) return

        // Parse
        setState({ status: 'parsing' })
        const parser = new EpubParser(container)
        const pub = await parser.parse()

        if (cancelled) return

        setPublication(pub)

        // Setup modules
        const resourceResolver = new EpubResourceResolver(container, pub.basePath)
        resourceResolverRef.current = resourceResolver

        const annotationManager = new AnnotationManager({
          bookId,
          spineItems: pub.spine,
          onAnnotationChange: setAnnotations,
        })
        annotationManagerRef.current = annotationManager

        const savedAnnotations = await readerStorage.getAnnotationsForBook(bookId)
        annotationManager.loadAnnotations(savedAnnotations)

        const searchEngine = new SearchEngine({
          bookId,
          container,
          spineItems: pub.spine,
        })
        searchEngineRef.current = searchEngine

        // Renderer
        const renderer = new EpubRenderer({
          container: containerRef.current!,
          resourceResolver,
          spineItems: pub.spine,
          settings: resolvedSettings,
          onLocationChange: handleLocationChange,
        })
        rendererRef.current = renderer

        // Initial position
        let startCfi = initialCfi
        if (!startCfi) {
          const savedPos = await readerStorage.getPosition(bookId)
          if (savedPos) startCfi = savedPos.cfi
        }

        setState({ status: 'rendering', spineIndex: 0 })

        if (startCfi) {
          await renderer.goToCfi(startCfi)
        } else {
          await renderer.display(0)
        }

        if (cancelled) return

        setState({ status: 'ready' })
        onReady?.(pub)

        readerStorage.updateBookLastOpened(bookId)
        searchEngine.buildIndex()
      } catch (error) {
        if (cancelled) return

        const readerError: ReaderError = {
          code: 'INIT_FAILED',
          message: error instanceof Error ? error.message : 'Failed to initialize reader',
          details: error,
          recoverable: false,
        }

        setState({ status: 'error', error: readerError })
        onError?.(readerError)
      }
    }

    init()

    return () => {
      cancelled = true
      rendererRef.current?.destroy()
      resourceResolverRef.current?.revokeAll()
      zipContainerRef.current?.close()
    }
  }, [bookUrl, bookId, authHeaders, initialCfi, containerRef, handleLocationChange, onReady, onError])

  // Update settings on renderer
  useEffect(() => {
    rendererRef.current?.updateSettings(settings)
  }, [settings])

  // Navigation
  const next = useCallback(() => {
    rendererRef.current?.next()
  }, [])

  const prev = useCallback(() => {
    rendererRef.current?.prev()
  }, [])

  const goTo = useCallback((target: string | number) => {
    if (typeof target === 'number') {
      rendererRef.current?.display(target)
    } else if (target.startsWith('epubcfi(')) {
      rendererRef.current?.goToCfi(target)
    } else {
      // Assume it's an href
      const spineIndex = publication?.spine.findIndex((item) => {
        const itemHref = item.href.split('#')[0]
        const linkHref = target.split('#')[0]
        return itemHref === linkHref || itemHref.endsWith(linkHref)
      })

      if (spineIndex !== undefined && spineIndex >= 0) {
        const fragment = target.split('#')[1]
        rendererRef.current?.display(spineIndex).then(() => {
          if (fragment) {
            rendererRef.current?.goToFragment(fragment)
          }
        })
      }
    }
  }, [publication])

  const goToSpineItem = useCallback((index: number, elementId?: string) => {
    rendererRef.current?.display(index).then(() => {
      if (elementId) {
        rendererRef.current?.goToFragment(elementId)
      }
    })
  }, [])

  // Settings
  const updateSettings = useCallback(
    (newSettings: Partial<ReaderSettings>) => {
      setSettings((prev) => {
        const updated = { ...prev, ...newSettings }
        readerStorage.saveBookSettings(bookId, updated)
        return updated
      })
    },
    [bookId]
  )

  // Annotations
  const addBookmark = useCallback(() => {
    if (!location || !annotationManagerRef.current) return null

    const bookmark = annotationManagerRef.current.addBookmark(
      location.cfi,
      location.spineIndex,
      location.spineHref,
      location.textExcerpt
    )

    readerStorage.saveAnnotation(bookmark)
    return bookmark
  }, [location])

  const addHighlight = useCallback(
    (color: HighlightColor = 'yellow', note?: string) => {
      const doc = rendererRef.current?.getDocument()
      if (!doc || !location || !annotationManagerRef.current) return null

      const selection = doc.getSelection()
      if (!selection || selection.isCollapsed) return null

      const highlight = annotationManagerRef.current.addHighlightFromSelection(
        selection,
        location.spineIndex,
        color,
        note
      )

      if (highlight) {
        readerStorage.saveAnnotation(highlight)
        selection.removeAllRanges()
      }

      return highlight
    },
    [location]
  )

  const removeAnnotation = useCallback((id: string) => {
    annotationManagerRef.current?.removeAnnotation(id)
    readerStorage.deleteAnnotation(id)
  }, [])

  // Search
  const search = useCallback(async (query: string): Promise<SearchResult[]> => {
    if (!searchEngineRef.current) return []
    return searchEngineRef.current.search(query)
  }, [])

  // Document access
  const getDocument = useCallback(() => {
    return rendererRef.current?.getDocument() || null
  }, [])

  return {
    state,
    publication,
    location,
    settings,
    annotations,
    next,
    prev,
    goTo,
    goToSpineItem,
    updateSettings,
    addBookmark,
    addHighlight,
    removeAnnotation,
    search,
    getDocument,
  }
}
