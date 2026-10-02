/**
 * Pages an administrator can grant or withhold. "我的账户" is always reachable and "管理后台"
 * follows the platform role, so neither is listed here.
 */
export const APP_PAGES = [
  { href: '/products', label: '商品素材库' },
  { href: '/artwork-studio', label: '图稿生成' },
  { href: '/garment-mockup', label: '成衣效果图' },
  { href: '/batch', label: '批量生成' },
  { href: '/wps-production', label: 'WPS 批量生成' },
  { href: '/listing-images', label: '电商主图' },
] as const;

export type AppPage = (typeof APP_PAGES)[number]['href'];

export const isAppPage = (value: string): value is AppPage => APP_PAGES.some(page => page.href === value);

// WPS writes the customer's real table, so only the internal workspace ever gets it.
const INTERNAL_ONLY: readonly AppPage[] = ['/wps-production'];

/**
 * Pages an account may open. `allowed` is the stored list; null means "default", which is
 * every page except the internal-only ones. Administrators always see everything they could use.
 */
export function pagesFor(input: { role: string; internal: boolean; allowed: readonly string[] | null }): AppPage[] {
  const usable = APP_PAGES.map(page => page.href).filter(href => input.internal || !INTERNAL_ONLY.includes(href));
  if (input.role === 'admin' || input.allowed === null) return usable;
  return usable.filter(href => input.allowed!.includes(href));
}
