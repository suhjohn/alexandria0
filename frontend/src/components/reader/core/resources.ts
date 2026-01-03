// Resource Resolver Module
// Handles resource loading, blob URL creation, and content sanitization

import type { Resource, ResourceResolver } from '../types'
import type { EpubContainer } from './container'

const ALLOWED_EXTERNAL_PATTERNS: RegExp[] = [
  // Add patterns for allowed external resources if needed
]

const EVENT_HANDLERS = [
  'onabort', 'onblur', 'oncancel', 'oncanplay', 'oncanplaythrough', 'onchange',
  'onclick', 'onclose', 'oncontextmenu', 'oncopy', 'oncuechange', 'oncut',
  'ondblclick', 'ondrag', 'ondragend', 'ondragenter', 'ondragleave', 'ondragover',
  'ondragstart', 'ondrop', 'ondurationchange', 'onemptied', 'onended', 'onerror',
  'onfocus', 'onformdata', 'oninput', 'oninvalid', 'onkeydown', 'onkeypress',
  'onkeyup', 'onload', 'onloadeddata', 'onloadedmetadata', 'onloadstart',
  'onmousedown', 'onmouseenter', 'onmouseleave', 'onmousemove', 'onmouseout',
  'onmouseover', 'onmouseup', 'onpaste', 'onpause', 'onplay', 'onplaying',
  'onpointercancel', 'onpointerdown', 'onpointerenter', 'onpointerleave',
  'onpointermove', 'onpointerout', 'onpointerover', 'onpointerup', 'onprogress',
  'onratechange', 'onreset', 'onresize', 'onscroll', 'onsecuritypolicyviolation',
  'onseeked', 'onseeking', 'onselect', 'onslotchange', 'onstalled', 'onsubmit',
  'onsuspend', 'ontimeupdate', 'ontoggle', 'onvolumechange', 'onwaiting',
  'onwheel', 'ontouchstart', 'ontouchmove', 'ontouchend', 'ontouchcancel',
]

export class EpubResourceResolver implements ResourceResolver {
  private container: EpubContainer
  private basePath: string
  private blobUrls: Map<string, string> = new Map()
  private cache: Map<string, Resource> = new Map()
  private allowExternalResources: boolean

  constructor(
    container: EpubContainer,
    basePath: string,
    allowExternalResources = false
  ) {
    this.container = container
    this.basePath = basePath
    this.allowExternalResources = allowExternalResources
  }

  async resolve(path: string): Promise<Resource | null> {
    // Check cache first
    const cached = this.cache.get(path)
    if (cached) return cached

    // Normalize path
    const normalizedPath = this.normalizePath(path)

    try {
      const data = await this.container.readEntry(normalizedPath)
      const mediaType = this.getMediaType(normalizedPath)

      const resource: Resource = {
        path: normalizedPath,
        data,
        mediaType,
      }

      this.cache.set(path, resource)
      return resource
    } catch (error) {
      console.warn(`Failed to resolve resource: ${path}`, error)
      return null
    }
  }

  async createBlobUrl(path: string): Promise<string> {
    // Check if we already have a blob URL
    const existing = this.blobUrls.get(path)
    if (existing) return existing

    const resource = await this.resolve(path)
    if (!resource) {
      throw new Error(`Resource not found: ${path}`)
    }

    let blob: Blob

    // Sanitize HTML/XHTML content
    if (this.isHtmlContent(resource.mediaType)) {
      const text = new TextDecoder().decode(resource.data)
      const sanitized = this.sanitizeHtml(text, path)
      blob = new Blob([sanitized], { type: resource.mediaType })
    } else {
      blob = new Blob([resource.data], { type: resource.mediaType })
    }

    const url = URL.createObjectURL(blob)
    this.blobUrls.set(path, url)
    resource.blobUrl = url

    return url
  }

  revokeBlobUrl(url: string): void {
    URL.revokeObjectURL(url)

    // Remove from map
    for (const [path, blobUrl] of this.blobUrls) {
      if (blobUrl === url) {
        this.blobUrls.delete(path)
        break
      }
    }
  }

  revokeAll(): void {
    for (const url of this.blobUrls.values()) {
      URL.revokeObjectURL(url)
    }
    this.blobUrls.clear()
    this.cache.clear()
  }

  async createContentDocument(
    spineHref: string,
    rewriteUrls = true
  ): Promise<{ html: string; blobUrl: string }> {
    const resource = await this.resolve(spineHref)
    if (!resource) {
      throw new Error(`Spine item not found: ${spineHref}`)
    }

    let html = new TextDecoder().decode(resource.data)

    // Sanitize the HTML
    html = this.sanitizeHtml(html, spineHref)

    if (rewriteUrls) {
      // Rewrite resource URLs to blob URLs
      html = await this.rewriteResourceUrls(html, spineHref)
    }

    const blob = new Blob([html], { type: resource.mediaType })
    const blobUrl = URL.createObjectURL(blob)
    this.blobUrls.set(`content:${spineHref}`, blobUrl)

    return { html, blobUrl }
  }

  private sanitizeHtml(html: string, basePath: string): string {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'application/xhtml+xml')

    // Check for parsing errors
    const parserError = doc.querySelector('parsererror')
    if (parserError) {
      // Try as HTML if XHTML fails
      const htmlDoc = parser.parseFromString(html, 'text/html')
      return this.sanitizeDocument(htmlDoc, basePath)
    }

    return this.sanitizeDocument(doc, basePath)
  }

  private sanitizeDocument(doc: Document, basePath: string): string {
    // Remove script elements
    const scripts = doc.querySelectorAll('script')
    scripts.forEach((script) => script.remove())

    // Remove noscript elements (optional, but cleaner)
    const noscripts = doc.querySelectorAll('noscript')
    noscripts.forEach((el) => el.remove())

    // Remove event handler attributes
    const allElements = doc.querySelectorAll('*')
    allElements.forEach((el) => {
      EVENT_HANDLERS.forEach((handler) => {
        if (el.hasAttribute(handler)) {
          el.removeAttribute(handler)
        }
      })

      // Remove javascript: URLs
      const href = el.getAttribute('href')
      if (href?.toLowerCase().startsWith('javascript:')) {
        el.setAttribute('href', '#')
      }

      const src = el.getAttribute('src')
      if (src?.toLowerCase().startsWith('javascript:')) {
        el.removeAttribute('src')
      }

      // Block external resources unless allowed
      if (!this.allowExternalResources) {
        this.blockExternalResource(el, 'src', basePath)
        this.blockExternalResource(el, 'href', basePath)
      }
    })

    // Remove base elements (could affect URL resolution)
    const bases = doc.querySelectorAll('base')
    bases.forEach((base) => base.remove())

    // Add CSP meta tag
    const head = doc.querySelector('head')
    if (head) {
      const existingCsp = head.querySelector('meta[http-equiv="Content-Security-Policy"]')
      if (!existingCsp) {
        const cspMeta = doc.createElement('meta')
        cspMeta.setAttribute('http-equiv', 'Content-Security-Policy')
        cspMeta.setAttribute(
          'content',
          "default-src 'self' blob: data:; script-src 'none'; style-src 'self' blob: data: 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; object-src 'none'; frame-ancestors 'none';"
        )
        head.insertBefore(cspMeta, head.firstChild)
      }
    }

    // Serialize back to string
    const serializer = new XMLSerializer()
    return serializer.serializeToString(doc)
  }

  private blockExternalResource(el: Element, attr: string, basePath: string): void {
    const value = el.getAttribute(attr)
    if (!value) return

    // Allow relative URLs, data URLs, blob URLs, and fragment-only URLs
    if (
      value.startsWith('#') ||
      value.startsWith('data:') ||
      value.startsWith('blob:') ||
      !value.includes('://')
    ) {
      return
    }

    // Check if it matches allowed patterns
    const isAllowed = ALLOWED_EXTERNAL_PATTERNS.some((pattern) => pattern.test(value))
    if (isAllowed) return

    // Block the resource
    if (el.tagName.toLowerCase() === 'img') {
      // Replace with transparent pixel
      el.setAttribute(attr, 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
    } else if (el.tagName.toLowerCase() === 'link') {
      // Remove stylesheet links to external resources
      if (el.getAttribute('rel')?.includes('stylesheet')) {
        el.remove()
      }
    } else {
      el.removeAttribute(attr)
    }
  }

  private async rewriteResourceUrls(html: string, spineHref: string): Promise<string> {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'application/xhtml+xml')
    const basePath = spineHref.substring(0, spineHref.lastIndexOf('/') + 1)

    // Collect all resources to rewrite
    const urlAttrs = [
      { selector: 'img', attr: 'src' },
      { selector: 'image', attr: 'xlink:href' },
      { selector: 'image', attr: 'href' },
      { selector: 'link[rel="stylesheet"]', attr: 'href' },
      { selector: 'audio source', attr: 'src' },
      { selector: 'video source', attr: 'src' },
      { selector: 'audio', attr: 'src' },
      { selector: 'video', attr: 'src' },
    ]

    for (const { selector, attr } of urlAttrs) {
      const elements = doc.querySelectorAll(selector)
      for (const el of elements) {
        const value = el.getAttribute(attr)
        if (!value || value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('http://') || value.startsWith('https://')) {
          continue
        }

        try {
          const resolvedPath = this.resolveRelativePath(value, basePath)
          const blobUrl = await this.createBlobUrl(resolvedPath)
          el.setAttribute(attr, blobUrl)
        } catch (error) {
          console.warn(`Failed to rewrite URL: ${value}`, error)
        }
      }
    }

    // Rewrite CSS url() references
    const styleElements = doc.querySelectorAll('style')
    for (const style of styleElements) {
      if (style.textContent) {
        style.textContent = await this.rewriteCssUrls(style.textContent, basePath)
      }
    }

    // Rewrite inline styles
    const elementsWithStyle = doc.querySelectorAll('[style]')
    for (const el of elementsWithStyle) {
      const style = el.getAttribute('style')
      if (style) {
        el.setAttribute('style', await this.rewriteCssUrls(style, basePath))
      }
    }

    const serializer = new XMLSerializer()
    return serializer.serializeToString(doc)
  }

  private async rewriteCssUrls(css: string, basePath: string): Promise<string> {
    const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g
    const matches: { match: string; url: string }[] = []

    let match
    while ((match = urlRegex.exec(css)) !== null) {
      matches.push({ match: match[0], url: match[1] })
    }

    let result = css
    for (const { match, url } of matches) {
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('http://') || url.startsWith('https://')) {
        continue
      }

      try {
        const resolvedPath = this.resolveRelativePath(url, basePath)
        const blobUrl = await this.createBlobUrl(resolvedPath)
        result = result.replace(match, `url("${blobUrl}")`)
      } catch (error) {
        console.warn(`Failed to rewrite CSS URL: ${url}`, error)
      }
    }

    return result
  }

  private normalizePath(path: string): string {
    // Remove leading slash
    let normalized = path.replace(/^\//, '')

    // Resolve relative parts
    const parts = normalized.split('/')
    const resolved: string[] = []

    for (const part of parts) {
      if (part === '..') {
        resolved.pop()
      } else if (part !== '.' && part !== '') {
        resolved.push(part)
      }
    }

    return resolved.join('/')
  }

  private resolveRelativePath(href: string, basePath: string): string {
    if (href.startsWith('/')) {
      return href.substring(1)
    }

    const parts = [...basePath.split('/').filter(Boolean), ...href.split('/')]
    const resolved: string[] = []

    for (const part of parts) {
      if (part === '..') {
        resolved.pop()
      } else if (part !== '.') {
        resolved.push(part)
      }
    }

    return resolved.join('/')
  }

  private getMediaType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() || ''

    const mimeTypes: Record<string, string> = {
      // Documents
      html: 'text/html',
      htm: 'text/html',
      xhtml: 'application/xhtml+xml',
      xml: 'application/xml',
      opf: 'application/oebps-package+xml',
      ncx: 'application/x-dtbncx+xml',

      // Styles
      css: 'text/css',

      // Scripts (though we block these)
      js: 'application/javascript',

      // Images
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      webp: 'image/webp',

      // Fonts
      ttf: 'font/ttf',
      otf: 'font/otf',
      woff: 'font/woff',
      woff2: 'font/woff2',

      // Audio
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',

      // Video
      mp4: 'video/mp4',
      webm: 'video/webm',
    }

    return mimeTypes[ext] || 'application/octet-stream'
  }

  private isHtmlContent(mediaType: string): boolean {
    return (
      mediaType === 'text/html' ||
      mediaType === 'application/xhtml+xml' ||
      mediaType === 'application/xml'
    )
  }
}
