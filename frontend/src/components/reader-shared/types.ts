import type { ImagePart, TextPart } from 'ai'

export type ReaderHandle = {
  next: () => void
  prev: () => void
  goToHref: (href: string) => void
  getVisiblePage: () => VisiblePageInfo | null
  getVisiblePageStable: (opts?: {
    timeoutMs?: number
  }) => Promise<VisiblePageInfo | null>
  getVisiblePageParts: (
    opts?: PartOptions,
  ) => Promise<Array<TextPart | ImagePart> | null>
  getVisiblePagePartsStable: (
    opts?: PartOptions & { timeoutMs?: number },
  ) => Promise<Array<TextPart | ImagePart> | null>
  getSpineItemText: (opts: {
    spineIndex: number
    maxChars?: number
  }) => Promise<string | null>
  getSpineItemParts: (
    opts: { spineIndex: number } & PartOptions,
  ) => Promise<Array<TextPart | ImagePart> | null>
  getPageRangeParts: (
    opts: { startPage: number; endPage: number } & PartOptions,
  ) => Promise<Array<TextPart | ImagePart> | null>
}

export type PartOptions = {
  maxChars?: number
  maxImages?: number
  maxImageBytes?: number
}

export type VisiblePageInfo = {
  href: string
  spineIndex: number
  pageIndex: number
  chapterTotalPages: number
  text: string
}
