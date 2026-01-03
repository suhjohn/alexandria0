// Annotations Module
// Handles bookmarks, highlights, and notes

import type { Annotation, AnnotationType, HighlightColor, SpineItem } from '../types'
import { CfiResolver, CfiGenerator } from '../cfi'

const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: 'rgba(255, 235, 59, 0.4)',
  green: 'rgba(76, 175, 80, 0.4)',
  blue: 'rgba(33, 150, 243, 0.4)',
  pink: 'rgba(233, 30, 99, 0.4)',
  purple: 'rgba(156, 39, 176, 0.4)',
}

export interface AnnotationManagerOptions {
  bookId: string
  spineItems: SpineItem[]
  onAnnotationChange?: (annotations: Annotation[]) => void
}

export class AnnotationManager {
  private bookId: string
  private spineItems: SpineItem[]
  private annotations: Map<string, Annotation> = new Map()
  private highlightElements: Map<string, HTMLElement[]> = new Map()
  private cfiGenerator: CfiGenerator
  private cfiResolver: CfiResolver
  private onAnnotationChange?: (annotations: Annotation[]) => void

  constructor(options: AnnotationManagerOptions) {
    this.bookId = options.bookId
    this.spineItems = options.spineItems
    this.cfiGenerator = new CfiGenerator(options.spineItems)
    this.cfiResolver = new CfiResolver(options.spineItems)
    this.onAnnotationChange = options.onAnnotationChange
  }

  loadAnnotations(annotations: Annotation[]): void {
    this.annotations.clear()
    for (const annotation of annotations) {
      this.annotations.set(annotation.id, annotation)
    }
    this.notifyChange()
  }

  addBookmark(
    cfi: string,
    spineIndex: number,
    spineHref: string,
    excerpt?: string
  ): Annotation {
    const annotation: Annotation = {
      id: this.generateId(),
      bookId: this.bookId,
      type: 'bookmark',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      location: {
        cfi,
        spineHref,
        spineIndex,
      },
      excerpt,
    }

    this.annotations.set(annotation.id, annotation)
    this.notifyChange()

    return annotation
  }

  addHighlight(
    startCfi: string,
    endCfi: string,
    spineIndex: number,
    spineHref: string,
    excerpt: string,
    color: HighlightColor = 'yellow',
    note?: string
  ): Annotation {
    const annotation: Annotation = {
      id: this.generateId(),
      bookId: this.bookId,
      type: note ? 'note' : 'highlight',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      location: {
        cfi: startCfi,
        endCfi,
        spineHref,
        spineIndex,
      },
      excerpt,
      note,
      color,
    }

    this.annotations.set(annotation.id, annotation)
    this.notifyChange()

    return annotation
  }

  addHighlightFromSelection(
    selection: Selection,
    spineIndex: number,
    color: HighlightColor = 'yellow',
    note?: string
  ): Annotation | null {
    if (selection.rangeCount === 0 || selection.isCollapsed) {
      return null
    }

    const range = selection.getRangeAt(0)
    const cfi = this.cfiGenerator.generateFromRange(range, spineIndex)
    const excerpt = selection.toString().trim()

    if (!excerpt) return null

    const spineItem = this.spineItems[spineIndex]
    if (!spineItem) return null

    // For range CFI, we store the full CFI which contains both start and end
    const annotation: Annotation = {
      id: this.generateId(),
      bookId: this.bookId,
      type: note ? 'note' : 'highlight',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      location: {
        cfi,
        spineHref: spineItem.href,
        spineIndex,
      },
      excerpt,
      note,
      color,
    }

    this.annotations.set(annotation.id, annotation)
    this.notifyChange()

    return annotation
  }

  updateAnnotation(id: string, updates: Partial<Pick<Annotation, 'note' | 'color'>>): void {
    const annotation = this.annotations.get(id)
    if (!annotation) return

    if (updates.note !== undefined) {
      annotation.note = updates.note
      annotation.type = updates.note ? 'note' : 'highlight'
    }
    if (updates.color !== undefined) {
      annotation.color = updates.color
    }
    annotation.updatedAt = Date.now()

    this.notifyChange()
  }

  removeAnnotation(id: string): void {
    this.annotations.delete(id)
    this.clearHighlightElements(id)
    this.notifyChange()
  }

  getAnnotation(id: string): Annotation | undefined {
    return this.annotations.get(id)
  }

  getAllAnnotations(): Annotation[] {
    return Array.from(this.annotations.values())
  }

  getAnnotationsForSpine(spineIndex: number): Annotation[] {
    return Array.from(this.annotations.values()).filter(
      (a) => a.location.spineIndex === spineIndex
    )
  }

  getBookmarks(): Annotation[] {
    return Array.from(this.annotations.values()).filter((a) => a.type === 'bookmark')
  }

  getHighlights(): Annotation[] {
    return Array.from(this.annotations.values()).filter(
      (a) => a.type === 'highlight' || a.type === 'note'
    )
  }

  // Render highlights in a document
  renderHighlights(doc: Document, spineIndex: number): void {
    const annotations = this.getAnnotationsForSpine(spineIndex).filter(
      (a) => a.type === 'highlight' || a.type === 'note'
    )

    for (const annotation of annotations) {
      this.renderHighlight(doc, annotation)
    }
  }

  private renderHighlight(doc: Document, annotation: Annotation): void {
    const cfi = annotation.location.cfi
    const range = this.cfiResolver.resolveRange(cfi, doc)

    if (!range) {
      console.warn('Could not resolve CFI for highlight:', cfi)
      return
    }

    const elements = this.highlightRange(doc, range, annotation)
    this.highlightElements.set(annotation.id, elements)
  }

  private highlightRange(
    doc: Document,
    range: Range,
    annotation: Annotation
  ): HTMLElement[] {
    const elements: HTMLElement[] = []
    const color = HIGHLIGHT_COLORS[annotation.color || 'yellow']

    // Get text nodes within the range
    const textNodes = this.getTextNodesInRange(range)

    for (const { node, start, end } of textNodes) {
      const wrapper = doc.createElement('span')
      wrapper.className = 'epub-highlight'
      wrapper.dataset.annotationId = annotation.id
      wrapper.dataset.annotationType = annotation.type
      wrapper.style.cssText = `
        background-color: ${color};
        cursor: pointer;
        border-radius: 2px;
      `

      if (annotation.note) {
        wrapper.title = annotation.note
        wrapper.style.borderBottom = '2px solid currentColor'
      }

      // Handle click on highlight
      wrapper.addEventListener('click', (e) => {
        e.stopPropagation()
        const event = new CustomEvent('annotationclick', {
          bubbles: true,
          detail: { annotation },
        })
        wrapper.dispatchEvent(event)
      })

      // Split text node if needed
      const textContent = node.textContent || ''
      if (start > 0 || end < textContent.length) {
        // Create new text nodes for before and after
        const before = textContent.slice(0, start)
        const middle = textContent.slice(start, end)
        const after = textContent.slice(end)

        const parent = node.parentNode
        if (parent) {
          if (before) {
            parent.insertBefore(doc.createTextNode(before), node)
          }

          wrapper.textContent = middle
          parent.insertBefore(wrapper, node)

          if (after) {
            parent.insertBefore(doc.createTextNode(after), node)
          }

          parent.removeChild(node)
        }
      } else {
        // Wrap entire text node
        const parent = node.parentNode
        if (parent) {
          wrapper.textContent = textContent
          parent.replaceChild(wrapper, node)
        }
      }

      elements.push(wrapper)
    }

    return elements
  }

  private getTextNodesInRange(
    range: Range
  ): Array<{ node: Text; start: number; end: number }> {
    const nodes: Array<{ node: Text; start: number; end: number }> = []

    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const nodeRange = document.createRange()
          nodeRange.selectNodeContents(node)

          const isBeforeStart = nodeRange.compareBoundaryPoints(Range.END_TO_START, range) < 0
          const isAfterEnd = nodeRange.compareBoundaryPoints(Range.START_TO_END, range) > 0

          if (isBeforeStart || isAfterEnd) {
            return NodeFilter.FILTER_REJECT
          }

          return NodeFilter.FILTER_ACCEPT
        },
      }
    )

    let node = walker.nextNode()
    while (node) {
      const textNode = node as Text
      const textLength = textNode.textContent?.length || 0

      let start = 0
      let end = textLength

      if (node === range.startContainer) {
        start = range.startOffset
      }
      if (node === range.endContainer) {
        end = range.endOffset
      }

      if (start < end) {
        nodes.push({ node: textNode, start, end })
      }

      node = walker.nextNode()
    }

    return nodes
  }

  clearHighlights(doc: Document): void {
    // Remove all highlight elements and restore text
    const highlights = doc.querySelectorAll('.epub-highlight')

    for (const highlight of highlights) {
      const parent = highlight.parentNode
      if (parent) {
        const textNode = doc.createTextNode(highlight.textContent || '')
        parent.replaceChild(textNode, highlight)

        // Normalize to merge adjacent text nodes
        parent.normalize()
      }
    }

    this.highlightElements.clear()
  }

  private clearHighlightElements(annotationId: string): void {
    const elements = this.highlightElements.get(annotationId)
    if (!elements) return

    for (const el of elements) {
      const parent = el.parentNode
      if (parent) {
        const textNode = document.createTextNode(el.textContent || '')
        parent.replaceChild(textNode, el)
        parent.normalize()
      }
    }

    this.highlightElements.delete(annotationId)
  }

  exportAnnotations(): string {
    const annotations = this.getAllAnnotations()
    return JSON.stringify(annotations, null, 2)
  }

  importAnnotations(json: string): void {
    try {
      const annotations = JSON.parse(json) as Annotation[]

      for (const annotation of annotations) {
        // Validate annotation
        if (
          annotation.id &&
          annotation.bookId === this.bookId &&
          annotation.location?.cfi
        ) {
          this.annotations.set(annotation.id, annotation)
        }
      }

      this.notifyChange()
    } catch (error) {
      console.error('Failed to import annotations:', error)
      throw new Error('Invalid annotation data')
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  }

  private notifyChange(): void {
    this.onAnnotationChange?.(this.getAllAnnotations())
  }
}

// Utility function to create a highlight from current selection
export function createHighlightFromSelection(
  doc: Document,
  spineIndex: number,
  spineItems: SpineItem[],
  color: HighlightColor = 'yellow'
): { cfi: string; excerpt: string } | null {
  const selection = doc.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null
  }

  const generator = new CfiGenerator(spineItems)
  const cfi = generator.generateFromSelection(selection, spineIndex)
  const excerpt = selection.toString().trim()

  if (!cfi || !excerpt) {
    return null
  }

  return { cfi, excerpt }
}
