export function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

export function hasUrlScheme(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(String(href ?? ''));
}

export function stripQuery(path: string): string {
  const idx = path.indexOf('?');
  return idx === -1 ? path : path.slice(0, idx);
}

export function splitHref(href: string): { path: string; fragment?: string } {
  const hashIndex = href.indexOf('#');
  if (hashIndex === -1) return { path: href };
  const path = href.slice(0, hashIndex);
  const fragment = href.slice(hashIndex + 1) || undefined;
  return { path, fragment };
}

export function resolveRelativePath(basePath: string, relativeHref: string): string {
  if (relativeHref.trim() === '') return normalizePath(basePath);
  if (hasUrlScheme(relativeHref)) return relativeHref;
  if (relativeHref.startsWith('/')) return normalizePath(relativeHref);
  const baseDir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : '';
  return normalizePath(`${baseDir}${relativeHref}`);
}
