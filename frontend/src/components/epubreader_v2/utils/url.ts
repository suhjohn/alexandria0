export function isAllowedInlineUrl(url: string): boolean {
  const trimmed = String(url ?? '').trim().toLowerCase();
  return trimmed.startsWith('data:') || trimmed.startsWith('blob:');
}

export function isEpubCfiHref(href: string): boolean {
  const trimmed = String(href ?? '').trim().toLowerCase();
  return trimmed.startsWith('epubcfi(') || trimmed.startsWith('epubcfi:');
}
