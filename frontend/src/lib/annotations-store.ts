import { useMemo, useSyncExternalStore } from 'react'

// ============================================================================
// Types
// ============================================================================

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

export interface ReaderAnnotation {
  id: string
  bookId: string
  spineIndex: number
  selectedText: string
  color: HighlightColor
  note?: string
  createdAt: number
  updatedAt: number
}

export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: 'rgba(255, 235, 59, 0.4)',
  green: 'rgba(76, 175, 80, 0.4)',
  blue: 'rgba(33, 150, 243, 0.4)',
  pink: 'rgba(233, 30, 99, 0.4)',
  purple: 'rgba(156, 39, 176, 0.4)',
}

export const HIGHLIGHT_COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  pink: 'Pink',
  purple: 'Purple',
}

export const ALL_HIGHLIGHT_COLORS: Array<HighlightColor> = [
  'yellow',
  'green',
  'blue',
  'pink',
  'purple',
]

// ============================================================================
// Storage helpers
// ============================================================================

const STORAGE_PREFIX = 'mfv2:annotations:'
const LOCAL_EVENT = 'mfv2:annotations:changed'

function storageKey(bookId: string): string {
  return `${STORAGE_PREFIX}${bookId}`
}

function safeParse(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function coerceAnnotation(raw: unknown): ReaderAnnotation | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  if (typeof obj.id !== 'string' || obj.id === '') return null
  if (typeof obj.bookId !== 'string' || obj.bookId === '') return null
  if (typeof obj.spineIndex !== 'number' || !Number.isFinite(obj.spineIndex))
    return null
  if (typeof obj.selectedText !== 'string' || obj.selectedText === '')
    return null
  if (typeof obj.createdAt !== 'number') return null
  if (typeof obj.updatedAt !== 'number') return null

  const validColors: Array<HighlightColor> = [
    'yellow',
    'green',
    'blue',
    'pink',
    'purple',
  ]
  const color = validColors.includes(obj.color as HighlightColor)
    ? (obj.color as HighlightColor)
    : 'yellow'

  const note =
    typeof obj.note === 'string' && obj.note.trim() !== '' ? obj.note : undefined

  return {
    id: obj.id,
    bookId: obj.bookId,
    spineIndex: obj.spineIndex,
    selectedText: obj.selectedText,
    color,
    note,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  }
}

function readRaw(bookId: string): string | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined')
    return null
  try {
    return localStorage.getItem(storageKey(bookId))
  } catch {
    return null
  }
}

function writeRaw(bookId: string, annotations: Array<ReaderAnnotation>): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined')
    return
  try {
    localStorage.setItem(storageKey(bookId), JSON.stringify(annotations))
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: { bookId } }))
  } catch {
    // ignore
  }
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

// ============================================================================
// Public API
// ============================================================================

export function getAnnotations(bookId: string): Array<ReaderAnnotation> {
  const raw = safeParse(readRaw(bookId))
  if (!Array.isArray(raw)) return []
  return raw
    .map(coerceAnnotation)
    .filter((a): a is ReaderAnnotation => a !== null)
}

export function getAnnotationsForSpine(
  bookId: string,
  spineIndex: number,
): Array<ReaderAnnotation> {
  return getAnnotations(bookId).filter((a) => a.spineIndex === spineIndex)
}

export function addAnnotation(
  bookId: string,
  params: {
    spineIndex: number
    selectedText: string
    color?: HighlightColor
    note?: string
  },
): ReaderAnnotation {
  const annotations = getAnnotations(bookId)
  const now = Date.now()
  const annotation: ReaderAnnotation = {
    id: generateId(),
    bookId,
    spineIndex: params.spineIndex,
    selectedText: params.selectedText,
    color: params.color ?? 'yellow',
    note: params.note,
    createdAt: now,
    updatedAt: now,
  }
  annotations.push(annotation)
  writeRaw(bookId, annotations)
  return annotation
}

export function updateAnnotation(
  bookId: string,
  annotationId: string,
  updates: Partial<Pick<ReaderAnnotation, 'color' | 'note'>>,
): ReaderAnnotation | null {
  const annotations = getAnnotations(bookId)
  const idx = annotations.findIndex((a) => a.id === annotationId)
  if (idx < 0) return null

  const annotation = annotations[idx]
  if (updates.color !== undefined) {
    annotation.color = updates.color
  }
  if (updates.note !== undefined) {
    annotation.note = updates.note !== '' ? updates.note : undefined
  }
  annotation.updatedAt = Date.now()
  annotations[idx] = annotation
  writeRaw(bookId, annotations)
  return annotation
}

export function removeAnnotation(
  bookId: string,
  annotationId: string,
): boolean {
  const annotations = getAnnotations(bookId)
  const idx = annotations.findIndex((a) => a.id === annotationId)
  if (idx < 0) return false
  annotations.splice(idx, 1)
  writeRaw(bookId, annotations)
  return true
}

// ============================================================================
// React hook
// ============================================================================

function subscribeForBook(
  bookId: string,
  callback: () => void,
): () => void {
  if (typeof window === 'undefined') return () => {}

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== storageKey(bookId)) return
    callback()
  }

  const onLocal = (event: Event): void => {
    const detail = (event as CustomEvent).detail as
      | { bookId?: string }
      | undefined
    if (detail?.bookId !== bookId) return
    callback()
  }

  window.addEventListener('storage', onStorage)
  window.addEventListener(LOCAL_EVENT, onLocal)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(LOCAL_EVENT, onLocal)
  }
}

export function useAnnotations(
  bookId: string | null,
): Array<ReaderAnnotation> {
  const subscribe = useMemo(() => {
    if (bookId === null || bookId === '') {
      return (_cb: () => void): (() => void) => () => {}
    }
    return (cb: () => void): (() => void) => subscribeForBook(bookId, cb)
  }, [bookId])

  const getSnapshot = useMemo(() => {
    if (bookId === null || bookId === '') return () => null
    return () => readRaw(bookId)
  }, [bookId])

  const raw = useSyncExternalStore(subscribe, getSnapshot, () => null)

  return useMemo(() => {
    if (bookId === null || bookId === '' || raw === null) return []
    const parsed = safeParse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(coerceAnnotation)
      .filter((a): a is ReaderAnnotation => a !== null)
  }, [bookId, raw])
}

// ============================================================================
// Highlight rendering utilities
// ============================================================================

/**
 * Find and wrap matching text in the document with highlight spans.
 * Returns the created highlight elements.
 */
export function renderHighlightsInDocument(
  doc: Document,
  annotations: Array<ReaderAnnotation>,
): Array<HTMLElement> {
  const elements: Array<HTMLElement> = []

  for (const annotation of annotations) {
    const found = findAndHighlightText(doc, annotation)
    elements.push(...found)
  }

  return elements
}

/**
 * Remove all highlight spans from the document.
 */
export function clearHighlightsInDocument(doc: Document): void {
  const highlights = doc.querySelectorAll('[data-annotation-id]')
  for (const hl of highlights) {
    const parent = hl.parentNode
    if (parent === null) continue
    const textNode = doc.createTextNode(hl.textContent ?? '') // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- textContent can be null per DOM spec
    parent.replaceChild(textNode, hl)
    parent.normalize()
  }
}

function findAndHighlightText(
  doc: Document,
  annotation: ReaderAnnotation,
): Array<HTMLElement> {
  const searchText = annotation.selectedText
  if (searchText.trim() === '') return []

  const body = doc.body as HTMLElement | null
  if (body === null) return []

  // Walk text nodes and find the matching text
  const textNodes: Array<Text> = []
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    textNodes.push(node as Text)
    node = walker.nextNode()
  }

  // Build a concatenated text and find the search text
  const chunks: Array<{ node: Text; start: number; length: number }> = []
  let fullText = ''
  for (const tn of textNodes) {
    const text = tn.nodeValue ?? ''
    chunks.push({ node: tn, start: fullText.length, length: text.length })
    fullText += text
  }

  // Normalize whitespace for matching
  const normalizedSearch = searchText.replace(/\s+/g, ' ').trim()
  const normalizedFull = fullText.replace(/\s+/g, ' ')

  // Map positions from normalized to original
  const origToNorm: Array<number> = []
  const normToOrig: Array<number> = []
  let ni = 0
  for (let oi = 0; oi < fullText.length; oi++) {
    origToNorm.push(ni)
    if (ni < normalizedFull.length && fullText[oi] === normalizedFull[ni]) {
      normToOrig.push(oi)
      ni++
    } else if (/\s/.test(fullText[oi] ?? '')) {
      // whitespace in original that was collapsed
    } else {
      normToOrig.push(oi)
      ni++
    }
  }
  // Fill remaining
  while (normToOrig.length < normalizedFull.length) {
    normToOrig.push(fullText.length)
  }

  const normIdx = normalizedFull.indexOf(normalizedSearch)
  if (normIdx < 0) return []

  const origStart = normToOrig[normIdx] ?? 0
  const endNormIdx = normIdx + normalizedSearch.length - 1
  const origEndVal = normToOrig[endNormIdx]
  const origEnd =
    typeof origEndVal === 'number' ? origEndVal + 1 : origStart + searchText.length

  // Find which text nodes are affected
  const elements: Array<HTMLElement> = []
  const color = HIGHLIGHT_COLORS[annotation.color]

  for (const chunk of chunks) {
    const chunkEnd = chunk.start + chunk.length
    if (chunkEnd <= origStart || chunk.start >= origEnd) continue

    const startInNode = Math.max(0, origStart - chunk.start)
    const endInNode = Math.min(chunk.length, origEnd - chunk.start)

    if (startInNode >= endInNode) continue

    const textContent = chunk.node.nodeValue ?? ''
    const before = textContent.slice(0, startInNode)
    const middle = textContent.slice(startInNode, endInNode)
    const after = textContent.slice(endInNode)

    const parent = chunk.node.parentNode
    if (parent === null) continue

    const wrapper = doc.createElement('span')
    wrapper.setAttribute('data-annotation-id', annotation.id)
    wrapper.setAttribute('data-annotation-color', annotation.color)
    wrapper.style.cssText = `
      background-color: ${color};
      cursor: pointer;
      border-radius: 2px;
      transition: background-color 150ms ease;
    `

    if (annotation.note !== undefined && annotation.note !== '') {
      wrapper.style.borderBottom = '2px dashed currentColor'
      wrapper.title = annotation.note
    }

    wrapper.textContent = middle

    if (before !== '') {
      parent.insertBefore(doc.createTextNode(before), chunk.node)
    }
    parent.insertBefore(wrapper, chunk.node)
    if (after !== '') {
      parent.insertBefore(doc.createTextNode(after), chunk.node)
    }
    parent.removeChild(chunk.node)

    elements.push(wrapper)
  }

  return elements
}
