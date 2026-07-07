import type { ImagePart, ModelMessage, TextPart } from 'ai'

import type {
  EpubReaderV2CurrentBook,
  EpubReaderV2VisiblePage,
} from '@/components/epubreader_v2/types'

function truncateSnippet(text: string, maxChars: number) {
  const normalized = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (!normalized) return ''
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars))}…`
}

function stripHtmlLike(text: string): string {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type BookRefLike = {
  kind?: 'chapter' | 'page-range' | null
  refKind?: 'chapter' | 'page-range' | null
  bookId?: string | null
  bookTitle?: string | null
  href?: string | null
  chapterTitle?: string | null
  selectedText?: string | null
  spineIndex?: number | null
  startPage?: number | null
  endPage?: number | null
  pageLabel?: string | null
  pdfStartPage?: number | null
  pdfEndPage?: number | null
  pdfPageLabel?: string | null
}

export function currentBookSystemPrompt(
  currentBook:
    | (EpubReaderV2CurrentBook & {
        format?: 'epub' | 'pdf'
        hasTextLayer?: boolean | null
        pageCount?: number | null
      })
    | null,
): string {
  if (!currentBook) return ''

  const metadata = currentBook.metadata ?? {}
  const title = String(metadata.title ?? currentBook.bookTitle ?? '').trim()
  const author = String(metadata.author ?? '').trim()
  const language = String(metadata.language ?? '').trim()
  const publisher = String(metadata.publisher ?? '').trim()
  const date = String(metadata.date ?? '').trim()
  const identifier = String(metadata.identifier ?? '').trim()
  const modified = String(metadata.modified ?? '').trim()
  const subjects = Array.isArray(metadata.subjects) ? metadata.subjects : []
  const descriptionRaw = String(metadata.description ?? '').trim()
  const description = stripHtmlLike(descriptionRaw)

  const format = currentBook.format === 'pdf' ? 'pdf' : 'epub'
  const pageCount = Number(currentBook.pageCount ?? NaN)

  const lines: string[] = [
    format === 'pdf'
      ? 'You are a reading assistant embedded in a PDF reader.'
      : 'You are a reading assistant embedded in an EPUB reader.',
    'Use the current book metadata as context. Do not invent missing details.',
    format === 'pdf' && Number.isFinite(pageCount) && pageCount > 0
      ? `Pages: ${pageCount}`
      : undefined,
    format === 'pdf' && currentBook.hasTextLayer === false
      ? 'This PDF has no text layer; page content is provided to you as page images.'
      : undefined,
    '',
    'Current book metadata:',
    title ? `Title: ${truncateSnippet(title, 160)}` : undefined,
    author ? `Author: ${truncateSnippet(author, 120)}` : undefined,
    language ? `Language: ${truncateSnippet(language, 60)}` : undefined,
    publisher ? `Publisher: ${truncateSnippet(publisher, 120)}` : undefined,
    date ? `Date: ${truncateSnippet(date, 40)}` : undefined,
    subjects.length
      ? `Subjects: ${truncateSnippet(subjects.slice(0, 12).join(', '), 240)}`
      : undefined,
    identifier ? `Identifier: ${truncateSnippet(identifier, 120)}` : undefined,
    modified ? `Modified: ${truncateSnippet(modified, 40)}` : undefined,
    description
      ? `Description: ${truncateSnippet(description, 600)}`
      : undefined,
  ].filter(Boolean) as string[]

  return lines.join('\n').trim()
}

export async function buildVisiblePageMessage(options: {
  getCurrentReaderPage?: () => EpubReaderV2VisiblePage | null
  getCurrentReaderPageStable?: (options?: {
    timeoutMs?: number
  }) => Promise<EpubReaderV2VisiblePage | null>
  getCurrentReaderPageParts?: (options?: {
    maxChars?: number
    maxImages?: number
    maxImageBytes?: number
  }) => Promise<Array<TextPart | ImagePart> | null>
  getCurrentReaderPagePartsStable?: (options?: {
    maxChars?: number
    maxImages?: number
    maxImageBytes?: number
    timeoutMs?: number
  }) => Promise<Array<TextPart | ImagePart> | null>
}): Promise<ModelMessage | null> {
  const page =
    (await options.getCurrentReaderPageStable?.({ timeoutMs: 1200 })) ??
    options.getCurrentReaderPage?.() ??
    null
  if (!page) return null

  const href = String(page.href ?? '').trim()
  const pageLabel =
    page.chapterTotalPages > 1
      ? `Page: ${page.pageIndex + 1}/${page.chapterTotalPages}`
      : `Page: ${page.pageIndex + 1}`

  const headerLines: string[] = [
    'Currently visible page (may be partial):',
    href ? `Href: ${truncateSnippet(href, 180)}` : undefined,
    `SpineIndex: ${page.spineIndex}`,
    pageLabel,
  ].filter(Boolean) as string[]

  const parts: Array<TextPart | ImagePart> = [
    { type: 'text', text: headerLines.join('\n') },
  ]

  const basePartOptions = {
    maxChars: 8000,
  }
  const pageParts = options.getCurrentReaderPagePartsStable
    ? ((await options.getCurrentReaderPagePartsStable({
        ...basePartOptions,
        timeoutMs: 1200,
      })) ?? [])
    : ((await options.getCurrentReaderPageParts?.(basePartOptions)) ?? [])

  if (pageParts.length > 0) {
    parts.push({ type: 'text', text: '\nText:\n' }, ...pageParts)
    return { role: 'user', content: parts }
  }

  const fallbackText = String(page.text ?? '').trim()
  if (!fallbackText) return { role: 'user', content: parts }
  parts.push({
    type: 'text',
    text: `\nText:\n${truncateSnippet(fallbackText, 8000)}`,
  })
  return { role: 'user', content: parts }
}

export async function buildReferenceMessage(options: {
  refs: Array<BookRefLike>
  currentBookId: string
  getSpineItemText?: (options: {
    spineIndex: number
    maxChars?: number
  }) => Promise<string | null>
  getSpineItemParts?: (options: {
    spineIndex: number
    maxChars?: number
    maxImages?: number
    maxImageBytes?: number
  }) => Promise<Array<TextPart | ImagePart> | null>
  getPageRangeParts?: (options: {
    startPage: number
    endPage: number
    maxChars?: number
    maxImages?: number
    maxImageBytes?: number
  }) => Promise<Array<TextPart | ImagePart> | null>
}): Promise<ModelMessage | null> {
  const refsByKey = new Map<string, BookRefLike>()
  for (const ref of options.refs) {
    const kind =
      ref.kind === 'page-range' ||
      ref.refKind === 'page-range' ||
      Number.isFinite(Number(ref.pdfStartPage ?? NaN)) ||
      Number.isFinite(Number(ref.pdfEndPage ?? NaN))
        ? 'page-range'
        : 'chapter'
    const bookId = String(ref.bookId ?? '').trim()
    const spineIndex = Number(ref.spineIndex ?? NaN)
    const href = String(ref.href ?? '').trim()
    const chapterTitle = String(ref.chapterTitle ?? '').trim()
    const startPage = Number(ref.startPage ?? ref.pdfStartPage ?? NaN)
    const endPage = Number(ref.endPage ?? ref.pdfEndPage ?? startPage)
    const key =
      kind === 'page-range'
        ? `${kind}:${bookId}:${Number.isFinite(startPage) ? startPage : ''}:${Number.isFinite(endPage) ? endPage : ''}`
        : `${kind}:${bookId}:${Number.isFinite(spineIndex) ? spineIndex : ''}:${href}:${chapterTitle}`
    if (!refsByKey.has(key)) refsByKey.set(key, ref)
  }

  const refs = Array.from(refsByKey.values())
  if (refs.length === 0) return null

  const currentBookId = String(options.currentBookId ?? '').trim()
  const parts: Array<TextPart | ImagePart> = []

  const pushText = (text: string) => {
    const value = String(text ?? '')
    if (!value) return
    parts.push({ type: 'text', text: value })
  }

  for (const ref of refs) {
    const selectedText = String(ref.selectedText ?? '').trim()
    const bookId = String(ref.bookId ?? '').trim()
    const kind =
      ref.kind === 'page-range' ||
      ref.refKind === 'page-range' ||
      Number.isFinite(Number(ref.pdfStartPage ?? NaN)) ||
      Number.isFinite(Number(ref.pdfEndPage ?? NaN))
        ? 'page-range'
        : 'chapter'
    const startPage = Number(ref.startPage ?? ref.pdfStartPage ?? NaN)
    const endPage = Number(ref.endPage ?? ref.pdfEndPage ?? startPage)
    const spineIndex = Number(ref.spineIndex ?? NaN)
    if (kind === 'page-range') {
      if (bookId && currentBookId && bookId !== currentBookId) continue
      if (
        !options.getPageRangeParts ||
        !Number.isFinite(startPage) ||
        !Number.isFinite(endPage)
      ) {
        continue
      }

      const bookTitle = String(ref.bookTitle ?? '').trim() || 'Book'
      const fallbackLabel =
        startPage === endPage
          ? String(startPage + 1)
          : `${startPage + 1}–${endPage + 1}`
      const pageLabel =
        String(ref.pageLabel ?? ref.pdfPageLabel ?? '').trim() || fallbackLabel
      const entryParts =
        (await options.getPageRangeParts({
          startPage,
          endPage,
          maxChars: 18_000,
        })) ?? []
      if (entryParts.length === 0) continue
      if (parts.length > 0) pushText('\n\n---\n\n')
      pushText(
        [
          `Book: ${truncateSnippet(bookTitle, 120)}`,
          `Pages: ${truncateSnippet(pageLabel, 80)}`,
        ].join('\n'),
      )
      pushText('\n')
      parts.push(...entryParts)
      continue
    }

    if (!selectedText) {
      if (bookId && currentBookId && bookId !== currentBookId) continue
      if (!Number.isFinite(spineIndex)) continue
    }

    const bookTitle = String(ref.bookTitle ?? '').trim() || 'Book'
    const chapterTitle = String(ref.chapterTitle ?? '').trim()
    const href = String(ref.href ?? '').trim()

    const headerLines: string[] = [
      `Book: ${truncateSnippet(bookTitle, 120)}`,
      chapterTitle
        ? `Chapter: ${truncateSnippet(chapterTitle, 180)}`
        : undefined,
      href ? `Href: ${truncateSnippet(href, 180)}` : undefined,
      Number.isFinite(spineIndex) ? `SpineIndex: ${spineIndex}` : undefined,
    ].filter(Boolean) as string[]

    let added = false
    const entryParts: Array<TextPart | ImagePart> = []

    if (selectedText) {
      entryParts.push({
        type: 'text',
        text: `Text:\n${truncateSnippet(selectedText, 18_000)}`,
      })
      added = true
    } else if (options.getSpineItemParts) {
      const excerptParts =
        (await options.getSpineItemParts({
          spineIndex,
          maxChars: 18_000,
        })) ?? []
      if (excerptParts.length > 0) {
        entryParts.push({ type: 'text', text: 'Text:\n' }, ...excerptParts)
        added = true
      }
    } else if (options.getSpineItemText) {
      const excerpt =
        (await options.getSpineItemText({ spineIndex, maxChars: 18_000 })) ?? ''
      if (excerpt.trim()) {
        entryParts.push({
          type: 'text',
          text: `Text:\n${truncateSnippet(excerpt, 18_000)}`,
        })
        added = true
      }
    }

    if (!added) continue
    if (parts.length > 0) pushText('\n\n---\n\n')
    pushText(headerLines.join('\n'))
    pushText('\n')
    parts.push(...entryParts)
  }

  if (parts.length === 0) return null
  return { role: 'user', content: parts }
}
