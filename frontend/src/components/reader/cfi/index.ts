// EPUB CFI (Canonical Fragment Identifier) Implementation
// Based on EPUB CFI 1.1 specification (IDPF)

import type { Cfi, CfiPath, CfiStep, CfiRange, SpineItem } from '../types'

// ============================================================================
// CFI Parser
// ============================================================================

export class CfiParser {
  private input: string = ''
  private pos: number = 0

  parse(cfiString: string): Cfi {
    this.input = cfiString
    this.pos = 0

    if (!this.input.startsWith('epubcfi(') || !this.input.endsWith(')')) {
      throw new Error('Invalid CFI format: must start with epubcfi( and end with )')
    }

    // Remove epubcfi( wrapper
    this.input = this.input.slice(8, -1)
    this.pos = 0

    // Find the ! separator between base and path
    const exclamationIndex = this.input.indexOf('!')
    if (exclamationIndex === -1) {
      throw new Error('Invalid CFI: missing ! separator')
    }

    const base = this.input.slice(0, exclamationIndex + 1)
    this.input = this.input.slice(exclamationIndex + 1)
    this.pos = 0

    // Check for range
    const commaIndex = this.findUnescapedComma()
    let path: CfiPath
    let range: CfiRange | undefined

    if (commaIndex !== -1) {
      // This is a range CFI
      const startStr = this.input.slice(0, commaIndex)
      const endStr = this.input.slice(commaIndex + 1)

      path = this.parsePath(startStr)
      const endPath = this.parsePath(endStr)
      range = { start: path, end: endPath }
    } else {
      path = this.parsePath(this.input)
    }

    return {
      base,
      path,
      range,
      raw: cfiString,
    }
  }

  private findUnescapedComma(): number {
    let depth = 0
    for (let i = 0; i < this.input.length; i++) {
      const char = this.input[i]
      if (char === '[') depth++
      else if (char === ']') depth--
      else if (char === ',' && depth === 0) return i
    }
    return -1
  }

  private parsePath(pathStr: string): CfiPath {
    const steps: CfiStep[] = []
    let remaining = pathStr

    while (remaining.length > 0) {
      const step = this.parseStep(remaining)
      steps.push(step.step)
      remaining = step.remaining
    }

    return { steps }
  }

  private parseStep(str: string): { step: CfiStep; remaining: string } {
    if (!str.startsWith('/')) {
      throw new Error(`Invalid CFI step: expected / but got ${str[0]}`)
    }

    let pos = 1
    let nodeIndex = 0

    // Parse node index
    while (pos < str.length && /\d/.test(str[pos])) {
      nodeIndex = nodeIndex * 10 + parseInt(str[pos], 10)
      pos++
    }

    const step: CfiStep = { nodeIndex }

    // Parse optional components
    while (pos < str.length) {
      const char = str[pos]

      if (char === '[') {
        // ID assertion or other assertion
        const endBracket = str.indexOf(']', pos)
        if (endBracket === -1) {
          throw new Error('Unclosed bracket in CFI')
        }

        const content = str.slice(pos + 1, endBracket)

        if (content.startsWith(';s=')) {
          // Side bias
          step.sideBias = content.slice(3) as 'before' | 'after'
        } else if (!content.includes('=')) {
          // ID assertion
          step.id = this.unescapeValue(content)
        }

        pos = endBracket + 1
      } else if (char === ':') {
        // Text offset
        pos++
        let offset = 0
        while (pos < str.length && /\d/.test(str[pos])) {
          offset = offset * 10 + parseInt(str[pos], 10)
          pos++
        }
        step.textOffset = offset
      } else if (char === '~') {
        // Temporal offset
        pos++
        let offsetStr = ''
        while (pos < str.length && /[\d.]/.test(str[pos])) {
          offsetStr += str[pos]
          pos++
        }
        step.temporalOffset = parseFloat(offsetStr)
      } else if (char === '@') {
        // Spatial offset
        pos++
        let xStr = ''
        while (pos < str.length && /[\d.]/.test(str[pos])) {
          xStr += str[pos]
          pos++
        }
        if (str[pos] === ':') {
          pos++
          let yStr = ''
          while (pos < str.length && /[\d.]/.test(str[pos])) {
            yStr += str[pos]
            pos++
          }
          step.spatialOffset = { x: parseFloat(xStr), y: parseFloat(yStr) }
        }
      } else if (char === '/') {
        // Next step
        break
      } else {
        pos++
      }
    }

    return { step, remaining: str.slice(pos) }
  }

  private unescapeValue(value: string): string {
    return value.replace(/\^(.)/g, '$1')
  }
}

// ============================================================================
// CFI Generator
// ============================================================================

export class CfiGenerator {
  private spineItems: SpineItem[]

  constructor(spineItems: SpineItem[]) {
    this.spineItems = spineItems
  }

  generateFromElement(
    element: Element,
    spineIndex: number,
    textOffset?: number
  ): string {
    const spineItem = this.spineItems[spineIndex]
    if (!spineItem) {
      throw new Error(`Invalid spine index: ${spineIndex}`)
    }

    // Build base CFI (package document reference)
    // /6 is typically the spine in OPF
    // /{n*2} references spine items (1-indexed, multiplied by 2 for element nodes)
    const spinePosition = (spineIndex + 1) * 2
    const base = `/6/${spinePosition}!`

    // Build path from document root to element
    const path = this.buildPathToElement(element, textOffset)

    return `epubcfi(${base}${path})`
  }

  generateFromRange(
    range: Range,
    spineIndex: number
  ): string {
    const spineItem = this.spineItems[spineIndex]
    if (!spineItem) {
      throw new Error(`Invalid spine index: ${spineIndex}`)
    }

    const spinePosition = (spineIndex + 1) * 2
    const base = `/6/${spinePosition}!`

    const startPath = this.buildPathToNode(range.startContainer, range.startOffset)
    const endPath = this.buildPathToNode(range.endContainer, range.endOffset)

    // Find common ancestor path
    const commonPath = this.findCommonPath(startPath, endPath)

    if (commonPath === startPath && commonPath === endPath) {
      // Point CFI
      return `epubcfi(${base}${startPath})`
    }

    // Range CFI - remove common prefix from end path
    const startSuffix = startPath.slice(commonPath.length)
    const endSuffix = endPath.slice(commonPath.length)

    return `epubcfi(${base}${commonPath}${startSuffix},${endSuffix})`
  }

  generateFromSelection(
    selection: Selection,
    spineIndex: number
  ): string | null {
    if (selection.rangeCount === 0) return null

    const range = selection.getRangeAt(0)
    return this.generateFromRange(range, spineIndex)
  }

  private buildPathToElement(element: Element, textOffset?: number): string {
    const steps: string[] = []
    let current: Node | null = element

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const el = current as Element
      const parent = el.parentNode

      if (!parent) break

      // Calculate position among siblings
      let position = 0
      let sibling: Node | null = parent.firstChild

      while (sibling && sibling !== current) {
        if (sibling.nodeType === Node.ELEMENT_NODE) {
          position++
        }
        sibling = sibling.nextSibling
      }

      // CFI uses 1-indexed, even numbers for elements
      const index = (position + 1) * 2
      const id = el.id ? `[${this.escapeValue(el.id)}]` : ''

      steps.unshift(`/${index}${id}`)

      current = parent

      // Stop at document body
      if (el.tagName.toLowerCase() === 'body') break
    }

    // Add text offset if provided
    let path = steps.join('')
    if (textOffset !== undefined) {
      path += `:${textOffset}`
    }

    return path
  }

  private buildPathToNode(node: Node, offset: number): string {
    if (node.nodeType === Node.TEXT_NODE) {
      // For text nodes, get path to parent element + text position
      const parent = node.parentElement
      if (!parent) return ''

      const textPosition = this.getTextNodePosition(parent, node)
      const elementPath = this.buildPathToElement(parent)

      // Text offset includes position within all text content
      const textOffset = this.calculateTextOffset(parent, node, offset)

      return `${elementPath}:${textOffset}`
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      return this.buildPathToElement(node as Element, offset)
    }

    return ''
  }

  private getTextNodePosition(parent: Element, textNode: Node): number {
    let position = 0
    let current: Node | null = parent.firstChild

    while (current && current !== textNode) {
      if (current.nodeType === Node.TEXT_NODE) {
        position++
      }
      current = current.nextSibling
    }

    return position
  }

  private calculateTextOffset(
    parent: Element,
    targetTextNode: Node,
    offsetInNode: number
  ): number {
    let totalOffset = 0
    let current: Node | null = parent.firstChild

    while (current) {
      if (current === targetTextNode) {
        return totalOffset + offsetInNode
      }

      if (current.nodeType === Node.TEXT_NODE) {
        totalOffset += (current.textContent?.length || 0)
      } else if (current.nodeType === Node.ELEMENT_NODE) {
        totalOffset += (current.textContent?.length || 0)
      }

      current = current.nextSibling
    }

    return totalOffset
  }

  private findCommonPath(path1: string, path2: string): string {
    const steps1 = path1.match(/\/\d+(\[[^\]]*\])?/g) || []
    const steps2 = path2.match(/\/\d+(\[[^\]]*\])?/g) || []

    let common = ''
    for (let i = 0; i < Math.min(steps1.length, steps2.length); i++) {
      if (steps1[i] === steps2[i]) {
        common += steps1[i]
      } else {
        break
      }
    }

    return common
  }

  private escapeValue(value: string): string {
    return value.replace(/[\[\](),^]/g, '^$&')
  }
}

// ============================================================================
// CFI Resolver
// ============================================================================

export class CfiResolver {
  private spineItems: SpineItem[]

  constructor(spineItems: SpineItem[]) {
    this.spineItems = spineItems
  }

  resolve(
    cfiString: string,
    doc: Document
  ): { node: Node; offset: number } | null {
    try {
      const parser = new CfiParser()
      const cfi = parser.parse(cfiString)

      return this.resolvePath(cfi.path, doc)
    } catch (error) {
      console.warn('Failed to resolve CFI:', error)
      return null
    }
  }

  resolveRange(
    cfiString: string,
    doc: Document
  ): Range | null {
    try {
      const parser = new CfiParser()
      const cfi = parser.parse(cfiString)

      if (!cfi.range) {
        // Point CFI - create collapsed range
        const result = this.resolvePath(cfi.path, doc)
        if (!result) return null

        const range = doc.createRange()
        range.setStart(result.node, result.offset)
        range.collapse(true)
        return range
      }

      // Range CFI
      const start = this.resolvePath(cfi.range.start, doc)
      const end = this.resolvePath(cfi.range.end, doc)

      if (!start || !end) return null

      const range = doc.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)

      return range
    } catch (error) {
      console.warn('Failed to resolve CFI range:', error)
      return null
    }
  }

  getSpineIndex(cfiString: string): number {
    try {
      const parser = new CfiParser()
      const cfi = parser.parse(cfiString)

      // Parse base to get spine index
      // Format: /6/{spinePosition}!
      const match = cfi.base.match(/\/6\/(\d+)!/)
      if (match) {
        const spinePosition = parseInt(match[1], 10)
        return (spinePosition / 2) - 1
      }
    } catch (error) {
      console.warn('Failed to extract spine index from CFI:', error)
    }

    return -1
  }

  private resolvePath(
    path: CfiPath,
    doc: Document
  ): { node: Node; offset: number } | null {
    let current: Node = doc.documentElement

    for (let i = 0; i < path.steps.length; i++) {
      const step = path.steps[i]

      // Navigate to element
      if (step.nodeIndex > 0) {
        const targetIndex = step.nodeIndex / 2 - 1 // Convert from CFI index to 0-based

        const children = Array.from(current.childNodes).filter(
          (n) => n.nodeType === Node.ELEMENT_NODE
        )

        if (targetIndex >= 0 && targetIndex < children.length) {
          current = children[targetIndex]
        } else {
          // Try ID fallback
          if (step.id) {
            const byId = doc.getElementById(step.id)
            if (byId) {
              current = byId
            } else {
              return null
            }
          } else {
            return null
          }
        }
      }

      // Handle text offset on last step
      if (i === path.steps.length - 1 && step.textOffset !== undefined) {
        const result = this.resolveTextOffset(current as Element, step.textOffset)
        if (result) {
          return result
        }
      }
    }

    return { node: current, offset: 0 }
  }

  private resolveTextOffset(
    element: Element,
    targetOffset: number
  ): { node: Node; offset: number } | null {
    let currentOffset = 0
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    )

    let node = walker.nextNode()
    while (node) {
      const length = node.textContent?.length || 0

      if (currentOffset + length >= targetOffset) {
        return {
          node,
          offset: targetOffset - currentOffset,
        }
      }

      currentOffset += length
      node = walker.nextNode()
    }

    // If we couldn't find the exact offset, return the last text node
    const textNodes = this.getTextNodes(element)
    if (textNodes.length > 0) {
      const lastNode = textNodes[textNodes.length - 1]
      return {
        node: lastNode,
        offset: lastNode.textContent?.length || 0,
      }
    }

    return null
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
}

// ============================================================================
// CFI Utilities
// ============================================================================

export function compareCfi(cfi1: string, cfi2: string): number {
  try {
    const parser = new CfiParser()
    const parsed1 = parser.parse(cfi1)
    const parsed2 = parser.parse(cfi2)

    // Compare base (spine position)
    const base1 = parseInt(parsed1.base.match(/\/6\/(\d+)!/)?.[1] || '0', 10)
    const base2 = parseInt(parsed2.base.match(/\/6\/(\d+)!/)?.[1] || '0', 10)

    if (base1 !== base2) {
      return base1 - base2
    }

    // Compare paths step by step
    const steps1 = parsed1.path.steps
    const steps2 = parsed2.path.steps

    for (let i = 0; i < Math.max(steps1.length, steps2.length); i++) {
      const s1 = steps1[i]
      const s2 = steps2[i]

      if (!s1) return -1
      if (!s2) return 1

      if (s1.nodeIndex !== s2.nodeIndex) {
        return s1.nodeIndex - s2.nodeIndex
      }

      if (s1.textOffset !== undefined && s2.textOffset !== undefined) {
        return s1.textOffset - s2.textOffset
      }
    }

    return 0
  } catch {
    return 0
  }
}

export function isCfiInRange(cfi: string, startCfi: string, endCfi: string): boolean {
  return compareCfi(cfi, startCfi) >= 0 && compareCfi(cfi, endCfi) <= 0
}

export function extractExcerpt(
  doc: Document,
  cfiString: string,
  contextLength = 50
): string {
  const resolver = new CfiResolver([])
  const result = resolver.resolve(cfiString, doc)

  if (!result) return ''

  const textContent = result.node.textContent || ''
  const start = Math.max(0, result.offset - contextLength)
  const end = Math.min(textContent.length, result.offset + contextLength)

  return textContent.slice(start, end).trim()
}
