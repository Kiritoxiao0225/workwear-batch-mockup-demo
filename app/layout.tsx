import type { Metadata } from 'next';
import { ProjectSessionProvider } from '@/components/project-session';

import '@/app/globals.css';
import '@/components/app-header.css';

export const metadata: Metadata = {
  title: '工作服效果图 · 图稿与电商主图',
  description: '工作服 Logo 图稿生成与电商主图制作台',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body><ProjectSessionProvider>{children}</ProjectSessionProvider></body>
    </html>
  );
}
