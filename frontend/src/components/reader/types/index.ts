// EPUB Reader Type Definitions
// Based on EPUB 3.3 and Reading Systems specifications

// ============================================================================
// Core Publication Types
// ============================================================================

export interface EpubMetadata {
  title: string
  creator: string[]
  contributor: string[]
  publisher?: string
  language: string[]
  identifier: string
  description?: string
  subject: string[]
  date?: string
  modified?: string
  rights?: string
  coverImage?: string
}

export interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string[]
  fallback?: string
}

export interface SpineItem {
  id: string
  idref: string
  href: string
  linear: boolean
  properties: string[]
  index: number
}

export interface TocItem {
  id: string
  label: string
  href: string
  children: TocItem[]
}

export interface Landmark {
  type: string
  title: string
  href: string
}

export interface PageListItem {
  label: string
  href: string
}

export interface RenditionProperties {
  layout: 'reflowable' | 'pre-paginated'
  orientation: 'auto' | 'portrait' | 'landscape'
  spread: 'auto' | 'none' | 'landscape' | 'both'
  flow: 'auto' | 'paginated' | 'scrolled-doc' | 'scrolled-continuous'
  direction: 'ltr' | 'rtl' | 'auto'
}

export interface Publication {
  metadata: EpubMetadata
  manifest: Map<string, ManifestItem>
  spine: SpineItem[]
  toc: TocItem[]
  landmarks: Landmark[]
  pageList: PageListItem[]
  rendition: RenditionProperties
  ncxToc?: TocItem[] // EPUB 2 fallback
  opfPath: string
  basePath: string
}

// ============================================================================
// Resource Types
// ============================================================================

export interface Resource {
  path: string
  data: Uint8Array
  mediaType: string
  blobUrl?: string
}

export interface ResourceResolver {
  resolve(path: string): Promise<Resource | null>
  createBlobUrl(path: string): Promise<string>
  revokeBlobUrl(url: string): void
  revokeAll(): void
}

// ============================================================================
// Location & CFI Types
// ============================================================================

export interface CfiStep {
  nodeIndex: number
  id?: string
  textOffset?: number
  temporalOffset?: number
  spatialOffset?: { x: number; y: number }
  sideBias?: 'before' | 'after'
}

export interface CfiPath {
  steps: CfiStep[]
}

export interface CfiRange {
  start: CfiPath
  end: CfiPath
}

export interface Cfi {
  base: string // epubcfi(/6/X!)
  path: CfiPath
  range?: CfiRange
  raw: string
}

export interface Location {
  cfi: string
  spineIndex: number
  spineHref: string
  displayedPage?: number
  totalPages?: number
  percentage: number
  textExcerpt?: string
  domPath?: string // Fallback path
}

// ============================================================================
// Rendering Types
// ============================================================================

export interface ViewportSize {
  width: number
  height: number
}

export interface PaginationInfo {
  currentPage: number
  totalPages: number
  columnWidth: number
  columnGap: number
  scrollLeft: number
}

export interface RenderOptions {
  viewport: ViewportSize
  mode: 'paginated' | 'scrolled'
  gap: number
  theme: ReaderTheme
  settings: ReaderSettings
}

export interface SpineItemView {
  spineItem: SpineItem
  iframe: HTMLIFrameElement
  container: HTMLElement
  pagination: PaginationInfo | null
  isLoaded: boolean
  isVisible: boolean
}

// ============================================================================
// Theme & Settings Types
// ============================================================================

export type ThemeName = 'light' | 'sepia' | 'dark'

export interface ReaderTheme {
  name: ThemeName
  backgroundColor: string
  textColor: string
  linkColor: string
  selectionColor: string
}

export interface ReaderSettings {
  theme: ThemeName
  fontFamily: 'publisher' | 'serif' | 'sans-serif' | 'monospace'
  fontSize: number // in rem, e.g., 1.0, 1.2
  lineHeight: number // e.g., 1.5, 1.8
  marginSize: 'small' | 'medium' | 'large'
  textAlign: 'left' | 'justify'
  paragraphSpacing: number // in em
  mode: 'paginated' | 'scrolled'
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'light',
  fontFamily: 'publisher',
  fontSize: 1.0,
  lineHeight: 1.6,
  marginSize: 'medium',
  textAlign: 'left',
  paragraphSpacing: 1.0,
  mode: 'paginated',
}

export const THEMES: Record<ThemeName, ReaderTheme> = {
  light: {
    name: 'light',
    backgroundColor: '#ffffff',
    textColor: '#1a1a1a',
    linkColor: '#0066cc',
    selectionColor: 'rgba(0, 102, 204, 0.3)',
  },
  sepia: {
    name: 'sepia',
    backgroundColor: '#f4ecd8',
    textColor: '#5b4636',
    linkColor: '#7b5a3c',
    selectionColor: 'rgba(123, 90, 60, 0.3)',
  },
  dark: {
    name: 'dark',
    backgroundColor: '#1a1a1a',
    textColor: '#e0e0e0',
    linkColor: '#6699cc',
    selectionColor: 'rgba(102, 153, 204, 0.3)',
  },
}

// ============================================================================
// Annotation Types
// ============================================================================

export type AnnotationType = 'highlight' | 'note' | 'bookmark'

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

export interface Annotation {
  id: string
  bookId: string
  type: AnnotationType
  createdAt: number
  updatedAt: number
  location: {
    cfi: string
    endCfi?: string // For highlights
    spineHref: string
    spineIndex: number
  }
  excerpt?: string
  note?: string
  color?: HighlightColor
}

export interface AnnotationRange {
  annotation: Annotation
  domRange?: Range
  elements?: HTMLElement[]
}

// ============================================================================
// Search Types
// ============================================================================

export interface SearchResult {
  spineIndex: number
  spineHref: string
  cfi: string
  excerpt: string
  matchStart: number
  matchEnd: number
}

export interface SearchIndex {
  bookId: string
  terms: Map<string, SearchOccurrence[]>
  builtAt: number
}

export interface SearchOccurrence {
  spineIndex: number
  cfi: string
  offset: number
  context: string
}

export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  maxResults: number
}

// ============================================================================
// State Machine Types
// ============================================================================

export type ReaderState =
  | { status: 'idle' }
  | { status: 'downloading'; progress: number }
  | { status: 'unpacking' }
  | { status: 'parsing' }
  | { status: 'rendering'; spineIndex: number }
  | { status: 'ready' }
  | { status: 'error'; error: ReaderError }

export interface ReaderError {
  code: string
  message: string
  details?: unknown
  recoverable: boolean
}

// ============================================================================
// Storage Types
// ============================================================================

export interface StoredBook {
  id: string
  url: string
  blob: Blob
  metadata: EpubMetadata
  hash: string
  etag?: string
  addedAt: number
  lastOpenedAt: number
  offlineEnabled: boolean
}

export interface StoredPosition {
  bookId: string
  cfi: string
  spineHref: string
  percentage: number
  updatedAt: number
}

export interface StoredSettings {
  global: ReaderSettings
  perBook: Record<string, Partial<ReaderSettings>>
}

// ============================================================================
// Event Types
// ============================================================================

export interface ReaderEvents {
  onReady: (publication: Publication) => void
  onLocationChange: (location: Location) => void
  onError: (error: ReaderError) => void
  onProgressChange: (progress: number) => void
  onSpineItemChange: (spineItem: SpineItem) => void
  onSelectionChange: (selection: Selection | null, cfi: string | null) => void
  onAnnotationClick: (annotation: Annotation) => void
  onLinkClick: (href: string, isInternal: boolean) => void
}

// ============================================================================
// Reader API Types
// ============================================================================

export interface ReaderApi {
  // Navigation
  next(): Promise<void>
  prev(): Promise<void>
  goTo(target: string | number): Promise<void> // CFI, href, or spine index
  goToSpineItem(index: number, elementId?: string): Promise<void>

  // Location
  getCurrentLocation(): Location | null
  getProgress(): number

  // Settings
  setTheme(theme: ThemeName): void
  setSettings(settings: Partial<ReaderSettings>): void
  getSettings(): ReaderSettings

  // Annotations
  addBookmark(): Promise<Annotation>
  addHighlight(color?: HighlightColor, note?: string): Promise<Annotation | null>
  removeAnnotation(id: string): Promise<void>
  getAnnotations(): Annotation[]

  // Search
  search(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]>
  clearSearch(): void

  // History
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): Promise<void>
  goForward(): Promise<void>
}
