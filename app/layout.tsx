import type { Metadata } from 'next';
import { ProjectSessionProvider } from '@/components/project-session';

import '@/app/foresee-fonts.css';
import '@/app/globals.css';
import '@/components/app-header.css';

export const metadata: Metadata = {
  title: '先见 Foresee · 图稿与电商主图',
  description: '先见 Foresee：Logo 图稿生成与电商主图制作台',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body><ProjectSessionProvider>{children}</ProjectSessionProvider></body>
    </html>
  );
}
