'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function AppHeader() {
  const pathname = usePathname();
  return (
    <header className="app-header">
      <Link className="brand" href="/products" aria-label="工作服效果图首页">
        <span className="brand-mark" aria-hidden="true">衣</span>
        <span><strong>工作服效果图</strong><small>内部快速制作台</small></span>
      </Link>
      <nav className="main-nav" aria-label="主导航">
        <Link className={pathname === '/products' ? 'active' : ''} href="/products">商品素材库</Link>
        <Link className={pathname === '/workbench' ? 'active' : ''} href="/workbench">批量效果图</Link>
      </nav>
    </header>
  );
}
