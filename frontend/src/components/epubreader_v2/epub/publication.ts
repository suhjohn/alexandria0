import {
  EpubReaderV2Error,
  type EpubReaderV2Publication,
  type EpubReaderV2Rendition,
  type EpubReaderV2SpineItem,
  type EpubReaderV2TocItem,
} from '../types'
import { normalizePath, resolveRelativePath, splitHref } from '../utils/path'
import { decodeText } from '../utils/text'

type ZipLike = {
  read(path: string): Promise<Uint8Array>
}

function firstTextByLocalName(
  doc: XMLDocument,
  localName: string,
): string | undefined {
  const els = doc.getElementsByTagNameNS('*', localName)
  if (!els.length) return undefined
  const text = els[0]?.textContent?.trim() ?? ''
  return text || undefined
}

function allTextByLocalName(doc: XMLDocument, localName: string): string[] {
  const els = Array.from(doc.getElementsByTagNameNS('*', localName))
  const values = els
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean)
  return Array.from(new Set(values))
}

function getMetaProperty(
  doc: XMLDocument,
  property: string,
): string | undefined {
  const metas = Array.from(doc.getElementsByTagName('meta'))
  for (const meta of metas) {
    const prop = meta.getAttribute('property') ?? meta.getAttribute('name')
    if (prop !== property) continue
    const value = meta.getAttribute('content') ?? meta.textContent ?? ''
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function parseContainerXml(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const rootfile = doc.getElementsByTagName('rootfile')[0]
  const fullPath = rootfile?.getAttribute('full-path')?.trim()
  if (!fullPath) throw new Error('container.xml missing rootfile full-path')
  return normalizePath(fullPath)
}

function parseOpf(xml: string, opfPath: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const pkg = doc.getElementsByTagName('package')[0]
  if (!pkg) throw new Error('OPF missing <package>')

  const uniqueIdId = pkg.getAttribute('unique-identifier')?.trim() ?? undefined
  let uniqueIdentifier: string | undefined
  if (uniqueIdId) {
    const identifiers = Array.from(
      doc.getElementsByTagNameNS('*', 'identifier'),
    )
    for (const el of identifiers) {
      if (el.getAttribute('id')?.trim() === uniqueIdId) {
        uniqueIdentifier = el.textContent?.trim() ?? undefined
        if (uniqueIdentifier) break
      }
    }
  }

  const title = firstTextByLocalName(doc, 'title')
  const language = firstTextByLocalName(doc, 'language')
  const author = firstTextByLocalName(doc, 'creator')
  const publisher = firstTextByLocalName(doc, 'publisher')
  const description = firstTextByLocalName(doc, 'description')
  const subjects = allTextByLocalName(doc, 'subject')
  const date = firstTextByLocalName(doc, 'date')
  const modified = getMetaProperty(doc, 'dcterms:modified')

  const manifestById = new Map<
    string,
    { href: string; mediaType: string; properties: string[] }
  >()
  const manifestByPath = new Map<
    string,
    { id: string; mediaType: string; properties: string[] }
  >()
  const manifestItems = Array.from(doc.getElementsByTagName('item'))
  for (const item of manifestItems) {
    const id = item.getAttribute('id')?.trim()
    const href = item.getAttribute('href')?.trim()
    const mediaType = item.getAttribute('media-type')?.trim()
    if (!id || !href || !mediaType) continue
    const properties = (item.getAttribute('properties') ?? '')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const resolvedPath = resolveRelativePath(opfPath, href)
    manifestById.set(id, { href: resolvedPath, mediaType, properties })
    manifestByPath.set(resolvedPath, { id, mediaType, properties })
  }

  const spineEl = doc.getElementsByTagName('spine')[0]
  if (!spineEl) throw new Error('OPF missing <spine>')
  const ncxId = spineEl.getAttribute('toc')?.trim() ?? undefined

  const pageProgressionDirection =
    (spineEl.getAttribute('page-progression-direction')?.trim() as
      | 'rtl'
      | 'ltr'
      | 'default'
      | undefined) ?? 'default'

  const renditionLayout =
    (getMetaProperty(doc, 'rendition:layout') as
      | 'reflowable'
      | 'pre-paginated'
      | undefined) ?? 'reflowable'
  const renditionSpread = getMetaProperty(doc, 'rendition:spread')

  const spineItemRefs = Array.from(spineEl.getElementsByTagName('itemref'))
  const spine: EpubReaderV2SpineItem[] = []
  for (const itemref of spineItemRefs) {
    const idref = itemref.getAttribute('idref')?.trim()
    if (!idref) continue
    const manifestItem = manifestById.get(idref)
    if (!manifestItem) continue
    const linear = (itemref.getAttribute('linear') ?? 'yes') !== 'no'
    const properties = (itemref.getAttribute('properties') ?? '')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
    spine.push({
      id: idref,
      href: manifestItem.href,
      mediaType: manifestItem.mediaType,
      linear,
      properties,
    })
  }

  const navItem = Array.from(manifestById.values()).find((i) =>
    i.properties.includes('nav'),
  )
  const ncxPath =
    ncxId && manifestById.get(ncxId)?.href
      ? manifestById.get(ncxId)!.href
      : Array.from(manifestById.values()).find(
          (i) => i.mediaType === 'application/x-dtbncx+xml',
        )?.href

  const rendition: EpubReaderV2Rendition = {
    layout: renditionLayout,
    spread: renditionSpread,
    pageProgressionDirection,
  }

  return {
    uniqueIdentifier,
    title,
    language,
    author,
    publisher,
    description,
    subjects,
    date,
    modified,
    rendition,
    spine,
    manifestById,
    manifestByPath,
    navPath: navItem?.href,
    ncxPath,
  }
}

function parseNavToc(docPath: string, html: string): EpubReaderV2TocItem[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const navs = Array.from(doc.querySelectorAll('nav'))
  const tocNav =
    navs.find((n) => n.getAttribute('epub:type') === 'toc') ??
    navs.find((n) => n.getAttribute('role') === 'doc-toc') ??
    navs[0]
  if (!tocNav) return []

  const ol = tocNav.querySelector('ol')
  if (!ol) return []

  const parseOl = (container: HTMLOListElement): EpubReaderV2TocItem[] => {
    const items: EpubReaderV2TocItem[] = []
    const lis = Array.from(container.children).filter(
      (c): c is HTMLLIElement => c.tagName.toLowerCase() === 'li',
    )
    for (const li of lis) {
      const a = li.querySelector('a[href]')
      if (!a) continue
      const rawHref = a.getAttribute('href') ?? ''
      const title = (a.textContent ?? '').trim() || rawHref
      const { path, fragment } = splitHref(rawHref)
      const resolvedPath = path ? resolveRelativePath(docPath, path) : docPath
      const href = fragment ? `${resolvedPath}#${fragment}` : resolvedPath
      const childOl = li.querySelector('ol')
      items.push({
        title,
        href,
        children: childOl ? parseOl(childOl) : [],
      })
    }
    return items
  }

  return parseOl(ol)
}

function parseNcxToc(docPath: string, xml: string): EpubReaderV2TocItem[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const navMap = doc.getElementsByTagNameNS('*', 'navMap')[0]
  if (!navMap) return []

  const parseNavPoints = (points: Element[]): EpubReaderV2TocItem[] => {
    const out: EpubReaderV2TocItem[] = []
    for (const p of points) {
      if (p.localName !== 'navPoint') continue
      const label = p.getElementsByTagName('text')[0]?.textContent?.trim() ?? ''
      const src =
        p.getElementsByTagName('content')[0]?.getAttribute('src')?.trim() ?? ''
      if (!src) continue
      const { path, fragment } = splitHref(src)
      const resolvedPath = path ? resolveRelativePath(docPath, path) : docPath
      const href = fragment ? `${resolvedPath}#${fragment}` : resolvedPath
      const childPoints = Array.from(p.children).filter(
        (c) => c.localName === 'navPoint',
      )
      out.push({
        title: label || href,
        href,
        children: parseNavPoints(childPoints),
      })
    }
    return out
  }

  const points = Array.from(navMap.children).filter(
    (c) => c.localName === 'navPoint',
  )
  return parseNavPoints(points)
}

function hashStringToBase36(input: string): string {
  let h1 = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h1 ^= input.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193)
  }
  return (h1 >>> 0).toString(36)
}

export async function loadEpubPublication(
  zip: ZipLike,
  bookUrl: string,
): Promise<EpubReaderV2Publication> {
  try {
    const readZip = async (path: string) => {
      try {
        return await zip.read(path)
      } catch (err) {
        throw new EpubReaderV2Error(
          'ZIP_INVALID',
          `Failed to read EPUB file: ${path}`,
          err,
        )
      }
    }

    const containerBytes = await readZip('META-INF/container.xml')
    const containerXml = decodeText(containerBytes)
    const opfPath = parseContainerXml(containerXml)

    const opfBytes = await readZip(opfPath)
    const opfXml = decodeText(opfBytes)
    const opf = parseOpf(opfXml, opfPath)

    let toc: EpubReaderV2TocItem[] = []
    if (opf.navPath) {
      try {
        const navBytes = await readZip(opf.navPath)
        const navHtml = decodeText(navBytes)
        toc = parseNavToc(opf.navPath, navHtml)
      } catch (err) {
        console.warn(
          '[epubreader_v2] Failed to load nav TOC; continuing without TOC',
          err,
        )
        toc = []
      }
    } else if (opf.ncxPath) {
      try {
        const ncxBytes = await readZip(opf.ncxPath)
        const ncxXml = decodeText(ncxBytes)
        toc = parseNcxToc(opf.ncxPath, ncxXml)
      } catch (err) {
        console.warn(
          '[epubreader_v2] Failed to load NCX TOC; continuing without TOC',
          err,
        )
        toc = []
      }
    }

    const bookIdSource = opf.uniqueIdentifier || bookUrl
    const bookId = `epub:${hashStringToBase36(bookIdSource)}`

    return {
      bookId,
      opfPath,
      title: opf.title,
      language: opf.language,
      author: opf.author,
      publisher: opf.publisher,
      description: opf.description,
      subjects: opf.subjects,
      date: opf.date,
      identifier: opf.uniqueIdentifier,
      modified: opf.modified,
      rendition: opf.rendition,
      spine: opf.spine,
      toc,
      manifestById: opf.manifestById,
      manifestByPath: opf.manifestByPath,
    }
  } catch (err) {
    console.error(err)
    throw new EpubReaderV2Error(
      'PARSE_FAILED',
      'Failed to parse EPUB publication',
      err,
    )
  }
}
