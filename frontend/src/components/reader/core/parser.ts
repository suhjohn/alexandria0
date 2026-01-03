// EPUB Package Parser Module
// Parses OPF, nav.xhtml, and toc.ncx files

import type {
  EpubMetadata,
  ManifestItem,
  SpineItem,
  TocItem,
  Landmark,
  PageListItem,
  RenditionProperties,
  Publication,
} from '../types'
import type { EpubContainer } from './container'

const DC_NS = 'http://purl.org/dc/elements/1.1/'
const OPF_NS = 'http://www.idpf.org/2007/opf'
const NCX_NS = 'http://www.daisy.org/z3986/2005/ncx/'
const EPUB_NS = 'http://www.idpf.org/2007/ops'

export class EpubParser {
  private container: EpubContainer
  private opfDoc: Document | null = null
  private opfPath: string = ''
  private basePath: string = ''

  constructor(container: EpubContainer) {
    this.container = container
  }

  async parse(): Promise<Publication> {
    // Get OPF path from container.xml
    this.opfPath = await this.container.getOPFPath()
    this.basePath = this.opfPath.substring(0, this.opfPath.lastIndexOf('/') + 1)

    // Parse OPF document
    const opfContent = await this.container.readText(this.opfPath)
    const parser = new DOMParser()
    this.opfDoc = parser.parseFromString(opfContent, 'application/xml')

    // Parse all components
    const metadata = this.parseMetadata()
    const manifest = this.parseManifest()
    const spine = this.parseSpine(manifest)
    const rendition = this.parseRenditionProperties()

    // Parse navigation (EPUB3 nav or EPUB2 NCX)
    const { toc, landmarks, pageList, ncxToc } = await this.parseNavigation(manifest)

    return {
      metadata,
      manifest,
      spine,
      toc,
      landmarks,
      pageList,
      rendition,
      ncxToc,
      opfPath: this.opfPath,
      basePath: this.basePath,
    }
  }

  private parseMetadata(): EpubMetadata {
    const doc = this.opfDoc!
    const metadata = doc.querySelector('metadata')!

    const getText = (selector: string, ns?: string): string | undefined => {
      const el = ns
        ? metadata.getElementsByTagNameNS(ns, selector)[0]
        : metadata.querySelector(selector)
      return el?.textContent?.trim()
    }

    const getAll = (selector: string, ns?: string): string[] => {
      const elements = ns
        ? Array.from(metadata.getElementsByTagNameNS(ns, selector))
        : Array.from(metadata.querySelectorAll(selector))
      return elements.map((el) => el.textContent?.trim()).filter(Boolean) as string[]
    }

    // Get identifier
    const identifier = getText('identifier', DC_NS) || ''

    // Get title
    const title = getText('title', DC_NS) || 'Untitled'

    // Get creators
    const creator = getAll('creator', DC_NS)

    // Get contributors
    const contributor = getAll('contributor', DC_NS)

    // Get publisher
    const publisher = getText('publisher', DC_NS)

    // Get language(s)
    const language = getAll('language', DC_NS)
    if (language.length === 0) language.push('en')

    // Get description
    const description = getText('description', DC_NS)

    // Get subjects
    const subject = getAll('subject', DC_NS)

    // Get date
    const date = getText('date', DC_NS)

    // Get modified (EPUB3)
    const modifiedMeta = Array.from(metadata.querySelectorAll('meta')).find(
      (el) => el.getAttribute('property') === 'dcterms:modified'
    )
    const modified = modifiedMeta?.textContent?.trim()

    // Get rights
    const rights = getText('rights', DC_NS)

    // Get cover image
    const coverImage = this.findCoverImage()

    return {
      identifier,
      title,
      creator,
      contributor,
      publisher,
      language,
      description,
      subject,
      date,
      modified,
      rights,
      coverImage,
    }
  }

  private findCoverImage(): string | undefined {
    const doc = this.opfDoc!

    // EPUB3: look for cover-image property
    const manifestItem = Array.from(doc.querySelectorAll('manifest item')).find((item) =>
      item.getAttribute('properties')?.includes('cover-image')
    )
    if (manifestItem) {
      return this.resolvePath(manifestItem.getAttribute('href') || '')
    }

    // EPUB2: look for meta name="cover" content="id"
    const coverMeta = doc.querySelector('meta[name="cover"]')
    if (coverMeta) {
      const coverId = coverMeta.getAttribute('content')
      const coverItem = doc.querySelector(`manifest item[id="${coverId}"]`)
      if (coverItem) {
        return this.resolvePath(coverItem.getAttribute('href') || '')
      }
    }

    return undefined
  }

  private parseManifest(): Map<string, ManifestItem> {
    const doc = this.opfDoc!
    const manifest = new Map<string, ManifestItem>()

    const items = doc.querySelectorAll('manifest item')
    items.forEach((item) => {
      const id = item.getAttribute('id') || ''
      const href = item.getAttribute('href') || ''
      const mediaType = item.getAttribute('media-type') || ''
      const propertiesStr = item.getAttribute('properties') || ''
      const fallback = item.getAttribute('fallback') || undefined

      manifest.set(id, {
        id,
        href: this.resolvePath(href),
        mediaType,
        properties: propertiesStr ? propertiesStr.split(/\s+/) : [],
        fallback,
      })
    })

    return manifest
  }

  private parseSpine(manifest: Map<string, ManifestItem>): SpineItem[] {
    const doc = this.opfDoc!
    const spineEl = doc.querySelector('spine')!
    const items: SpineItem[] = []

    const itemrefs = spineEl.querySelectorAll('itemref')
    itemrefs.forEach((itemref, index) => {
      const idref = itemref.getAttribute('idref') || ''
      const linear = itemref.getAttribute('linear') !== 'no'
      const propertiesStr = itemref.getAttribute('properties') || ''

      const manifestItem = manifest.get(idref)
      if (manifestItem) {
        items.push({
          id: `spine-${index}`,
          idref,
          href: manifestItem.href,
          linear,
          properties: propertiesStr ? propertiesStr.split(/\s+/) : [],
          index,
        })
      }
    })

    return items
  }

  private parseRenditionProperties(): RenditionProperties {
    const doc = this.opfDoc!
    const spine = doc.querySelector('spine')
    const metadata = doc.querySelector('metadata')

    // Default values
    const rendition: RenditionProperties = {
      layout: 'reflowable',
      orientation: 'auto',
      spread: 'auto',
      flow: 'auto',
      direction: 'ltr',
    }

    // Check spine direction
    const spineDirection = spine?.getAttribute('page-progression-direction')
    if (spineDirection === 'rtl' || spineDirection === 'ltr') {
      rendition.direction = spineDirection
    }

    // Check metadata for rendition properties
    if (metadata) {
      const metas = metadata.querySelectorAll('meta')
      metas.forEach((meta) => {
        const property = meta.getAttribute('property') || ''
        const value = meta.textContent?.trim() || ''

        switch (property) {
          case 'rendition:layout':
            if (value === 'pre-paginated' || value === 'reflowable') {
              rendition.layout = value
            }
            break
          case 'rendition:orientation':
            if (value === 'auto' || value === 'portrait' || value === 'landscape') {
              rendition.orientation = value
            }
            break
          case 'rendition:spread':
            if (['auto', 'none', 'landscape', 'both'].includes(value)) {
              rendition.spread = value as RenditionProperties['spread']
            }
            break
          case 'rendition:flow':
            if (['auto', 'paginated', 'scrolled-doc', 'scrolled-continuous'].includes(value)) {
              rendition.flow = value as RenditionProperties['flow']
            }
            break
        }
      })
    }

    return rendition
  }

  private async parseNavigation(
    manifest: Map<string, ManifestItem>
  ): Promise<{
    toc: TocItem[]
    landmarks: Landmark[]
    pageList: PageListItem[]
    ncxToc?: TocItem[]
  }> {
    // Try EPUB3 navigation document first
    const navItem = Array.from(manifest.values()).find((item) =>
      item.properties.includes('nav')
    )

    if (navItem) {
      try {
        const navContent = await this.container.readText(navItem.href)
        const parser = new DOMParser()
        const navDoc = parser.parseFromString(navContent, 'application/xhtml+xml')
        const navBasePath = navItem.href.substring(0, navItem.href.lastIndexOf('/') + 1)

        return {
          toc: this.parseNav(navDoc, 'toc', navBasePath),
          landmarks: this.parseLandmarks(navDoc, navBasePath),
          pageList: this.parsePageList(navDoc, navBasePath),
        }
      } catch (e) {
        console.warn('Failed to parse EPUB3 nav, falling back to NCX', e)
      }
    }

    // Fall back to EPUB2 NCX
    const ncxItem = Array.from(manifest.values()).find((item) =>
      item.mediaType === 'application/x-dtbncx+xml'
    )

    if (ncxItem) {
      try {
        const ncxContent = await this.container.readText(ncxItem.href)
        const parser = new DOMParser()
        const ncxDoc = parser.parseFromString(ncxContent, 'application/xml')
        const ncxBasePath = ncxItem.href.substring(0, ncxItem.href.lastIndexOf('/') + 1)

        const ncxToc = this.parseNcx(ncxDoc, ncxBasePath)
        return {
          toc: ncxToc,
          landmarks: [],
          pageList: [],
          ncxToc,
        }
      } catch (e) {
        console.warn('Failed to parse NCX', e)
      }
    }

    return { toc: [], landmarks: [], pageList: [] }
  }

  private parseNav(doc: Document, type: string, basePath: string): TocItem[] {
    const nav = Array.from(doc.querySelectorAll('nav')).find(
      (el) => el.getAttribute('epub:type')?.includes(type) ||
        el.getAttribute('role') === type
    )

    if (!nav) return []

    const ol = nav.querySelector('ol')
    if (!ol) return []

    return this.parseNavOl(ol, basePath)
  }

  private parseNavOl(ol: Element, basePath: string): TocItem[] {
    const items: TocItem[] = []

    ol.querySelectorAll(':scope > li').forEach((li, index) => {
      const a = li.querySelector(':scope > a, :scope > span > a')
      if (!a) return

      const href = a.getAttribute('href') || ''
      const label = a.textContent?.trim() || ''

      const childOl = li.querySelector(':scope > ol')
      const children = childOl ? this.parseNavOl(childOl, basePath) : []

      items.push({
        id: `toc-${index}-${Date.now()}`,
        label,
        href: this.resolveNavHref(href, basePath),
        children,
      })
    })

    return items
  }

  private parseLandmarks(doc: Document, basePath: string): Landmark[] {
    const nav = Array.from(doc.querySelectorAll('nav')).find(
      (el) => el.getAttribute('epub:type')?.includes('landmarks')
    )

    if (!nav) return []

    const landmarks: Landmark[] = []
    nav.querySelectorAll('a').forEach((a) => {
      const type = a.getAttribute('epub:type') || ''
      const title = a.textContent?.trim() || ''
      const href = a.getAttribute('href') || ''

      if (type && title) {
        landmarks.push({
          type,
          title,
          href: this.resolveNavHref(href, basePath),
        })
      }
    })

    return landmarks
  }

  private parsePageList(doc: Document, basePath: string): PageListItem[] {
    const nav = Array.from(doc.querySelectorAll('nav')).find(
      (el) => el.getAttribute('epub:type')?.includes('page-list')
    )

    if (!nav) return []

    const pageList: PageListItem[] = []
    nav.querySelectorAll('a').forEach((a) => {
      const label = a.textContent?.trim() || ''
      const href = a.getAttribute('href') || ''

      if (label) {
        pageList.push({
          label,
          href: this.resolveNavHref(href, basePath),
        })
      }
    })

    return pageList
  }

  private parseNcx(doc: Document, basePath: string): TocItem[] {
    const navMap = doc.getElementsByTagNameNS(NCX_NS, 'navMap')[0] ||
      doc.querySelector('navMap')

    if (!navMap) return []

    return this.parseNcxNavPoints(navMap, basePath)
  }

  private parseNcxNavPoints(parent: Element, basePath: string): TocItem[] {
    const items: TocItem[] = []

    // Get navPoint elements (handle both namespaced and non-namespaced)
    const navPoints = Array.from(parent.children).filter(
      (el) => el.localName === 'navPoint'
    )

    navPoints.forEach((navPoint, index) => {
      const navLabel = Array.from(navPoint.children).find(
        (el) => el.localName === 'navLabel'
      )
      const content = Array.from(navPoint.children).find(
        (el) => el.localName === 'content'
      )
      const text = navLabel?.querySelector('text') ||
        Array.from(navLabel?.children || []).find((el) => el.localName === 'text')

      const label = text?.textContent?.trim() || ''
      const src = content?.getAttribute('src') || ''

      const children = this.parseNcxNavPoints(navPoint, basePath)

      items.push({
        id: navPoint.getAttribute('id') || `ncx-${index}`,
        label,
        href: this.resolveNavHref(src, basePath),
        children,
      })
    })

    return items
  }

  private resolvePath(href: string): string {
    if (!href) return ''
    if (href.startsWith('/') || href.startsWith('http://') || href.startsWith('https://')) {
      return href
    }

    // Resolve relative to OPF directory
    const parts = [...this.basePath.split('/').filter(Boolean), ...href.split('/')]
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

  private resolveNavHref(href: string, navBasePath: string): string {
    if (!href) return ''
    if (href.startsWith('/') || href.startsWith('http://') || href.startsWith('https://')) {
      return href
    }

    // Resolve relative to nav document directory
    const parts = [...navBasePath.split('/').filter(Boolean), ...href.split('/')]
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
}
