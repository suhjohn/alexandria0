import type { PdfReaderSettings } from './PdfReader'

export type PageMetric = {
  index: number
  width: number
  height: number
}

export type ContainerSize = {
  width: number
  height: number
}

export type SpreadLayout = {
  pageIndices: number[]
  isDouble: boolean
  scale: number
  gap: number
  width: number
  height: number
  pages: Array<{
    index: number
    width: number
    height: number
  }>
}

const DEFAULT_PAGE: PageMetric = { index: 0, width: 612, height: 792 }
const PAGE_GAP = 18

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function metricFor(
  metrics: ReadonlyMap<number, PageMetric>,
  pageIndex: number,
): PageMetric {
  return metrics.get(pageIndex) ?? { ...DEFAULT_PAGE, index: pageIndex }
}

export function spreadStartFor(
  pageIndex: number,
  pageCount: number,
  isDouble: boolean,
): number {
  const clamped = clamp(pageIndex, 0, Math.max(0, pageCount - 1))
  if (!isDouble || clamped === 0) return clamped
  return clamped % 2 === 1 ? clamped : Math.max(1, clamped - 1)
}

export function canUseDoubleSpread(
  pageIndex: number,
  pageCount: number,
  metrics: ReadonlyMap<number, PageMetric>,
  container: ContainerSize,
): boolean {
  if (pageIndex === 0 || pageCount <= 2 || container.width <= 0) return false
  const start = spreadStartFor(pageIndex, pageCount, true)
  const pageA = metricFor(metrics, start)
  const pageB = metricFor(metrics, Math.min(pageCount - 1, start + 1))
  const projectedWidth =
    container.height > 0
      ? container.height * (pageA.width / pageA.height) +
        container.height * (pageB.width / pageB.height) +
        PAGE_GAP
      : pageA.width + pageB.width + PAGE_GAP
  return container.width >= projectedWidth
}

export function getVisiblePageIndices(
  pageIndex: number,
  pageCount: number,
  settings: Pick<PdfReaderSettings, 'spread'>,
  metrics: ReadonlyMap<number, PageMetric>,
  container: ContainerSize,
): number[] {
  if (pageCount <= 0) return []
  const isDouble =
    settings.spread === 'double' ||
    (settings.spread === 'auto' &&
      canUseDoubleSpread(pageIndex, pageCount, metrics, container))
  const start = spreadStartFor(pageIndex, pageCount, isDouble)
  if (!isDouble || start === 0 || start + 1 >= pageCount) return [start]
  return [start, start + 1]
}

export function getSpreadRenderWindow(
  pageIndex: number,
  pageCount: number,
  settings: Pick<PdfReaderSettings, 'spread'>,
  metrics: ReadonlyMap<number, PageMetric>,
  container: ContainerSize,
  radius: number,
): number[] {
  const indices = new Set<number>()
  const current = getVisiblePageIndices(
    pageIndex,
    pageCount,
    settings,
    metrics,
    container,
  )
  const first = current[0] ?? pageIndex
  const isDouble = current.length > 1
  const step = isDouble ? 2 : 1
  for (let offset = -radius; offset <= radius; offset += 1) {
    const start =
      first === 0 && offset > 0
        ? first + 1 + (offset - 1) * step
        : first + offset * step
    for (const idx of getVisiblePageIndices(
      clamp(start, 0, Math.max(0, pageCount - 1)),
      pageCount,
      settings,
      metrics,
      container,
    )) {
      indices.add(idx)
    }
  }
  return [...indices]
    .filter((idx) => idx >= 0 && idx < pageCount)
    .sort((a, b) => a - b)
}

export function computeSpreadLayout(
  pageIndices: number[],
  metrics: ReadonlyMap<number, PageMetric>,
  container: ContainerSize,
  settings: Pick<PdfReaderSettings, 'fit' | 'zoom'>,
): SpreadLayout {
  const pagesAtScaleOne = pageIndices.map((index) => metricFor(metrics, index))
  const gap = pagesAtScaleOne.length > 1 ? PAGE_GAP : 0
  const naturalWidth =
    pagesAtScaleOne.reduce((sum, page) => sum + page.width, 0) + gap
  const naturalHeight = Math.max(
    ...pagesAtScaleOne.map((page) => page.height),
    1,
  )
  const widthScale = container.width > 0 ? container.width / naturalWidth : 1
  const pageScale =
    container.width > 0 && container.height > 0
      ? Math.min(widthScale, container.height / naturalHeight)
      : widthScale
  const fitScale = settings.fit === 'page' ? pageScale : widthScale
  const scale = clamp(fitScale * settings.zoom, 0.05, 8)
  const scaledGap = gap * scale
  const pages = pagesAtScaleOne.map((page) => ({
    index: page.index,
    width: page.width * scale,
    height: page.height * scale,
  }))
  return {
    pageIndices,
    isDouble: pageIndices.length > 1,
    scale,
    gap: scaledGap,
    width: pages.reduce((sum, page) => sum + page.width, 0) + scaledGap,
    height: Math.max(...pages.map((page) => page.height), 1),
    pages,
  }
}
