// Reader Toolbar Component

import { useState, useRef, useEffect } from 'react'
import {
  Menu,
  Settings,
  Search,
  Bookmark,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
  X,
  List,
  Highlighter,
} from 'lucide-react'
import type { Location, TocItem, ReaderSettings, Annotation, SearchResult } from '../types'
import { TableOfContents } from './TableOfContents'
import { ReaderSettingsPanel } from './ReaderSettings'

interface ReaderToolbarProps {
  title: string
  location?: Location
  toc: TocItem[]
  settings: ReaderSettings
  annotations: Annotation[]
  isBookmarked: boolean
  onNavigate: (href: string) => void
  onNavigateToCfi: (cfi: string) => void
  onPrev: () => void
  onNext: () => void
  onSettingsChange: (settings: Partial<ReaderSettings>) => void
  onAddBookmark: () => void
  onRemoveBookmark: (id: string) => void
  onSearch: (query: string) => Promise<SearchResult[]>
  onClose?: () => void
  className?: string
}

export function ReaderToolbar({
  title,
  location,
  toc,
  settings,
  annotations,
  isBookmarked,
  onNavigate,
  onNavigateToCfi,
  onPrev,
  onNext,
  onSettingsChange,
  onAddBookmark,
  onRemoveBookmark,
  onSearch,
  onClose,
  className = '',
}: ReaderToolbarProps) {
  const [showToc, setShowToc] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showAnnotations, setShowAnnotations] = useState(false)

  const closeAllPanels = () => {
    setShowToc(false)
    setShowSettings(false)
    setShowSearch(false)
    setShowAnnotations(false)
  }

  return (
    <div className={`epub-toolbar ${className}`}>
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-current/10">
        <div className="flex items-center gap-2">
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-current/5 transition-colors"
              aria-label="Close reader"
            >
              <X className="w-5 h-5" />
            </button>
          )}

          <button
            onClick={() => {
              closeAllPanels()
              setShowToc(!showToc)
            }}
            className={`p-2 rounded-lg transition-colors ${showToc ? 'bg-current/10' : 'hover:bg-current/5'}`}
            aria-label="Table of contents"
          >
            <List className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 text-center px-4">
          <h1 className="text-sm font-medium truncate">{title}</h1>
          {location && (
            <p className="text-xs opacity-60">
              {Math.round(location.percentage)}% complete
              {location.displayedPage !== undefined && location.totalPages && (
                <span> &middot; Page {location.displayedPage + 1} of {location.totalPages}</span>
              )}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              closeAllPanels()
              setShowSearch(!showSearch)
            }}
            className={`p-2 rounded-lg transition-colors ${showSearch ? 'bg-current/10' : 'hover:bg-current/5'}`}
            aria-label="Search"
          >
            <Search className="w-5 h-5" />
          </button>

          <button
            onClick={() => {
              closeAllPanels()
              setShowAnnotations(!showAnnotations)
            }}
            className={`p-2 rounded-lg transition-colors ${showAnnotations ? 'bg-current/10' : 'hover:bg-current/5'}`}
            aria-label="Annotations"
          >
            <Highlighter className="w-5 h-5" />
          </button>

          <button
            onClick={() => {
              if (isBookmarked) {
                const bookmark = annotations.find(
                  (a) => a.type === 'bookmark' && a.location.cfi === location?.cfi
                )
                if (bookmark) onRemoveBookmark(bookmark.id)
              } else {
                onAddBookmark()
              }
            }}
            className="p-2 rounded-lg hover:bg-current/5 transition-colors"
            aria-label={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
          >
            {isBookmarked ? (
              <BookmarkCheck className="w-5 h-5 fill-current" />
            ) : (
              <Bookmark className="w-5 h-5" />
            )}
          </button>

          <button
            onClick={() => {
              closeAllPanels()
              setShowSettings(!showSettings)
            }}
            className={`p-2 rounded-lg transition-colors ${showSettings ? 'bg-current/10' : 'hover:bg-current/5'}`}
            aria-label="Settings"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Panels */}
      {showToc && (
        <Panel onClose={() => setShowToc(false)}>
          <TableOfContents
            toc={toc}
            currentLocation={location}
            onNavigate={(href) => {
              onNavigate(href)
              setShowToc(false)
            }}
          />
        </Panel>
      )}

      {showSettings && (
        <Panel onClose={() => setShowSettings(false)}>
          <ReaderSettingsPanel
            settings={settings}
            onSettingsChange={onSettingsChange}
          />
        </Panel>
      )}

      {showSearch && (
        <Panel onClose={() => setShowSearch(false)}>
          <SearchPanel
            onSearch={onSearch}
            onNavigate={(cfi) => {
              onNavigateToCfi(cfi)
              setShowSearch(false)
            }}
          />
        </Panel>
      )}

      {showAnnotations && (
        <Panel onClose={() => setShowAnnotations(false)}>
          <AnnotationsPanel
            annotations={annotations}
            onNavigate={(cfi) => {
              onNavigateToCfi(cfi)
              setShowAnnotations(false)
            }}
            onRemove={onRemoveBookmark}
          />
        </Panel>
      )}

      {/* Bottom Navigation */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-current/10">
        <button
          onClick={onPrev}
          className="flex items-center gap-1 px-3 py-2 rounded-lg hover:bg-current/5 transition-colors text-sm"
        >
          <ChevronLeft className="w-4 h-4" />
          Previous
        </button>

        <div className="flex-1" />

        <button
          onClick={onNext}
          className="flex items-center gap-1 px-3 py-2 rounded-lg hover:bg-current/5 transition-colors text-sm"
        >
          Next
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// Panel wrapper
function Panel({
  children,
  onClose,
}: {
  children: React.ReactNode
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  return (
    <div
      ref={panelRef}
      className="absolute top-full left-0 right-0 bg-inherit border-b border-current/10 shadow-lg z-50 max-h-[70vh] overflow-hidden"
    >
      {children}
    </div>
  )
}

// Search Panel
function SearchPanel({
  onSearch,
  onNavigate,
}: {
  onSearch: (query: string) => Promise<SearchResult[]>
  onNavigate: (cfi: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSearch = async () => {
    if (!query.trim()) return

    setIsSearching(true)
    try {
      const results = await onSearch(query)
      setResults(results)
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <div className="p-4">
      <div className="flex gap-2 mb-4">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search in book..."
          className="flex-1 px-3 py-2 rounded-lg border border-current/20 bg-transparent text-sm"
        />
        <button
          onClick={handleSearch}
          disabled={isSearching}
          className="px-4 py-2 rounded-lg bg-current/10 hover:bg-current/20 transition-colors text-sm"
        >
          {isSearching ? 'Searching...' : 'Search'}
        </button>
      </div>

      <div className="max-h-60 overflow-y-auto">
        {results.length === 0 ? (
          <p className="text-sm opacity-60 text-center py-4">
            {query ? 'No results found' : 'Enter a search term'}
          </p>
        ) : (
          <ul className="space-y-2">
            {results.map((result, index) => (
              <li key={index}>
                <button
                  onClick={() => onNavigate(result.cfi)}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-current/5 transition-colors"
                >
                  <p className="text-sm">{result.excerpt}</p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// Annotations Panel
function AnnotationsPanel({
  annotations,
  onNavigate,
  onRemove,
}: {
  annotations: Annotation[]
  onNavigate: (cfi: string) => void
  onRemove: (id: string) => void
}) {
  const bookmarks = annotations.filter((a) => a.type === 'bookmark')
  const highlights = annotations.filter((a) => a.type === 'highlight' || a.type === 'note')

  return (
    <div className="p-4">
      {/* Bookmarks */}
      <div className="mb-4">
        <h3 className="text-xs font-medium uppercase tracking-wider opacity-60 mb-2">
          Bookmarks ({bookmarks.length})
        </h3>
        {bookmarks.length === 0 ? (
          <p className="text-sm opacity-60">No bookmarks yet</p>
        ) : (
          <ul className="space-y-2">
            {bookmarks.map((bookmark) => (
              <li key={bookmark.id} className="flex items-center gap-2">
                <button
                  onClick={() => onNavigate(bookmark.location.cfi)}
                  className="flex-1 text-left px-3 py-2 rounded-lg hover:bg-current/5 transition-colors text-sm truncate"
                >
                  {bookmark.excerpt || 'Bookmark'}
                </button>
                <button
                  onClick={() => onRemove(bookmark.id)}
                  className="p-1 rounded hover:bg-current/10"
                  aria-label="Remove bookmark"
                >
                  <X className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Highlights */}
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wider opacity-60 mb-2">
          Highlights ({highlights.length})
        </h3>
        {highlights.length === 0 ? (
          <p className="text-sm opacity-60">No highlights yet</p>
        ) : (
          <ul className="space-y-2 max-h-40 overflow-y-auto">
            {highlights.map((highlight) => (
              <li key={highlight.id} className="flex items-start gap-2">
                <button
                  onClick={() => onNavigate(highlight.location.cfi)}
                  className="flex-1 text-left px-3 py-2 rounded-lg hover:bg-current/5 transition-colors"
                >
                  <p
                    className="text-sm border-l-2 pl-2"
                    style={{
                      borderColor: highlight.color === 'yellow' ? '#fef08a' :
                        highlight.color === 'green' ? '#86efac' :
                        highlight.color === 'blue' ? '#93c5fd' :
                        highlight.color === 'pink' ? '#f9a8d4' :
                        '#d8b4fe'
                    }}
                  >
                    {highlight.excerpt}
                  </p>
                  {highlight.note && (
                    <p className="text-xs opacity-60 mt-1">{highlight.note}</p>
                  )}
                </button>
                <button
                  onClick={() => onRemove(highlight.id)}
                  className="p-1 rounded hover:bg-current/10"
                  aria-label="Remove highlight"
                >
                  <X className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
