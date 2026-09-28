/** Only an explicit authentication failure should leave the current workspace. */
export function expiredSessionDestination(status: number, currentPath: string): string | null {
  if (status !== 401 || /^\/login(?:[/?#]|$)/u.test(currentPath)) return null;
  const next = /^\/(?!\/)[^\\\s]*$/u.test(currentPath) ? currentPath : '/products';
  return `/login?reason=session-expired&next=${encodeURIComponent(next)}`;
}
