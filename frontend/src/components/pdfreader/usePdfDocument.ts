import { useEffect, useState } from 'react'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs'

// pdf.js touches browser globals (DOMMatrix, …) at module scope, so it must
// only ever be imported in the browser — never during SSR.
let pdfjsPromise: Promise<
  typeof import('pdfjs-dist/legacy/build/pdf.mjs')
> | null = null

export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ]).then(([mod, worker]) => {
      mod.GlobalWorkerOptions.workerSrc = worker.default
      return mod
    })
  }
  return pdfjsPromise
}

export type PdfOutlineEntry = {
  title: string
  pageIndex: number
  depth: number
}

export type PdfMetadata = {
  title?: string
  author?: string
}

export type UsePdfDocumentState = {
  doc: PDFDocumentProxy | null
  pageCount: number
  pageLabels: string[]
  outline: PdfOutlineEntry[]
  metadata: PdfMetadata
  loading: boolean
  error: Error | null
}

type PdfOutlineNode = {
  title?: string
  dest?: string | Array<unknown> | null
  items?: PdfOutlineNode[]
}

const emptyState: UsePdfDocumentState = {
  doc: null,
  pageCount: 0,
  pageLabels: [],
  outline: [],
  metadata: {},
  loading: true,
  error: null,
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function readMetadataInfo(info: object): PdfMetadata {
  const dict = info as { Title?: unknown; Author?: unknown }
  return {
    title: typeof dict.Title === 'string' ? dict.Title : undefined,
    author: typeof dict.Author === 'string' ? dict.Author : undefined,
  }
}

async function resolveOutlineDestination(
  doc: PDFDocumentProxy,
  dest: string | Array<unknown> | null | undefined,
): Promise<number | null> {
  const resolved =
    typeof dest === 'string' ? await doc.getDestination(dest) : dest
  if (!Array.isArray(resolved) || resolved.length === 0) return null
  const first = resolved[0]
  if (typeof first === 'number') {
    return first >= 0 && first < doc.numPages ? first : null
  }
  if (first && typeof first === 'object') {
    try {
      return await doc.getPageIndex(
        first as Parameters<PDFDocumentProxy['getPageIndex']>[0],
      )
    } catch {
      return null
    }
  }
  return null
}

async function flattenOutline(
  doc: PDFDocumentProxy,
  nodes: PdfOutlineNode[] | null,
  depth = 0,
): Promise<PdfOutlineEntry[]> {
  if (!nodes?.length) return []
  const entries: PdfOutlineEntry[] = []
  for (const node of nodes) {
    const pageIndex = await resolveOutlineDestination(doc, node.dest)
    if (pageIndex != null) {
      entries.push({
        title: String(node.title || `Page ${pageIndex + 1}`),
        pageIndex,
        depth,
      })
    }
    entries.push(...(await flattenOutline(doc, node.items ?? [], depth + 1)))
  }
  return entries
}

export function usePdfDocument(bookUrl: string): UsePdfDocumentState {
  const [state, setState] = useState<UsePdfDocumentState>(emptyState)

  useEffect(() => {
    let loadingTask: PDFDocumentLoadingTask | null = null
    let cancelled = false

    setState({ ...emptyState, loading: true })

    async function load() {
      try {
        // R2/MinIO must allow CORS GET requests with Range headers from app
        // origins, because pdf.js streams the presigned URL after the API 302.
        const pdfjs = await loadPdfjs()
        if (cancelled) return
        loadingTask = pdfjs.getDocument({
          url: bookUrl,
          withCredentials: true,
        })
        const doc = await loadingTask.promise
        if (cancelled) {
          await doc.destroy()
          return
        }

        const [rawLabels, rawOutline, rawMetadata] = await Promise.all([
          doc.getPageLabels().catch(() => null),
          doc.getOutline().catch(() => []),
          doc.getMetadata().catch(() => ({ info: {}, metadata: null })),
        ])
        if (cancelled) {
          await doc.destroy()
          return
        }

        const pageCount = doc.numPages
        const pageLabels =
          rawLabels && rawLabels.length === pageCount
            ? rawLabels.map((label, index) => label || String(index + 1))
            : Array.from({ length: pageCount }, (_, index) => String(index + 1))
        const outline = await flattenOutline(
          doc,
          rawOutline as PdfOutlineNode[],
        )
        if (cancelled) {
          await doc.destroy()
          return
        }

        setState({
          doc,
          pageCount,
          pageLabels,
          outline,
          metadata: readMetadataInfo(rawMetadata.info),
          loading: false,
          error: null,
        })
      } catch (err) {
        if (cancelled) return
        setState({ ...emptyState, loading: false, error: asError(err) })
      }
    }

    void load()

    return () => {
      cancelled = true
      void loadingTask?.destroy()
    }
  }, [bookUrl])

  return state
}
