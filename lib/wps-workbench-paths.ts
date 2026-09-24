const paths = [
  ['/api/catalog/files/', '/api/wps-workbench/catalog-files/'],
  ['/api/production-files/', '/api/wps-workbench/production-files/'],
  ['/api/batch/', '/api/wps-workbench/'],
] as const;

/** Rebase asset URLs, never customer prose or inline image bytes. */
export function wpsWorkbenchPaths<T>(value: T, reverse = false): T {
  if (typeof value === 'string') {
    for (const pair of paths) {
      const [from, to] = reverse ? [pair[1], pair[0]] : pair;
      if (value.startsWith(from)) return (to + value.slice(from.length)) as T;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => wpsWorkbenchPaths(item, reverse)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wpsWorkbenchPaths(item, reverse)])) as T;
  }
  return value;
}

export function wpsWorkbenchSource(source: string) {
  return paths.reduce((text, [from, to]) => text.replaceAll(from, to), source);
}
