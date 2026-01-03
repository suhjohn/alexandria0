// Search Module
// Full-text search across EPUB spine items

import type { SpineItem, SearchResult, SearchOptions, SearchIndex } from '../types'
import type { EpubContainer } from '../core/container'
import { CfiGenerator } from '../cfi'

const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  maxResults: 100,
}

export interface SearchEngineOptions {
  bookId: string
  container: EpubContainer
  spineItems: SpineItem[]
}

interface IndexedDocument {
  spineIndex: number
  spineHref: string
  text: string
  positions: Map<string, number[]> // term -> positions
}

export class SearchEngine {
  private bookId: string
  private container: EpubContainer
  private spineItems: SpineItem[]
  private cfiGenerator: CfiGenerator
  private indexedDocuments: IndexedDocument[] = []
  private isIndexed: boolean = false
  private isIndexing: boolean = false

  constructor(options: SearchEngineOptions) {
    this.bookId = options.bookId
    this.container = options.container
    this.spineItems = options.spineItems
    this.cfiGenerator = new CfiGenerator(options.spineItems)
  }

  async buildIndex(onProgress?: (progress: number) => void): Promise<void> {
    if (this.isIndexing) return
    this.isIndexing = true

    try {
      this.indexedDocuments = []

      for (let i = 0; i < this.spineItems.length; i++) {
        const spineItem = this.spineItems[i]

        try {
          const content = await this.container.readText(spineItem.href)
          const text = this.extractText(content)
          const positions = this.buildPositionIndex(text)

          this.indexedDocuments.push({
            spineIndex: i,
            spineHref: spineItem.href,
            text,
            positions,
          })
        } catch (error) {
          console.warn(`Failed to index spine item ${i}:`, error)
        }

        onProgress?.((i + 1) / this.spineItems.length * 100)
      }

      this.isIndexed = true
    } finally {
      this.isIndexing = false
    }
  }

  private extractText(html: string): string {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'application/xhtml+xml')

    // Remove script and style elements
    const scripts = doc.querySelectorAll('script, style, noscript')
    scripts.forEach((el) => el.remove())

    // Get text content
    const body = doc.body || doc.documentElement
    const text = body.textContent || ''

    // Normalize whitespace
    return text.replace(/\s+/g, ' ').trim()
  }

  private buildPositionIndex(text: string): Map<string, number[]> {
    const positions = new Map<string, number[]>()
    const normalizedText = text.toLowerCase()

    // Simple tokenization - split on word boundaries
    const wordRegex = /\b[\w\u00C0-\u024F\u1E00-\u1EFF]+\b/g
    let match

    while ((match = wordRegex.exec(normalizedText)) !== null) {
      const word = match[0]
      if (word.length < 2) continue

      const existing = positions.get(word) || []
      existing.push(match.index)
      positions.set(word, existing)
    }

    return positions
  }

  async search(
    query: string,
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options }

    if (!this.isIndexed) {
      await this.buildIndex()
    }

    if (!query.trim()) {
      return []
    }

    const results: SearchResult[] = []
    const normalizedQuery = opts.caseSensitive ? query : query.toLowerCase()

    for (const doc of this.indexedDocuments) {
      const text = opts.caseSensitive ? doc.text : doc.text.toLowerCase()
      const docResults = this.searchInDocument(doc, text, normalizedQuery, opts)
      results.push(...docResults)

      if (results.length >= opts.maxResults) {
        break
      }
    }

    return results.slice(0, opts.maxResults)
  }

  private searchInDocument(
    doc: IndexedDocument,
    text: string,
    query: string,
    options: SearchOptions
  ): SearchResult[] {
    const results: SearchResult[] = []

    // Build search regex
    let pattern: string
    if (options.wholeWord) {
      pattern = `\\b${this.escapeRegex(query)}\\b`
    } else {
      pattern = this.escapeRegex(query)
    }

    const flags = options.caseSensitive ? 'g' : 'gi'
    const regex = new RegExp(pattern, flags)

    let match
    while ((match = regex.exec(text)) !== null) {
      const matchStart = match.index
      const matchEnd = matchStart + match[0].length

      // Generate excerpt with context
      const contextStart = Math.max(0, matchStart - 40)
      const contextEnd = Math.min(text.length, matchEnd + 40)
      let excerpt = text.slice(contextStart, contextEnd)

      // Add ellipsis if truncated
      if (contextStart > 0) excerpt = '...' + excerpt
      if (contextEnd < text.length) excerpt = excerpt + '...'

      // Generate CFI for this position
      const cfi = this.generateCfiForPosition(doc.spineIndex, matchStart)

      results.push({
        spineIndex: doc.spineIndex,
        spineHref: doc.spineHref,
        cfi,
        excerpt,
        matchStart,
        matchEnd,
      })
    }

    return results
  }

  private generateCfiForPosition(spineIndex: number, position: number): string {
    // Generate a basic CFI pointing to the spine item with text offset
    // This is a simplified CFI - in production, you'd want to map to actual DOM positions
    const spinePosition = (spineIndex + 1) * 2
    return `epubcfi(/6/${spinePosition}!/4/2:${position})`
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  // Search with highlighting support
  async searchWithHighlighting(
    query: string,
    doc: Document,
    spineIndex: number,
    options: Partial<SearchOptions> = {}
  ): Promise<Range[]> {
    const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options }
    const ranges: Range[] = []

    if (!query.trim()) {
      return ranges
    }

    const normalizedQuery = opts.caseSensitive ? query : query.toLowerCase()

    // Get all text nodes
    const textNodes = this.getTextNodes(doc.body)

    // Build search regex
    let pattern: string
    if (opts.wholeWord) {
      pattern = `\\b${this.escapeRegex(query)}\\b`
    } else {
      pattern = this.escapeRegex(query)
    }

    const flags = opts.caseSensitive ? 'g' : 'gi'
    const regex = new RegExp(pattern, flags)

    // Search through text nodes
    for (const node of textNodes) {
      const text = node.textContent || ''
      const searchText = opts.caseSensitive ? text : text.toLowerCase()

      let match
      while ((match = regex.exec(searchText)) !== null) {
        try {
          const range = doc.createRange()
          range.setStart(node, match.index)
          range.setEnd(node, match.index + match[0].length)
          ranges.push(range)
        } catch (e) {
          // Range might be invalid if positions are out of bounds
          console.warn('Failed to create range for match:', e)
        }
      }
    }

    return ranges
  }

  private getTextNodes(element: Element): Text[] {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    )

    let node = walker.nextNode()
    while (node) {
      nodes.push(node as Text)
      node = walker.nextNode()
    }

    return nodes
  }

  // Highlight search results in document
  highlightSearchResults(
    doc: Document,
    ranges: Range[],
    className = 'epub-search-highlight'
  ): HTMLElement[] {
    const highlights: HTMLElement[] = []

    for (const range of ranges) {
      try {
        const highlight = doc.createElement('mark')
        highlight.className = className
        highlight.style.cssText = `
          background-color: rgba(255, 235, 59, 0.6);
          border-radius: 2px;
        `

        range.surroundContents(highlight)
        highlights.push(highlight)
      } catch (e) {
        // Range might span multiple nodes
        console.warn('Failed to highlight range:', e)
      }
    }

    return highlights
  }

  // Clear search highlights
  clearSearchHighlights(doc: Document, className = 'epub-search-highlight'): void {
    const highlights = doc.querySelectorAll(`.${className}`)

    for (const highlight of highlights) {
      const parent = highlight.parentNode
      if (parent) {
        const textNode = doc.createTextNode(highlight.textContent || '')
        parent.replaceChild(textNode, highlight)
        parent.normalize()
      }
    }
  }

  isReady(): boolean {
    return this.isIndexed
  }

  clear(): void {
    this.indexedDocuments = []
    this.isIndexed = false
  }
}

// Quick search utility for single document
export function quickSearch(
  doc: Document,
  query: string,
  options: Partial<SearchOptions> = {}
): Range[] {
  const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options }
  const ranges: Range[] = []

  if (!query.trim()) {
    return ranges
  }

  const normalizedQuery = opts.caseSensitive ? query : query.toLowerCase()

  // Build search regex
  let pattern: string
  if (opts.wholeWord) {
    pattern = `\\b${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
  } else {
    pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  const flags = opts.caseSensitive ? 'g' : 'gi'
  const regex = new RegExp(pattern, flags)

  // Use window.find for better performance if available
  const walker = document.createTreeWalker(
    doc.body,
    NodeFilter.SHOW_TEXT,
    null
  )

  let node = walker.nextNode()
  while (node) {
    const text = node.textContent || ''
    const searchText = opts.caseSensitive ? text : text.toLowerCase()

    let match
    while ((match = regex.exec(searchText)) !== null) {
      try {
        const range = doc.createRange()
        range.setStart(node, match.index)
        range.setEnd(node, match.index + match[0].length)
        ranges.push(range)

        if (ranges.length >= opts.maxResults) {
          return ranges
        }
      } catch (e) {
        // Ignore invalid ranges
      }
    }

    node = walker.nextNode()
  }

  return ranges
}
