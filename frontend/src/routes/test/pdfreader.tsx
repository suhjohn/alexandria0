import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import { PdfReader, type PdfReaderSettings } from '@/components/pdfreader'
import type { ReaderHandle } from '@/components/reader-shared/types'

export const Route = createFileRoute('/test/pdfreader')({
  component: PdfReaderTestPage,
})

type DumpValue = unknown

function summarizeParts(
  parts: Awaited<ReturnType<ReaderHandle['getPageRangeParts']>>,
) {
  if (!parts) return null
  return parts.map((part, index) => {
    if (part.type === 'text') {
      return {
        index,
        type: 'text',
        chars: part.text.length,
        preview: part.text.slice(0, 240),
      }
    }
    const image = typeof part.image === 'string' ? part.image : ''
    const comma = image.indexOf(',')
    const payload = comma >= 0 ? image.slice(comma + 1) : image
    return {
      index,
      type: 'image',
      bytes: Math.ceil((payload.length * 3) / 4),
    }
  })
}

function PdfReaderTestPage() {
  const allow =
    !import.meta.env.PROD || String(import.meta.env.VITE_E2E ?? '') === '1'
  if (!allow) return null

  const search = useMemo(
    () =>
      new URLSearchParams(
        typeof window === 'undefined' ? '' : window.location.search,
      ),
    [],
  )
  const url = search.get('url') || '/test-fixtures/sample.pdf'
  const hasTextLayer = search.get('textLayer') === '1'
  const readerRef = useRef<ReaderHandle | null>(null)
  const [settings, setSettings] = useState<PdfReaderSettings>({
    spread: 'auto',
    fit: 'page',
    zoom: 1,
    theme: 'light',
  })
  const [jump, setJump] = useState('1')
  const [dump, setDump] = useState<DumpValue>(null)

  const writeDump = (value: DumpValue) => {
    setDump(value)
  }

  const run = async (
    label: string,
    fn: () => Promise<DumpValue> | DumpValue,
  ) => {
    try {
      writeDump({ label, value: await fn() })
    } catch (err) {
      writeDump({
        label,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div className="h-screen">
      <div className="border-b border-[color:var(--accent-soft)] bg-[color:var(--paper)] p-2 text-xs text-[color:var(--ink)]">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded border border-[color:var(--accent-soft)] px-2 py-1"
            onClick={() => readerRef.current?.prev()}
          >
            Prev
          </button>
          <button
            type="button"
            className="rounded border border-[color:var(--accent-soft)] px-2 py-1"
            onClick={() => readerRef.current?.next()}
          >
            Next
          </button>
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              readerRef.current?.goToHref(String(Number.parseInt(jump, 10) - 1))
            }}
          >
            <input
              className="w-16 rounded border border-[color:var(--accent-soft)] bg-transparent px-2 py-1"
              value={jump}
              onChange={(event) => setJump(event.target.value)}
              aria-label="Jump to page"
            />
            <button
              type="submit"
              className="rounded border border-[color:var(--accent-soft)] px-2 py-1"
            >
              Jump
            </button>
          </form>
          <button
            type="button"
            className="rounded border border-[color:var(--accent-soft)] px-2 py-1"
            onClick={() =>
              setSettings((prev) => ({
                ...prev,
                spread:
                  prev.spread === 'auto'
                    ? 'single'
                    : prev.spread === 'single'
                      ? 'double'
                      : 'auto',
              }))
            }
          >
            Spread: {settings.spread}
          </button>
          <button
            type="button"
            className="rounded border border-[color:var(--accent-soft)] px-2 py-1"
            onClick={() =>
              setSettings((prev) => ({
                ...prev,
                fit: prev.fit === 'page' ? 'width' : 'page',
              }))
            }
          >
            Fit: {settings.fit}
          </button>
          <button
            type="button"
            className="rounded border border-[color:var(--accent-soft)] px-2 py-1"
            onClick={() =>
              void run('getVisiblePage', () =>
                readerRef.current?.getVisiblePage(),
              )
            }
          >
            Dump visible
          </button>
          <button
            type="button"
            className="rounded border border-[color:var(--accent-soft)] px-2 py-1"
            onClick={() =>
              void run('getPageRangeParts', async () =>
                summarizeParts(
                  await readerRef.current?.getPageRangeParts({
                    startPage: 0,
                    endPage: 2,
                    maxChars: 2000,
                  }),
                ),
              )
            }
          >
            Dump parts
          </button>
          <span className="truncate">url={url}</span>
        </div>
        <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded border border-[color:var(--accent-soft)] p-2">
          {dump ? JSON.stringify(dump, null, 2) : ''}
        </pre>
      </div>
      <PdfReader
        ref={readerRef}
        bookUrl={url}
        bookId="pdf-test"
        bookTitle="PDF Test"
        hasTextLayer={hasTextLayer}
        initialSettings={settings}
        onSettingsChange={setSettings}
        className="h-[calc(100vh-126px)]"
        onReady={(info) => writeDump({ label: 'ready', value: info })}
        onLocationChange={(loc) => setJump(String(loc.pageIndex + 1))}
        onTocChange={(toc) => writeDump({ label: 'toc', value: toc })}
        onSelectionChange={(selection) =>
          selection ? writeDump({ label: 'selection', value: selection }) : null
        }
        onError={(err) => writeDump({ label: 'error', error: err.message })}
      />
    </div>
  )
}
