export type EpubReaderV2Theme = 'light' | 'sepia' | 'dark';

export type EpubReaderV2FlowMode = 'paginated' | 'scrolled';

export type EpubReaderV2ThemePreset = 'original' | 'quiet' | 'paper' | 'bold' | 'calm' | 'focus';

export type EpubReaderV2MarginSize = 'small' | 'medium' | 'large';

export type EpubReaderV2Settings = {
  theme: EpubReaderV2Theme;
  flowMode: EpubReaderV2FlowMode;
  fontScale: number;
  lineHeight: number;
  pageScale: number;
  pagePaddingPx: number;
  columnGapPx: number;
  fontFamily: 'publisher' | 'serif' | 'sans';
  textAlign: 'auto' | 'left' | 'justify';
  marginSize: EpubReaderV2MarginSize;
  themePreset: EpubReaderV2ThemePreset;
};

// Theme preset configurations
export type ThemePresetConfig = {
  name: string;
  theme: EpubReaderV2Theme;
  bg: string;
  fg: string;
  fontFamily: EpubReaderV2Settings['fontFamily'];
  fontWeight: number;
};

export const THEME_PRESETS: Record<EpubReaderV2ThemePreset, ThemePresetConfig> = {
  original: {
    name: 'Original',
    theme: 'dark',
    bg: '#000000',
    fg: '#ffffff',
    fontFamily: 'publisher',
    fontWeight: 400,
  },
  quiet: {
    name: 'Quiet',
    theme: 'dark',
    bg: '#1c1c1e',
    fg: '#e5e5e7',
    fontFamily: 'serif',
    fontWeight: 400,
  },
  paper: {
    name: 'Paper',
    theme: 'sepia',
    bg: '#f5f1e8',
    fg: '#3d3731',
    fontFamily: 'serif',
    fontWeight: 400,
  },
  bold: {
    name: 'Bold',
    theme: 'dark',
    bg: '#000000',
    fg: '#ffffff',
    fontFamily: 'sans',
    fontWeight: 600,
  },
  calm: {
    name: 'Calm',
    theme: 'sepia',
    bg: '#e8dcc8',
    fg: '#4a4137',
    fontFamily: 'serif',
    fontWeight: 400,
  },
  focus: {
    name: 'Focus',
    theme: 'dark',
    bg: '#1a1915',
    fg: '#d4cfc4',
    fontFamily: 'serif',
    fontWeight: 400,
  },
};

export type EpubReaderV2Location = {
  spineIndex: number;
  pageIndex: number;
  chapterTotalPages: number;
  href: string;
};

export type EpubReaderV2SpineItem = {
  id: string;
  href: string;
  mediaType: string;
  linear: boolean;
  properties: string[];
  title?: string;
};

export type EpubReaderV2TocItem = {
  title: string;
  href: string;
  children: EpubReaderV2TocItem[];
};

export type EpubReaderV2Rendition = {
  layout: 'reflowable' | 'pre-paginated';
  spread?: string;
  pageProgressionDirection: 'ltr' | 'rtl' | 'default';
};

export type EpubReaderV2Publication = {
  bookId: string;
  opfPath: string;
  title?: string;
  language?: string;
  author?: string;
  rendition: EpubReaderV2Rendition;
  spine: EpubReaderV2SpineItem[];
  toc: EpubReaderV2TocItem[];
  manifestById: Map<string, { href: string; mediaType: string; properties: string[] }>;
  manifestByPath: Map<string, { id: string; mediaType: string; properties: string[] }>;
};

export type EpubReaderV2Progress = {
  loadedBytes: number;
  totalBytes?: number;
};

export type EpubReaderV2ReadyPayload = {
  bookId: string;
  title?: string;
  author?: string;
  language?: string;
  spineItemCount: number;
  rendition: EpubReaderV2Rendition;
};

export type EpubReaderV2ErrorCode =
  | 'FETCH_FAILED'
  | 'EPUB_INVALID'
  | 'ZIP_INVALID'
  | 'ZIP_UNSUPPORTED'
  | 'PARSE_FAILED'
  | 'RENDER_FAILED';

export class EpubReaderV2Error extends Error {
  readonly code: EpubReaderV2ErrorCode;
  readonly cause?: unknown;

  constructor(code: EpubReaderV2ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'EpubReaderV2Error';
    this.code = code;
    this.cause = cause;
  }
}

