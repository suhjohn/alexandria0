export function ensureReaderContainers(doc: Document): {
  viewportEl: HTMLElement;
  contentEl: HTMLElement;
  created: boolean;
} {
  const existingViewport = doc.getElementById('mfv2-viewport') as HTMLElement | null;
  const existingContent = doc.getElementById('mfv2-book-content') as HTMLElement | null;
  if (existingViewport && existingContent) {
    return { viewportEl: existingViewport, contentEl: existingContent, created: false };
  }

  const body = doc.body ?? doc.getElementsByTagName('body')[0] ?? doc.documentElement;

  let created = false;
  const viewportEl = existingViewport ?? (() => {
    created = true;
    const el = doc.createElement('div');
    el.id = 'mfv2-viewport';
    return el;
  })();

  const contentEl = existingContent ?? (() => {
    created = true;
    const el = doc.createElement('div');
    el.id = 'mfv2-book-content';
    return el;
  })();

  if (existingViewport && !existingContent) {
    while (viewportEl.firstChild) contentEl.appendChild(viewportEl.firstChild);
  }

  if (contentEl.parentNode !== viewportEl) viewportEl.appendChild(contentEl);
  if (viewportEl.parentNode !== body) body.appendChild(viewportEl);

  // Move any stray siblings of the viewport into the content container.
  for (const child of Array.from(body.childNodes)) {
    if (child === viewportEl) continue;
    contentEl.appendChild(child);
  }

  return { viewportEl, contentEl, created };
}
