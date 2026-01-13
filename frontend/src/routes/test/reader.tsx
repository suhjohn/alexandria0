import { createFileRoute } from '@tanstack/react-router'

import { useRef, useState } from 'react'
import { EpubReaderV2 } from '@/components/epubreader_v2'
import type { EpubReaderV2Handle } from '@/components/epubreader_v2'
import type { EpubReaderV2VisiblePage } from '@/components/epubreader_v2/types'

export const Route = createFileRoute('/test/reader')({
  component: ReaderTestPage,
})

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

function ReaderTestPage() {
  const allow =
    !import.meta.env.PROD || String(import.meta.env.VITE_E2E ?? '') === '1'
  if (!allow) return null

  const readerRef = useRef<EpubReaderV2Handle | null>(null)
  const [visiblePage, setVisiblePage] = useState<EpubReaderV2VisiblePage | null>(
    null,
  )
  const [lastSelection, setLastSelection] =
    useState<ReaderSelectionPayload | null>(null)
  const [lastAddedToChat, setLastAddedToChat] =
    useState<ReaderSelectionPayload | null>(null)
  const [pendingNavigation, setPendingNavigation] = useState<{
    id: string
    bookId: string
    spineIndex?: number
    textOffset?: number
    selectedText?: string
    href?: string
  } | null>(null)

  const refreshVisiblePage = async () => {
    const snap = await readerRef.current?.getVisiblePageStable({
      timeoutMs: 3000,
    })
    setVisiblePage(snap ?? null)
  }

  return (
    <div className="h-screen">
      <div className="p-2 text-xs font-mono border-b border-[color:var(--accent-soft)] bg-[color:var(--paper)] text-[color:var(--ink)]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded px-2 py-1 border border-[color:var(--accent-soft)]"
            onClick={() => void refreshVisiblePage()}
          >
            Refresh snapshot
          </button>
          <div data-testid="reader-test-page">
            pageIndex={visiblePage?.pageIndex ?? 'null'}
          </div>
          <div className="truncate" data-testid="reader-test-href">
            href={visiblePage?.href ?? 'null'}
          </div>
          {lastAddedToChat ? (
            <button
              type="button"
              data-testid="reader-test-chip"
              className="rounded px-2 py-1 border border-[color:var(--accent-soft)] bg-[color:var(--paper-deep)]"
              onClick={() => {
                const sel = lastAddedToChat
                if (!sel) return
                const id =
                  typeof crypto !== 'undefined' && 'randomUUID' in crypto
                    ? crypto.randomUUID()
                    : `nav_${Date.now()}`
                setPendingNavigation({
                  id,
                  bookId: String(sel.bookId ?? ''),
                  spineIndex: sel.spineIndex,
                  textOffset: sel.startIndex,
                  selectedText: String(sel.selectedText ?? ''),
                })
              }}
            >
              Chip: {String(lastAddedToChat.selectedText ?? '').slice(0, 24)}
              {String(lastAddedToChat.selectedText ?? '').length > 24
                ? '…'
                : ''}
            </button>
          ) : (
            <div data-testid="reader-test-chip-missing">chip=null</div>
          )}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <pre
            data-testid="reader-test-visible-text"
            className="whitespace-pre-wrap break-words max-h-24 overflow-auto rounded border border-[color:var(--accent-soft)] p-2"
          >
            {visiblePage?.text ?? ''}
          </pre>
          <pre
            data-testid="reader-test-selection"
            className="whitespace-pre-wrap break-words max-h-24 overflow-auto rounded border border-[color:var(--accent-soft)] p-2"
          >
            {lastSelection ? JSON.stringify(lastSelection, null, 2) : ''}
          </pre>
        </div>
      </div>
      <EpubReaderV2
        ref={readerRef}
        storageId=""
        bookUrl="/test/fixture.epub"
        className="h-full"
        onReady={() => void refreshVisiblePage()}
        onLocationChange={() => void refreshVisiblePage()}
        onSelectionChange={(sel) => setLastSelection(sel)}
        onAddSelectionToChat={(sel) => setLastAddedToChat(sel)}
        pendingNavigation={pendingNavigation}
        onConsumePendingNavigation={(id) => {
          setPendingNavigation((prev) => (prev?.id === id ? null : prev))
        }}
      />
    </div>
  )
}
