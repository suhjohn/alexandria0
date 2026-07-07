import { useMemo, useSyncExternalStore } from 'react'
import type { EpubReaderV2Settings } from '@/components/epubreader_v2/types'

export const READER_SETTINGS_STORAGE_KEY = 'mfv2:readerSettings'

export type PdfReaderPersistedSettings = {
  spread: 'auto' | 'single' | 'double'
  fit: 'width' | 'page'
  zoom: number
}

export type ReaderSettings = EpubReaderV2Settings & {
  pdf: PdfReaderPersistedSettings
}

export const DEFAULT_PDF_READER_SETTINGS: PdfReaderPersistedSettings = {
  spread: 'auto',
  fit: 'page',
  zoom: 1,
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  theme: 'dark',
  flowMode: 'paginated',
  fontScale: 1,
  lineHeight: 1.6,
  pageScale: 1,
  pagePaddingPx: 0,
  columnGapPx: 0,
  fontFamily: 'serif',
  textAlign: 'left',
  marginSize: 'medium',
  themePreset: 'quiet',
  pdf: DEFAULT_PDF_READER_SETTINGS,
}

const LOCAL_EVENT = 'mfv2:readerSettings:changed'

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function coercePdfSettings(raw: unknown): Partial<PdfReaderPersistedSettings> {
  if (!raw || typeof raw !== 'object') return {}
  const obj = raw as Record<string, unknown>
  const next: Partial<PdfReaderPersistedSettings> = {}
  if (
    obj.spread === 'auto' ||
    obj.spread === 'single' ||
    obj.spread === 'double'
  ) {
    next.spread = obj.spread
  }
  if (obj.fit === 'width' || obj.fit === 'page') {
    next.fit = obj.fit
  }
  if (typeof obj.zoom === 'number' && Number.isFinite(obj.zoom)) {
    next.zoom = clamp(obj.zoom, 0.5, 4)
  }
  return next
}

function coerceSettings(raw: unknown): Partial<ReaderSettings> | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  const next: Partial<ReaderSettings> = {}

  if (obj.theme === 'light' || obj.theme === 'sepia' || obj.theme === 'dark') {
    next.theme = obj.theme
  }
  if (typeof obj.fontScale === 'number' && Number.isFinite(obj.fontScale)) {
    next.fontScale = clamp(obj.fontScale, 0.5, 2)
  }
  if (typeof obj.lineHeight === 'number' && Number.isFinite(obj.lineHeight)) {
    next.lineHeight = clamp(obj.lineHeight, 1, 3)
  }
  if (typeof obj.pageScale === 'number' && Number.isFinite(obj.pageScale)) {
    next.pageScale = clamp(obj.pageScale, 0.5, 2)
  }
  if (
    typeof obj.pagePaddingPx === 'number' &&
    Number.isFinite(obj.pagePaddingPx)
  ) {
    next.pagePaddingPx = clamp(obj.pagePaddingPx, 0, 128)
  }
  if (
    typeof obj.columnGapPx === 'number' &&
    Number.isFinite(obj.columnGapPx)
  ) {
    next.columnGapPx = clamp(obj.columnGapPx, 0, 256)
  }
  if (
    obj.fontFamily === 'publisher' ||
    obj.fontFamily === 'serif' ||
    obj.fontFamily === 'sans'
  ) {
    next.fontFamily = obj.fontFamily
  }
  if (
    obj.themePreset === 'original' ||
    obj.themePreset === 'quiet' ||
    obj.themePreset === 'paper' ||
    obj.themePreset === 'bold' ||
    obj.themePreset === 'calm' ||
    obj.themePreset === 'focus'
  ) {
    next.themePreset = obj.themePreset
  }
  next.pdf = {
    ...DEFAULT_PDF_READER_SETTINGS,
    ...coercePdfSettings(obj.pdf),
  }

  return next
}

function readRawSettings(): string | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined')
    return null
  try {
    return localStorage.getItem(READER_SETTINGS_STORAGE_KEY)
  } catch {
    return null
  }
}

function subscribe(callback: () => void) {
  if (typeof window === 'undefined') return () => {}

  const onStorage = (event: StorageEvent) => {
    if (event.key !== READER_SETTINGS_STORAGE_KEY) return
    callback()
  }

  window.addEventListener('storage', onStorage)
  window.addEventListener(LOCAL_EVENT, callback)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(LOCAL_EVENT, callback)
  }
}

function normalizeReaderSettings(
  settings: EpubReaderV2Settings & {
    pdf?: Partial<PdfReaderPersistedSettings>
  },
): ReaderSettings {
  return {
    ...settings,
    flowMode: 'paginated',
    textAlign: 'left',
    marginSize: 'medium',
    pdf: {
      ...DEFAULT_PDF_READER_SETTINGS,
      ...coercePdfSettings(settings.pdf),
    },
  }
}

export function getReaderSettings(
  base?: Partial<EpubReaderV2Settings>,
): ReaderSettings {
  const stored = coerceSettings(safeParse(readRawSettings()))
  if (stored)
    return normalizeReaderSettings({
      ...DEFAULT_READER_SETTINGS,
      ...(base ?? {}),
      ...stored,
    })
  if (base) return normalizeReaderSettings({ ...DEFAULT_READER_SETTINGS, ...base })
  return normalizeReaderSettings(DEFAULT_READER_SETTINGS)
}

export function setReaderSettings(
  settings: EpubReaderV2Settings & {
    pdf?: Partial<PdfReaderPersistedSettings>
  },
) {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined')
    return
  const normalized = normalizeReaderSettings({
    ...settings,
    pdf: settings.pdf ?? getReaderSettings().pdf,
  })
  try {
    localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalized),
    )
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new Event(LOCAL_EVENT))
  } catch {
    // ignore
  }
}

export function updateReaderSettings(
  patch: Partial<EpubReaderV2Settings> & {
    pdf?: Partial<PdfReaderPersistedSettings>
  },
): ReaderSettings {
  const current = getReaderSettings()
  const next = normalizeReaderSettings({
    ...current,
    ...patch,
    pdf: {
      ...current.pdf,
      ...(patch.pdf ?? {}),
    },
  })
  setReaderSettings(next)
  return next
}

export function useReaderSettings(
  base?: Partial<EpubReaderV2Settings>,
): ReaderSettings {
  const raw = useSyncExternalStore(
    subscribe,
    () => readRawSettings(),
    () => null,
  )

  return useMemo(() => {
    const stored = coerceSettings(safeParse(raw))
    if (stored)
      return normalizeReaderSettings({
        ...DEFAULT_READER_SETTINGS,
        ...(base ?? {}),
        ...stored,
      })
    if (base)
      return normalizeReaderSettings({ ...DEFAULT_READER_SETTINGS, ...base })
    return normalizeReaderSettings(DEFAULT_READER_SETTINGS)
  }, [raw, base])
}

// One-time migration from older key.
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  const legacyKey = 'mfv2:epubreader_v2:settings'
  try {
    const existing = localStorage.getItem(READER_SETTINGS_STORAGE_KEY)
    if (!existing) {
      const legacy = localStorage.getItem(legacyKey)
      if (legacy) {
        localStorage.setItem(READER_SETTINGS_STORAGE_KEY, legacy)
        localStorage.removeItem(legacyKey)
      }
    }
  } catch {
    // ignore
  }
}
