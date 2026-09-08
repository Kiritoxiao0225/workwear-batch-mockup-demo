'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useProjectSession } from '@/components/project-session';

export function AppHeader() {
  const pathname = usePathname();
  const session = useProjectSession();
  return (
    <header className="app-header">
      <Link className="brand" href="/products" aria-label="工作服效果图首页">
        <span className="brand-mark" aria-hidden="true">衣</span>
        <span><strong>工作服效果图</strong><small>内部快速制作台</small></span>
      </Link>
      <div className="app-header-controls"><nav className="main-nav" aria-label="主导航">
        <Link className={pathname === '/products' ? 'active' : ''} href="/products">商品素材库</Link>
        <Link className={pathname === '/logo-studio' ? 'active' : ''} href="/logo-studio">Logo 智能处理</Link>
        <Link className={pathname === '/wps-production' ? 'active' : ''} href="/wps-production">批量效果图</Link>
        <Link className={pathname === '/workbench' ? 'active' : ''} href="/workbench">简单批量生图</Link>
      </nav>
      <div className="project-account">
        {!session.initialized ? <span>正在加载工作台…</span> : session.user && <span>{session.user.displayName}{session.localStorage ? ' · 本机存储' : ''}</span>}
        {session.error && <span role="alert">工作台：{session.error}<button className="button" type="button" disabled={session.busy} onClick={() => void session.refresh()}>重试</button></span>}
      </div></div>
    </header>
  );
}
