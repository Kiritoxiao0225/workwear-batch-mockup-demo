/**
 * Pages an administrator can grant or withhold. "我的账户" is always reachable and "管理后台"
 * follows the platform role, so neither is listed here.
 */
export const APP_PAGES = [
  { href: '/artwork-studio', label: '图稿生成' },
  { href: '/listing-images', label: '电商主图' },
] as const;

/** Where a signed-in visitor lands when no other page was asked for. */
export const HOME_PAGE: AppPage = '/artwork-studio';

export type AppPage = (typeof APP_PAGES)[number]['href'];

export const isAppPage = (value: string): value is AppPage => APP_PAGES.some(page => page.href === value);

/**
 * Pages an account may open. `allowed` is the stored list; null means "default", which is
 * every page. Administrators always see everything. Stored entries for retired pages are ignored.
 */
export function pagesFor(input: { role: string; internal: boolean; allowed: readonly string[] | null }): AppPage[] {
  const usable = APP_PAGES.map(page => page.href);
  if (input.role === 'admin' || input.allowed === null) return usable;
  return usable.filter(href => input.allowed!.includes(href));
}
