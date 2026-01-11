// Main EPUB Reader Component
// Integrates all modules into a complete reading experience

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import type {
  Publication,
  Location,
  ReaderSettings,
  ReaderState,
  ReaderError,
  Annotation,
  SearchResult,
  HighlightColor,
  DEFAULT_SETTINGS,
} from './types'
import { epubFetcher } from './core/fetcher'
import { ZipContainer } from './core/container'
import { EpubParser } from './core/parser'
import { EpubResourceResolver } from './core/resources'
import { EpubRenderer } from './rendering/renderer'
import { AnnotationManager } from './annotations'
import { SearchEngine } from './search'
import { readerStorage } from './storage'
import { ReaderToolbar } from './ui/ReaderToolbar'

export interface EpubReaderProps {
  bookUrl: string
  bookId: string
  authHeaders?: Record<string, string>
  initialCfi?: string
  onReady?: (publication: Publication) => void
  onLocationChange?: (location: Location) => void
  onError?: (error: ReaderError) => void
  onClose?: () => void
  className?: string
}

const DEFAULT_READER_SETTINGS: ReaderSettings = {
  theme: 'light',
  fontFamily: 'publisher',
  fontSize: 1.0,
  lineHeight: 1.6,
  marginSize: 'medium',
  textAlign: 'left',
  paragraphSpacing: 1.0,
  mode: 'paginated',
}

export function EpubReader({
  bookUrl,
  bookId,
  authHeaders,
  initialCfi,
  onReady,
  onLocationChange,
  onError,
  onClose,
  className = '',
}: EpubReaderProps) {
  // State
  const [readerState, setReaderState] = useState<ReaderState>({ status: 'idle' })
  const [publication, setPublication] = useState<Publication | null>(null)
  const [location, setLocation] = useState<Location | null>(null)
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [showToolbar, setShowToolbar] = useState(true)

  // Refs
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<EpubRenderer | null>(null)
  const resourceResolverRef = useRef<EpubResourceResolver | null>(null)
  const annotationManagerRef = useRef<AnnotationManager | null>(null)
  const searchEngineRef = useRef<SearchEngine | null>(null)
  const zipContainerRef = useRef<ZipContainer | null>(null)

  // Handle location changes
  const handleLocationChange = useCallback(
    (newLocation: Location) => {
      setLocation(newLocation)
      onLocationChange?.(newLocation)

      // Persist position
      readerStorage.savePosition(
        bookId,
        newLocation.cfi,
        newLocation.spineHref,
        newLocation.percentage
      )
    },
    [bookId, onLocationChange]
  )

  // Initialize reader
  useEffect(() => {
    let cancelled = false

    async function initialize() {
      if (!bookUrl || !containerRef.current) return

      try {
        // Load settings
        let resolvedSettings = DEFAULT_READER_SETTINGS
        const storedSettings = await readerStorage.getSettings()
        if (storedSettings) {
          const bookSettings = storedSettings.perBook[bookId]
          resolvedSettings = {
            ...DEFAULT_READER_SETTINGS,
            ...storedSettings.global,
            ...bookSettings,
          }
          setSettings(resolvedSettings)
        }

        // Download EPUB
        setReaderState({ status: 'downloading', progress: 0 })

        const fetchCredentials = (() => {
          try {
            const url = new URL(bookUrl)
            return url.pathname.includes('/books/') && url.pathname.endsWith('/file')
              ? ('include' as const)
              : ('same-origin' as const)
          } catch {
            return 'same-origin' as const
          }
        })()

        const result = await epubFetcher.fetch(bookUrl, {
          headers: authHeaders,
          credentials: fetchCredentials,
          onProgress: (progress) => {
            if (!cancelled) {
              setReaderState({ status: 'downloading', progress: progress.percentage })
            }
          },
        })

        if (cancelled) return

        // Unpack ZIP
        setReaderState({ status: 'unpacking' })
        const container = await ZipContainer.fromBlob(result.blob)
        zipContainerRef.current = container

        if (cancelled) return

        // Parse EPUB
        setReaderState({ status: 'parsing' })
        const parser = new EpubParser(container)
        const pub = await parser.parse()

        if (cancelled) return

        setPublication(pub)

        // Create resource resolver
        const resourceResolver = new EpubResourceResolver(container, pub.basePath)
        resourceResolverRef.current = resourceResolver

        // Create annotation manager
        const annotationManager = new AnnotationManager({
          bookId,
          spineItems: pub.spine,
          onAnnotationChange: setAnnotations,
        })
        annotationManagerRef.current = annotationManager

        // Load saved annotations
        const savedAnnotations = await readerStorage.getAnnotationsForBook(bookId)
        annotationManager.loadAnnotations(savedAnnotations)

        // Create search engine
        const searchEngine = new SearchEngine({
          bookId,
          container,
          spineItems: pub.spine,
        })
        searchEngineRef.current = searchEngine

        // Create renderer
        if (!containerRef.current) return

        const renderer = new EpubRenderer({
          container: containerRef.current,
          resourceResolver,
          spineItems: pub.spine,
          settings: resolvedSettings,
          onLocationChange: handleLocationChange,
          onLinkClick: (href, isInternal) => {
            if (!isInternal) {
              // Open external links in new tab
              window.open(href, '_blank', 'noopener,noreferrer')
            }
          },
          onSelectionChange: (selection, cfi) => {
            // Could show a highlight menu here
          },
        })
        rendererRef.current = renderer

        // Get initial position
        let startCfi = initialCfi
        if (!startCfi) {
          const savedPosition = await readerStorage.getPosition(bookId)
          if (savedPosition) {
            startCfi = savedPosition.cfi
          }
        }

        // Render
        setReaderState({ status: 'rendering', spineIndex: 0 })

        if (startCfi) {
          await renderer.goToCfi(startCfi)
        } else {
          await renderer.display(0)
        }

        if (cancelled) return

        setReaderState({ status: 'ready' })
        onReady?.(pub)

        // Update last opened
        readerStorage.updateBookLastOpened(bookId)

        // Start building search index in background
        searchEngine.buildIndex()
      } catch (error) {
        if (cancelled) return

        const readerError: ReaderError = {
          code: 'INIT_FAILED',
          message: error instanceof Error ? error.message : 'Failed to initialize reader',
          details: error,
          recoverable: false,
        }

        setReaderState({ status: 'error', error: readerError })
        onError?.(readerError)
      }
    }

    initialize()

    return () => {
      cancelled = true
      // Clean up in order - renderer first (removes DOM elements), then others
      if (rendererRef.current) {
        rendererRef.current.destroy()
        rendererRef.current = null
      }
      if (resourceResolverRef.current) {
        resourceResolverRef.current.revokeAll()
        resourceResolverRef.current = null
      }
      if (zipContainerRef.current) {
        zipContainerRef.current.close()
        zipContainerRef.current = null
      }
      annotationManagerRef.current = null
      searchEngineRef.current = null
    }
  }, [bookUrl, bookId, authHeaders, initialCfi, handleLocationChange, onReady, onError])

  // Update renderer settings when they change
  useEffect(() => {
    rendererRef.current?.updateSettings(settings)
  }, [settings])

  // Navigation
  const handlePrev = useCallback(() => {
    rendererRef.current?.prev()
  }, [])

  const handleNext = useCallback(() => {
    rendererRef.current?.next()
  }, [])

  const handleNavigate = useCallback((href: string) => {
    const spineIndex = publication?.spine.findIndex((item) => {
      const itemHref = item.href.split('#')[0]
      const linkHref = href.split('#')[0]
      return itemHref === linkHref || itemHref.endsWith(linkHref)
    })

    if (spineIndex !== undefined && spineIndex >= 0) {
      const fragment = href.split('#')[1]
      rendererRef.current?.display(spineIndex).then(() => {
        if (fragment) {
          rendererRef.current?.goToFragment(fragment)
        }
      })
    }
  }, [publication])

  const handleNavigateToCfi = useCallback((cfi: string) => {
    rendererRef.current?.goToCfi(cfi)
  }, [])

  // Settings
  const handleSettingsChange = useCallback(
    (newSettings: Partial<ReaderSettings>) => {
      setSettings((prev) => {
        const updated = { ...prev, ...newSettings }

        // Persist settings
        readerStorage.saveBookSettings(bookId, updated)

        return updated
      })
    },
    [bookId]
  )

  // Bookmarks
  const handleAddBookmark = useCallback(() => {
    if (!location || !annotationManagerRef.current) return

    const bookmark = annotationManagerRef.current.addBookmark(
      location.cfi,
      location.spineIndex,
      location.spineHref,
      location.textExcerpt
    )

    readerStorage.saveAnnotation(bookmark)
  }, [location])

  const handleRemoveAnnotation = useCallback((id: string) => {
    annotationManagerRef.current?.removeAnnotation(id)
    readerStorage.deleteAnnotation(id)
  }, [])

  // Highlights
  const handleAddHighlight = useCallback(
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

  // Search
  const handleSearch = useCallback(
    async (query: string): Promise<SearchResult[]> => {
      if (!searchEngineRef.current) return []
      return searchEngineRef.current.search(query)
    },
    []
  )

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if in input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          e.preventDefault()
          handlePrev()
          break
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          e.preventDefault()
          handleNext()
          break
        case 'Home':
          e.preventDefault()
          rendererRef.current?.display(0)
          break
        case 'End':
          e.preventDefault()
          if (publication) {
            rendererRef.current?.display(publication.spine.length - 1)
          }
          break
        case 'Escape':
          setShowToolbar((prev) => !prev)
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlePrev, handleNext, publication])

  // Toggle toolbar on click
  const handleContainerClick = useCallback(() => {
    setShowToolbar((prev) => !prev)
  }, [])

  // Check if current position is bookmarked
  const isBookmarked = annotations.some(
    (a) => a.type === 'bookmark' && location?.cfi && a.location.cfi === location.cfi
  )

  // Theme styles
  const themeStyles = {
    light: { backgroundColor: '#ffffff', color: '#1a1a1a' },
    sepia: { backgroundColor: '#f4ecd8', color: '#5b4636' },
    dark: { backgroundColor: '#1a1a1a', color: '#e0e0e0' },
  }

  const currentThemeStyles = themeStyles[settings.theme]

  return (
    <div
      className={`epub-reader relative flex flex-col h-full ${className}`}
      style={currentThemeStyles}
    >
      {/* Toolbar */}
      {showToolbar && readerState.status === 'ready' && publication && (
        <div className="relative z-10" style={currentThemeStyles}>
          <ReaderToolbar
            title={publication.metadata.title}
            location={location || undefined}
            toc={publication.toc}
            settings={settings}
            annotations={annotations}
            isBookmarked={isBookmarked}
            onNavigate={handleNavigate}
            onNavigateToCfi={handleNavigateToCfi}
            onPrev={handlePrev}
            onNext={handleNext}
            onSettingsChange={handleSettingsChange}
            onAddBookmark={handleAddBookmark}
            onRemoveBookmark={handleRemoveAnnotation}
            onSearch={handleSearch}
            onClose={onClose}
          />
        </div>
      )}

      {/* Content Area */}
      <div
        className="flex-1 min-h-0 relative"
        onClick={handleContainerClick}
      >
        {/* Renderer Container - no React children, only DOM manipulation */}
        <div
          key={bookId}
          ref={containerRef}
          className="absolute inset-0"
          style={{ display: readerState.status === 'ready' ? 'block' : 'none' }}
        />

        {/* Loading States - separate from renderer container */}
        {readerState.status === 'downloading' && (
          <LoadingOverlay
            message="Downloading book..."
            progress={readerState.progress}
            style={currentThemeStyles}
          />
        )}

        {readerState.status === 'unpacking' && (
          <LoadingOverlay message="Unpacking..." style={currentThemeStyles} />
        )}

        {readerState.status === 'parsing' && (
          <LoadingOverlay message="Parsing..." style={currentThemeStyles} />
        )}

        {readerState.status === 'rendering' && (
          <LoadingOverlay message="Rendering..." style={currentThemeStyles} />
        )}

        {/* Error State */}
        {readerState.status === 'error' && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={currentThemeStyles}
          >
            <div className="text-center p-6 max-w-md">
              <p className="text-lg font-medium mb-2">Failed to load book</p>
              <p className="opacity-60 mb-4">{readerState.error.message}</p>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg border border-current/20 hover:bg-current/5 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Progress Bar */}
      {readerState.status === 'ready' && location && (
        <div className="h-1" style={{ backgroundColor: `${currentThemeStyles.color}20` }}>
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${location.percentage}%`,
              backgroundColor: currentThemeStyles.color,
              opacity: 0.3,
            }}
          />
        </div>
      )}
    </div>
  )
}

// Loading overlay component
function LoadingOverlay({
  message,
  progress,
  style,
}: {
  message: string
  progress?: number
  style: React.CSSProperties
}) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={style}
    >
      <div className="text-center">
        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4 opacity-60" />
        <p className="text-sm opacity-60">{message}</p>
        {progress !== undefined && (
          <div className="mt-2 w-48 h-1 rounded-full mx-auto" style={{ backgroundColor: 'currentColor', opacity: 0.2 }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${progress}%`, backgroundColor: 'currentColor', opacity: 0.6 }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// Export types and utilities
export * from './types'
export { readerStorage } from './storage'
