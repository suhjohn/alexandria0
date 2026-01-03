import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Loader2, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
// @ts-expect-error - epubjs doesn't have proper TypeScript definitions
import ePub from 'epubjs'
import type { Book } from '@/data/books'
import { getBookTransform, startBookTransform } from '@/data/books'

type BookReaderProps = {
  book: Book
  className?: string
}

export function BookReader({ book, className }: BookReaderProps) {
  const viewerRef = useRef<HTMLDivElement>(null)
  const epubBookRef = useRef<any>(null)
  const renditionRef = useRef<any>(null)

  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const transformQuery = useQuery({
    queryKey: ['transform', book.id],
    queryFn: () => getBookTransform(book.id),
    refetchInterval: (data) =>
      data?.status === 'pending' || data?.status === 'running' ? 5000 : false,
  })

  const startMutation = useMutation({
    mutationFn: () => startBookTransform(book.id),
    onError: (err: Error) => {
      setError(err.message || 'Failed to start transform')
    },
  })

  const transformUrl =
    transformQuery.data?.url || book.transformation_data?.modernify?.[0] || ''
  const displayUrl = transformUrl || book.url || ''

  useEffect(() => {
    if (!viewerRef.current) return
    setError(null)
    if (!displayUrl) {
      setIsLoading(false)
      setError('No available file to display.')
      return
    }
    setIsLoading(true)
    renditionRef.current?.destroy()

    const epubBook = ePub(displayUrl, { openAs: 'epub' })
    epubBookRef.current = epubBook

    const rendition = epubBook.renderTo(viewerRef.current, {
      width: '100%',
      height: '100%',
      spread: 'none',
      flow: 'scrolled-doc',
    })
    renditionRef.current = rendition
    rendition.themes.default({
      body: {
        margin: '0 auto',
        maxWidth: '720px',
        padding: '24px',
      },
    })

    rendition
      .display()
      .then(() => {
        setIsLoading(false)
      })
      .catch((err: Error) => {
        console.error('Error loading EPUB:', err)
        setError('Failed to load book. Please try again.')
        setIsLoading(false)
      })

    return () => {
      rendition?.destroy()
    }
  }, [book.id, displayUrl])

  const goToNextPage = () => {
    renditionRef.current?.next()
  }

  const goToPrevPage = () => {
    renditionRef.current?.prev()
  }

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        goToPrevPage()
      } else if (e.key === 'ArrowRight') {
        goToNextPage()
      }
    }

    window.addEventListener('keydown', handleKeyPress)
    return () => window.removeEventListener('keydown', handleKeyPress)
  }, [])

  const containerClassName = ['flex min-h-0 flex-col', className]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={containerClassName}>
      <div className="relative flex-1 min-h-0">
        {isLoading && displayUrl && (
          <div className="absolute inset-0 flex items-center justify-center bg-[color:var(--paper)]/95">
            <div className="text-center">
              <Loader2 className="w-12 h-12 text-[color:var(--accent)] animate-spin mx-auto mb-4" />
              <p className="text-[color:var(--ink)]/70 italic">
                Opening the volume...
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-[color:var(--paper)]/95">
            <div className="text-center max-w-md px-6">
              <p className="text-[color:var(--accent)] mb-4">{error}</p>
            </div>
          </div>
        )}

        {displayUrl ? (
          <div ref={viewerRef} className="w-full h-full min-h-0" />
        ) : null}

        {!isLoading && !error && displayUrl && (
          <>
            <button
              onClick={goToPrevPage}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-[color:var(--paper)]/80 hover:bg-[color:var(--paper-deep)] backdrop-blur-sm rounded-full transition-colors shadow-lg border border-[color:var(--accent-soft)]"
              aria-label="Previous page"
            >
              <ChevronLeft className="w-6 h-6 text-[color:var(--accent)]" />
            </button>
            <button
              onClick={goToNextPage}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-[color:var(--paper)]/80 hover:bg-[color:var(--paper-deep)] backdrop-blur-sm rounded-full transition-colors shadow-lg border border-[color:var(--accent-soft)]"
              aria-label="Next page"
            >
              <ChevronRight className="w-6 h-6 text-[color:var(--accent)]" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
