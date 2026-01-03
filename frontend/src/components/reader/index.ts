// EPUB Reader - Main Export
// A complete, standards-compliant EPUB reading system

export { EpubReader } from './EpubReader'
export type { EpubReaderProps } from './EpubReader'

// Core modules
export { epubFetcher, EpubFetcher } from './core/fetcher'
export { ZipContainer } from './core/container'
export { EpubParser } from './core/parser'
export { EpubResourceResolver } from './core/resources'

// Rendering
export { EpubRenderer } from './rendering/renderer'

// CFI
export { CfiParser, CfiGenerator, CfiResolver, compareCfi, isCfiInRange } from './cfi'

// Annotations
export { AnnotationManager, createHighlightFromSelection } from './annotations'

// Search
export { SearchEngine, quickSearch } from './search'

// Storage
export { readerStorage, ReaderStorage } from './storage'

// Hooks
export { useEpubReader } from './hooks'
export type { UseEpubReaderOptions, UseEpubReaderReturn } from './hooks'

// UI Components
export { TableOfContents } from './ui/TableOfContents'
export { ReaderSettingsPanel } from './ui/ReaderSettings'
export { ReaderToolbar } from './ui/ReaderToolbar'

// Types
export * from './types'
