import { hasUrlScheme } from '../utils/path';
import { isAllowedInlineUrl, isEpubCfiHref } from '../utils/url';
import { EpubResourceStore } from './resources';
import { ensureReaderContainers } from './containers';

const BASE_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "img-src blob: data:",
  "style-src 'unsafe-inline' blob:",
  "font-src blob: data:",
  "media-src blob: data:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const BASE_STYLE = `
:root {
  --mfv2-vw: 600px;
  --mfv2-vh: 800px;
  --mfv2-gap: 24px;
  --mfv2-bg: #ffffff;
  --mfv2-fg: #111111;
  --mfv2-link: #0b57d0;
  --mfv2-font-scale: 1;
  --mfv2-line-height: 1.5;
  --mfv2-font-family: inherit;
  --mfv2-text-align: initial;
}

html, body {
  margin: 0;
  padding: 0;
  width: var(--mfv2-vw);
  height: var(--mfv2-vh);
  background: var(--mfv2-bg);
  color: var(--mfv2-fg);
  overflow: hidden;
}

body {
  -webkit-text-size-adjust: 100%;
  font-size: calc(100% * var(--mfv2-font-scale));
  line-height: var(--mfv2-line-height);
  font-family: var(--mfv2-font-family);
  text-align: var(--mfv2-text-align);
}

a[href] { color: var(--mfv2-link); text-decoration: none; }
a[href]:hover { color: var(--mfv2-link); opacity: 0.8; }
a[href]:focus { outline: none; }
a:not([href]) { color: inherit; text-decoration: inherit; }
*:focus { outline: none; }
*:focus-visible { outline: none; }

#mfv2-viewport {
  width: var(--mfv2-vw);
  height: var(--mfv2-vh);
  overflow: hidden;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

#mfv2-book-content {
  height: var(--mfv2-vh);
  column-width: var(--mfv2-vw);
  column-gap: var(--mfv2-gap);
  column-fill: auto;
}

img, svg, video, canvas {
  max-width: 100% !important;
  max-height: var(--mfv2-vh) !important;
  height: auto !important;
  object-fit: contain !important;
}

/* Full-page images (covers, illustrations) */
body > img:only-child,
#mfv2-book-content > img:only-child,
figure > img:only-child,
.image-page img,
[epub\\:type="cover"] img,
img.cover {
  display: block;
  width: auto !important;
  max-width: 100% !important;
  max-height: calc(var(--mfv2-vh) - 24px) !important;
  margin: 0 auto;
  object-fit: contain !important;
}
`;

function removeDangerousNodes(doc: Document) {
  doc.querySelectorAll('script, iframe, object, embed').forEach((el) => el.remove());
  doc.querySelectorAll('base').forEach((el) => el.remove());
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name);
    }
  }
}

function sanitizeAnchor(el: Element) {
  if (!(el instanceof HTMLAnchorElement)) return;
  const href = (el.getAttribute('href') ?? '').trim();
  if (!href) return;
  if (hasUrlScheme(href) && !isEpubCfiHref(href)) {
    el.setAttribute('href', '#');
    el.setAttribute('data-mf-blocked-href', href);
  }
}

async function resolveObjectUrl(options: {
  basePath: string;
  href: string;
  store: EpubResourceStore;
}): Promise<{ url: string; epubPath: string } | null> {
  const resolved = options.store.resolveEpubHref({
    basePath: options.basePath,
    href: options.href,
  });
  if (!resolved) return null;
  try {
    const blobUrl = await options.store.getObjectUrl(resolved.path);
    return {
      url: resolved.fragment ? `${blobUrl}#${resolved.fragment}` : blobUrl,
      epubPath: resolved.path,
    };
  } catch {
    return null;
  }
}

async function rewriteSrcset(docPath: string, rawSrcset: string, store: EpubResourceStore): Promise<string> {
  const parts = rawSrcset
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const [urlPart, descriptor] = part.split(/\s+/, 2);
    if (!urlPart) continue;
    if (hasUrlScheme(urlPart)) {
      if (isAllowedInlineUrl(urlPart)) out.push(descriptor ? `${urlPart} ${descriptor}` : urlPart);
      continue;
    }
    if (isAllowedInlineUrl(urlPart)) {
      out.push(descriptor ? `${urlPart} ${descriptor}` : urlPart);
      continue;
    }
    const rewritten = await resolveObjectUrl({ basePath: docPath, href: urlPart, store });
    if (!rewritten) continue;
    out.push(descriptor ? `${rewritten.url} ${descriptor}` : rewritten.url);
  }
  return out.join(', ');
}

export async function buildSpineItemSrcDoc(options: {
  spineItemPath: string;
  xhtmlText: string;
  resourceStore: EpubResourceStore;
}): Promise<string> {
  const { spineItemPath, xhtmlText, resourceStore } = options;

  const doc = new DOMParser().parseFromString(xhtmlText, 'text/html');
  removeDangerousNodes(doc);

  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
    const rawHref = link.getAttribute('href') ?? '';
    const resolved = resourceStore.resolveEpubHref({ basePath: spineItemPath, href: rawHref });
    if (!resolved) {
      link.remove();
      continue;
    }
    const resolvedCssPath = resolved.path;
    try {
      const cssText = await resourceStore.readText(resolvedCssPath);
      const rewritten = await resourceStore.rewriteCssUrls(cssText, resolvedCssPath);
      const styleEl = doc.createElement('style');
      styleEl.setAttribute('data-epub-href', resolvedCssPath);
      styleEl.textContent = rewritten;
      link.replaceWith(styleEl);
    } catch {
      link.remove();
    }
  }

  // Strip other <link href="..."> entries (icons, preloads, etc.) to avoid
  // leaking network requests from srcdoc. We inline stylesheets above.
  for (const link of Array.from(doc.querySelectorAll('link[href]'))) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    if (rel.split(/\s+/).includes('stylesheet')) continue;
    link.remove();
  }

  for (const style of Array.from(doc.querySelectorAll('style'))) {
    const css = style.textContent ?? '';
    try {
      style.textContent = await resourceStore.rewriteCssUrls(css, spineItemPath);
    } catch {
      // Ignore.
    }
  }

  // Rewrite inline style URLs (e.g. background-image: url(...)).
  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    const rawStyle = el.getAttribute('style') ?? '';
    if (!rawStyle || !/url\(/i.test(rawStyle)) continue;
    try {
      const rewritten = await resourceStore.rewriteCssUrls(rawStyle, spineItemPath);
      el.setAttribute('style', rewritten);
    } catch {
      // Ignore.
    }
  }

  for (const a of Array.from(doc.querySelectorAll('a[href]'))) sanitizeAnchor(a);

  const mediaSrcSelectors = ['img[src]', 'audio[src]', 'video[src]', 'source[src]', 'track[src]', '[poster]'];
  for (const el of Array.from(doc.querySelectorAll(mediaSrcSelectors.join(',')))) {
    const attr = el.hasAttribute('poster') ? 'poster' : 'src';
    const raw = (el.getAttribute(attr) ?? '').trim();
    if (!raw) continue;
    if (hasUrlScheme(raw)) {
      if (!isAllowedInlineUrl(raw)) el.removeAttribute(attr);
      continue;
    }
    if (isAllowedInlineUrl(raw)) continue;
    const resolved = await resolveObjectUrl({
      basePath: spineItemPath,
      href: raw,
      store: resourceStore,
    });
    if (!resolved) {
      el.removeAttribute(attr);
      continue;
    }
    if (el instanceof HTMLImageElement) {
      el.setAttribute('data-mfv2-epub-src', resolved.epubPath);
    }
    el.setAttribute(attr, resolved.url);

    if (el instanceof HTMLImageElement) {
      el.loading = 'eager';
      el.decoding = 'sync';
    }
  }

  for (const el of Array.from(doc.querySelectorAll('img[srcset], source[srcset]'))) {
    const srcset = el.getAttribute('srcset') ?? '';
    if (!srcset) continue;
    try {
      const rewritten = await rewriteSrcset(spineItemPath, srcset, resourceStore);
      if (rewritten) el.setAttribute('srcset', rewritten);
      else el.removeAttribute('srcset');
    } catch {
      // Ignore.
    }
  }

  for (const image of Array.from(doc.querySelectorAll('image[href], image[xlink\\:href]'))) {
    const attr = image.getAttribute('href') ? 'href' : 'xlink:href';
    const raw = (image.getAttribute(attr) ?? '').trim();
    if (!raw) continue;
    if (hasUrlScheme(raw)) {
      if (!isAllowedInlineUrl(raw)) image.removeAttribute(attr);
      continue;
    }
    if (isAllowedInlineUrl(raw)) continue;
    const resolved = await resolveObjectUrl({
      basePath: spineItemPath,
      href: raw,
      store: resourceStore,
    });
    if (!resolved) {
      image.removeAttribute(attr);
      continue;
    }
    image.setAttribute(attr, resolved.url);
  }

  const head = doc.head ?? doc.getElementsByTagName('head')[0] ?? doc.documentElement;
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = BASE_CSP;
  head.prepend(csp);

  if (!head.querySelector('meta[charset]')) {
    const charset = doc.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    head.prepend(charset);
  }

  const baseStyleEl = doc.createElement('style');
  baseStyleEl.id = 'mfv2-reader-base';
  baseStyleEl.textContent = BASE_STYLE;
  head.appendChild(baseStyleEl);

  ensureReaderContainers(doc);

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
