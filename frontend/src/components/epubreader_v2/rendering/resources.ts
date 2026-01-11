import { decodeText } from '../utils/text';
import { hasUrlScheme, normalizePath, resolveRelativePath, splitHref, stripQuery } from '../utils/path';
import { isAllowedInlineUrl } from '../utils/url';

type ZipLike = {
  read(path: string): Promise<Uint8Array>;
};

export type ResolvedEpubHref = { path: string; fragment?: string };

const EXT_TO_MIME: Record<string, string> = {
  '.css': 'text/css',
  '.xhtml': 'application/xhtml+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function guessMimeType(path: string): string {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = lower.slice(dot);
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

export class EpubResourceStore {
  private readonly zip: ZipLike;
  private readonly mediaTypeByPath: Map<string, string>;
  private readonly urlByPath = new Map<string, string>();
  private readonly canonicalPathByAlias = new Map<string, string>();

  constructor(options: { zip: ZipLike; mediaTypeByPath?: Map<string, string>; availablePaths?: string[] }) {
    this.zip = options.zip;
    this.mediaTypeByPath = options.mediaTypeByPath ?? new Map();
    const seed = options.availablePaths?.length ? options.availablePaths : Array.from(this.mediaTypeByPath.keys());
    for (const path of seed) this.registerCanonicalPath(path);
  }

  async readText(path: string): Promise<string> {
    const canonical = this.resolvePath(path);
    const bytes = await this.zip.read(canonical);
    return decodeText(bytes);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const canonical = this.resolvePath(path);
    const bytes = await this.zip.read(canonical);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
  }

  getMediaType(path: string): string {
    const canonical = this.resolvePath(path);
    return this.mediaTypeByPath.get(canonical) ?? guessMimeType(canonical);
  }

  async getObjectUrl(path: string): Promise<string> {
    const normalized = this.resolvePath(path);
    const existing = this.urlByPath.get(normalized);
    if (existing) return existing;
    const bytes = await this.zip.read(normalized);
    const mediaType = this.mediaTypeByPath.get(normalized) ?? guessMimeType(normalized);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy.buffer], { type: mediaType });
    const url = URL.createObjectURL(blob);
    this.urlByPath.set(normalized, url);
    return url;
  }

  hasPath(path: string): boolean {
    const normalized = normalizePath(stripQuery(path));
    if (!normalized) return false;
    const canonical = this.resolvePath(normalized);
    return this.canonicalPathByAlias.has(canonical) || this.canonicalPathByAlias.has(canonical.toLowerCase());
  }

  resolveEpubHref(options: { basePath: string; href: string }): ResolvedEpubHref | null {
    const rawHref = String(options.href ?? '').trim();
    if (!rawHref) return null;

    // Preserve in-document fragments like url(#filter) or href="#note-1".
    if (rawHref.startsWith('#')) return null;

    if (hasUrlScheme(rawHref)) return null;
    if (isAllowedInlineUrl(rawHref)) return null;

    const { path, fragment } = splitHref(rawHref);
    const normalizedPath = normalizePath(stripQuery(path));
    if (!normalizedPath) return null;

    const basePath = String(options.basePath ?? '').trim();
    const resolved = this.hasPath(normalizedPath) ? normalizedPath : resolveRelativePath(basePath, normalizedPath);
    const canonical = this.resolvePath(resolved);
    return { path: canonical, fragment };
  }

  revokeAll() {
    for (const url of this.urlByPath.values()) URL.revokeObjectURL(url);
    this.urlByPath.clear();
  }

  async rewriteCssUrls(cssText: string, cssPath: string, depth: number = 0): Promise<string> {
    if (depth > 5) return cssText;

    const importRegex = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^'")\s]+))(?:\s*\))?\s*;/gi;
    let css = cssText;
    const imports: Array<{ start: number; end: number; href: string }> = [];
    for (let match = importRegex.exec(cssText); match; match = importRegex.exec(cssText)) {
      const href = match[1] ?? match[2] ?? match[3];
      if (!href) continue;
      imports.push({ start: match.index, end: match.index + match[0].length, href });
    }
    if (imports.length) {
      let out = '';
      let last = 0;
      for (const imp of imports) {
        out += css.slice(last, imp.start);
        last = imp.end;
        const resolved = this.resolveEpubHref({ basePath: cssPath, href: imp.href });
        if (!resolved) continue;
        try {
          const importedCss = await this.readText(resolved.path);
          const processed = await this.rewriteCssUrls(importedCss, resolved.path, depth + 1);
          out += processed;
        } catch {
          // Ignore broken imports.
        }
      }
      out += css.slice(last);
      css = out;
    }

    const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    const matches: Array<{ start: number; end: number; rawUrl: string }> = [];
    for (let match = urlRegex.exec(css); match; match = urlRegex.exec(css)) {
      const rawUrl = match[2] ?? '';
      matches.push({ start: match.index, end: match.index + match[0].length, rawUrl });
    }
    if (!matches.length) return css;

    let out = '';
    let last = 0;
    for (const m of matches) {
      out += css.slice(last, m.start);
      last = m.end;
      const raw = m.rawUrl.trim();
      if (!raw || raw.startsWith('#') || isAllowedInlineUrl(raw) || hasUrlScheme(raw)) {
        if (hasUrlScheme(raw) && !isAllowedInlineUrl(raw)) {
          out += `url("")`;
        } else {
          out += `url(${raw})`;
        }
        continue;
      }

      const resolved = this.resolveEpubHref({ basePath: cssPath, href: raw });
      if (!resolved) {
        out += `url(${raw})`;
        continue;
      }
      try {
        const url = await this.getObjectUrl(resolved.path);
        out += resolved.fragment ? `url(${url}#${resolved.fragment})` : `url(${url})`;
      } catch {
        out += `url(${raw})`;
      }
    }
    out += css.slice(last);
    return out;
  }

  private registerCanonicalPath(path: string) {
    const canonical = normalizePath(path);
    if (!canonical) return;
    const addAliases = (alias: string) => {
      const normalized = normalizePath(alias);
      if (!normalized) return;
      this.canonicalPathByAlias.set(normalized, canonical);
      this.canonicalPathByAlias.set(normalized.toLowerCase(), canonical);
    };

    addAliases(canonical);
    addAliases(encodePathSegments(canonical));
    addAliases(decodePathSegments(canonical));
  }

  private resolvePath(path: string): string {
    const normalized = normalizePath(stripQuery(path));
    if (!normalized) return normalized;

    const direct = this.canonicalPathByAlias.get(normalized) ?? this.canonicalPathByAlias.get(normalized.toLowerCase());
    if (direct) return direct;

    const decoded = decodePathSegments(normalized);
    const decodedHit = this.canonicalPathByAlias.get(decoded) ?? this.canonicalPathByAlias.get(decoded.toLowerCase());
    if (decodedHit) return decodedHit;

    const encoded = encodePathSegments(normalized);
    const encodedHit = this.canonicalPathByAlias.get(encoded) ?? this.canonicalPathByAlias.get(encoded.toLowerCase());
    if (encodedHit) return encodedHit;

    return normalized;
  }
}

function decodePathSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join('/');
}
